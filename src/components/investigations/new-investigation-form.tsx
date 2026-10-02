'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FlaskConical, Plus, Radio, Trash2, Wand2, XCircle } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { api, ApiClientError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { detectTargetType, normalizeTarget } from '@/shared/targets';
import { DEPTHS, DEPTH_DESCRIPTIONS, DEPTH_MODULES, MODULES, MODULE_LABELS, TARGET_TYPES, TARGET_TYPE_LABELS, type Depth, type ModuleId, type TargetType } from '@/shared/domain';
import type { UserPreferences } from '@/shared/preferences';

interface ProviderInfo {
  id: string;
  name: string;
  kind: string;
  category: string;
  usable: boolean;
  userEnabled: boolean;
  operations: Array<{ id: string; label: string; targetTypes: string[]; module: string; minDepth: string }>;
  status: { missing: string[] };
}

interface Row {
  key: number;
  type: TargetType;
  value: string;
  touched: boolean;
}

const DEPTH_RANK: Record<string, number> = { quick: 0, standard: 1, deep: 2 };
let rowKey = 1;

export function NewInvestigationForm({ prefs }: { prefs: UserPreferences }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState('');
  const [mode, setMode] = useState<'live' | 'demo'>(prefs.defaultMode);
  const [depth, setDepth] = useState<Depth>(prefs.defaultDepth);
  const [modules, setModules] = useState<ModuleId[]>(prefs.defaultModules.length ? prefs.defaultModules : DEPTH_MODULES.standard);
  const [selectedProviders, setSelectedProviders] = useState<string[]>([]);
  const [country, setCountry] = useState(prefs.defaultCountry ?? '');
  const [rows, setRows] = useState<Row[]>([{ key: rowKey++, type: 'username', value: '', touched: false }]);
  const [bulk, setBulk] = useState('');
  const [submitting, setSubmitting] = useState<'draft' | 'start' | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const providersQ = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ items: ProviderInfo[] }>('/api/providers') });

  const validated = rows.map((r) => ({ ...r, result: r.value.trim() ? normalizeTarget(r.type, r.value, { defaultCountry: country || undefined }) : null }));
  const validTargets = validated.filter((r) => r.result?.ok);
  const invalid = validated.filter((r) => r.result && !r.result.ok);
  const effectiveModules = depth === 'custom' ? modules : DEPTH_MODULES[depth];

  /** Which providers would run, and which are unavailable — computed from the provider registry. */
  const plan = (() => {
    const providers = providersQ.data?.items ?? [];
    const types = new Set(validTargets.map((t) => t.type));
    for (const t of validTargets) {
      if (t.type === 'url' || t.type === 'document' || t.type === 'image') types.add('domain');
      if (t.type === 'email' && depth === 'deep') types.add('domain');
    }
    const run: ProviderInfo[] = [];
    const unavailable: ProviderInfo[] = [];
    for (const p of providers) {
      if (p.category === 'image' || p.category === 'documents') continue;
      const allowed = p.kind === 'local' || (mode === 'demo' ? p.kind === 'simulated' : p.kind === 'live');
      if (!allowed) continue;
      if (depth === 'custom' && selectedProviders.length && !selectedProviders.includes(p.id)) continue;
      const eligible = p.operations.some(
        (op) => op.targetTypes.some((t) => types.has(t as TargetType)) && effectiveModules.includes(op.module as ModuleId) && (depth === 'custom' || DEPTH_RANK[depth]! >= DEPTH_RANK[op.minDepth]!),
      );
      if (!eligible) continue;
      if (p.usable && p.userEnabled) run.push(p);
      else unavailable.push(p);
    }
    return { run, unavailable };
  })();

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function addBulk() {
    const lines = bulk.split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
    if (!lines.length) return;
    setRows((rs) => [...rs.filter((r) => r.value.trim()), ...lines.map((v) => ({ key: rowKey++, type: detectTargetType(v) ?? 'keyword', value: v, touched: true }))]);
    setBulk('');
  }

  async function submit(start: boolean) {
    setServerError(null);
    setRows((rs) => rs.map((r) => ({ ...r, touched: true })));
    if (name.trim().length < 2) {
      setServerError('Give the investigation a name (at least 2 characters).');
      return;
    }
    if (invalid.length) {
      setServerError('Fix the invalid targets before continuing.');
      return;
    }
    if (start && !validTargets.length) {
      setServerError('Add at least one valid target to start collection.');
      return;
    }
    if (depth === 'custom' && !modules.length) {
      setServerError('Custom depth needs at least one module.');
      return;
    }
    setSubmitting(start ? 'start' : 'draft');
    try {
      const res = await api.post<{ investigation: { id: string } }>('/api/investigations', {
        name: name.trim(),
        description: description.trim() || undefined,
        scopeStatement: scope.trim() || undefined,
        depth,
        mode,
        modules: depth === 'custom' ? modules : [],
        providers: depth === 'custom' ? selectedProviders : [],
        targets: validTargets.map((t) => ({ type: t.type, value: t.value.trim() })),
        defaultCountry: country || undefined,
        start,
      });
      toast({ tone: 'success', title: start ? 'Collection started' : 'Investigation saved as draft' });
      router.push(`/investigations/${res.investigation.id}`);
    } catch (e) {
      const err = e as ApiClientError;
      const details = Array.isArray(err.details) ? (err.details as Array<{ value?: string; error?: string; message?: string; path?: string }>).map((d) => `${d.value ?? d.path ?? ''}: ${d.error ?? d.message ?? ''}`).join(' · ') : '';
      setServerError(`${err.message}${details ? ` ${details}` : ''}`);
      setSubmitting(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New investigation</h1>
        <p className="text-sm text-muted">Define identifiers, choose depth and sources, then start collection. Nothing is collected until you start.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Case details" />
            <CardBody className="space-y-4">
              <Field label="Investigation name" htmlFor="inv-name">
                <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Phishing infrastructure review — Q4" maxLength={160} />
              </Field>
              <Field label="Description" htmlFor="inv-desc" hint="Optional. Internal context for analysts.">
                <Textarea id="inv-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={4000} />
              </Field>
              <Field label="Scope statement" htmlFor="inv-scope" hint="Optional. Authorisation, purpose and boundaries (e.g. “Authorised brand-protection review for Example Ltd, public sources only”).">
                <Textarea id="inv-scope" value={scope} onChange={(e) => setScope(e.target.value)} rows={2} maxLength={4000} />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Collection mode" />
            <CardBody className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  { id: 'live', icon: Radio, title: 'Live sources', text: 'Queries configured public-data providers. Coverage depends on API keys, quotas and network access.' },
                  { id: 'demo', icon: FlaskConical, title: 'Demo (simulated)', text: 'Runs simulated providers with fictional data. Works offline. Results are clearly labelled SIMULATED.' },
                ] as const
              ).map((m) => (
                <label key={m.id} className={cn('flex cursor-pointer gap-3 rounded-lg border p-3.5 transition-colors', mode === m.id ? 'border-accent bg-accent-soft/50' : 'border-border hover:border-border-strong')}>
                  <input type="radio" name="mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} className="mt-1 accent-[var(--accent)]" />
                  <span>
                    <span className="flex items-center gap-2 text-sm font-medium text-fg">
                      <m.icon className="h-4 w-4" /> {m.title}
                    </span>
                    <span className="mt-1 block text-xs text-muted">{m.text}</span>
                  </span>
                </label>
              ))}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Targets" description="One identifier per row. Types are suggested automatically; confirm them." />
            <CardBody className="space-y-3">
              {validated.map((r, idx) => (
                <div key={r.key} className="space-y-1">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Select aria-label={`Target ${idx + 1} type`} value={r.type} onChange={(e) => update(r.key, { type: e.target.value as TargetType })} className="sm:w-56">
                      {TARGET_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {TARGET_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </Select>
                    <div className="flex flex-1 gap-2">
                      <Input
                        aria-label={`Target ${idx + 1} value`}
                        aria-invalid={Boolean(r.touched && r.result && !r.result.ok)}
                        value={r.value}
                        onChange={(e) => update(r.key, { value: e.target.value })}
                        onBlur={() => {
                          const detected = r.value.trim() && !r.touched ? detectTargetType(r.value) : null;
                          update(r.key, { touched: true, ...(detected ? { type: detected } : {}) });
                        }}
                        placeholder="e.g. j.doe@example.org, example.org, 198.51.100.23, @handle"
                        className={cn('font-mono text-[13px]', r.touched && r.result && !r.result.ok && 'border-danger')}
                      />
                      <Button size="icon" variant="ghost" aria-label="Detect type" title="Detect type" onClick={() => r.value && update(r.key, { type: detectTargetType(r.value) ?? r.type, touched: true })}>
                        <Wand2 className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" aria-label={`Remove target ${idx + 1}`} onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [{ key: rowKey++, type: 'username', value: '', touched: false }]))}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  {r.touched && r.result ? (
                    r.result.ok ? (
                      <p className="flex items-center gap-1.5 text-xs text-muted">
                        <CheckCircle2 className="h-3.5 w-3.5 text-success" /> Normalised: <span className="font-mono text-fg">{r.result.normalized}</span>
                        {typeof r.result.metadata.platform === 'string' ? <Badge>{r.result.metadata.platform}</Badge> : null}
                        {r.result.metadata.isPublic === false ? <Badge tone="warning">Non-public address</Badge> : null}
                      </p>
                    ) : (
                      <p className="flex items-center gap-1.5 text-xs text-danger" role="alert">
                        <XCircle className="h-3.5 w-3.5" /> {r.result.error}
                      </p>
                    )
                  ) : null}
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setRows((rs) => [...rs, { key: rowKey++, type: 'domain', value: '', touched: false }])} disabled={rows.length >= 50}>
                  <Plus className="h-3.5 w-3.5" /> Add target
                </Button>
              </div>
              <details className="rounded-lg border border-border bg-surface-2/50 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium text-muted">Paste multiple identifiers</summary>
                <div className="mt-2 space-y-2">
                  <Textarea value={bulk} onChange={(e) => setBulk(e.target.value)} rows={3} placeholder="One per line, or comma-separated" aria-label="Paste identifiers" className="font-mono text-[13px]" />
                  <Button size="sm" onClick={addBulk}>
                    Add and detect types
                  </Button>
                </div>
              </details>
              <Field label="Default country for phone numbers" htmlFor="inv-country" hint="Optional ISO code (e.g. GB, US) used when numbers lack an international prefix.">
                <Input id="inv-country" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} className="w-24 font-mono uppercase" placeholder="—" />
              </Field>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Depth" />
            <CardBody className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" role="radiogroup" aria-label="Investigation depth">
                {DEPTHS.map((d) => (
                  <label key={d} className={cn('flex cursor-pointer flex-col rounded-lg border p-3 transition-colors', depth === d ? 'border-accent bg-accent-soft/50' : 'border-border hover:border-border-strong')}>
                    <span className="flex items-center gap-2 text-sm font-medium capitalize">
                      <input type="radio" name="depth" value={d} checked={depth === d} onChange={() => setDepth(d)} className="accent-[var(--accent)]" />
                      {d}
                    </span>
                    <span className="mt-1 text-xs text-muted">{DEPTH_DESCRIPTIONS[d]}</span>
                  </label>
                ))}
              </div>
              {depth === 'custom' ? (
                <div className="space-y-4">
                  <div>
                    <p className="mb-2 text-xs font-medium">Modules</p>
                    <div className="grid gap-1 sm:grid-cols-2">
                      {MODULES.map((m) => (
                        <Checkbox
                          key={m}
                          label={MODULE_LABELS[m].label}
                          description={MODULE_LABELS[m].description}
                          checked={modules.includes(m)}
                          onChange={(e) => setModules((ms) => (e.target.checked ? [...ms, m] : ms.filter((x) => x !== m)))}
                        />
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium">Providers</p>
                    <p className="mb-2 text-xs text-muted">Leave all unchecked to use every eligible configured provider.</p>
                    <div className="grid max-h-64 gap-1 overflow-y-auto rounded-lg border border-border p-2 sm:grid-cols-2">
                      {(providersQ.data?.items ?? [])
                        .filter((p) => p.kind === 'local' || (mode === 'demo' ? p.kind === 'simulated' : p.kind === 'live'))
                        .map((p) => (
                          <Checkbox
                            key={p.id}
                            label={p.name}
                            description={p.usable ? (p.userEnabled ? p.kind : 'Disabled in settings') : `Not configured (${p.status.missing.join(', ')})`}
                            disabled={!p.usable}
                            checked={selectedProviders.includes(p.id)}
                            onChange={(e) => setSelectedProviders((ps) => (e.target.checked ? [...ps, p.id] : ps.filter((x) => x !== p.id)))}
                          />
                        ))}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {DEPTH_MODULES[depth].map((m) => (
                    <Badge key={m}>{MODULE_LABELS[m].label}</Badge>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader title="Collection plan" description="Computed from your targets, depth and provider configuration." />
            <CardBody className="space-y-3 text-sm">
              <p className="text-xs text-muted">
                {validTargets.length} valid target{validTargets.length === 1 ? '' : 's'}
                {invalid.length ? <span className="text-danger"> · {invalid.length} invalid</span> : null}
              </p>
              <div>
                <p className="mb-1.5 text-xs font-medium text-fg">Will query ({plan.run.length})</p>
                {plan.run.length ? (
                  <ul className="space-y-1">
                    {plan.run.map((p) => (
                      <li key={p.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate">{p.name}</span>
                        <Badge tone={p.kind === 'simulated' ? 'simulated' : p.kind === 'local' ? 'neutral' : 'accent'}>{p.kind}</Badge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">{validTargets.length ? 'No eligible providers. Try another depth, module set, or demo mode.' : 'Add a target to see the plan.'}</p>
                )}
              </div>
              {plan.unavailable.length ? (
                <div>
                  <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" /> Unavailable ({plan.unavailable.length})
                  </p>
                  <ul className="space-y-1 text-xs text-muted">
                    {plan.unavailable.map((p) => (
                      <li key={p.id} className="flex justify-between gap-2">
                        <span className="truncate">{p.name}</span>
                        <span className="shrink-0">{p.userEnabled ? 'not configured' : 'disabled'}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] text-subtle">Unavailable sources are recorded as skipped so the coverage gap is visible in results and reports.</p>
                </div>
              ) : null}
            </CardBody>
          </Card>
          {serverError ? (
            <p role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
              {serverError}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="lg" loading={submitting === 'start'} disabled={Boolean(submitting)} onClick={() => void submit(true)} data-testid="create-and-start">
              Create and start collection
            </Button>
            <Button size="lg" loading={submitting === 'draft'} disabled={Boolean(submitting)} onClick={() => void submit(false)}>
              Save as draft
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
}
