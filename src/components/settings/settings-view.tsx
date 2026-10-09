'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, BookOpen, CheckCircle2, CircleSlash, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { applyDensity, applyTheme } from '@/components/layout/theme-toggle';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, relativeTime, titleCase } from '@/lib/format';
import { DEPTHS, MODULES, MODULE_LABELS, type ModuleId } from '@/shared/domain';
import type { UserPreferences } from '@/shared/preferences';

interface SettingsData {
  user: { id: string; email: string; name: string; role: string; preferences: UserPreferences; createdAt: string; lastLoginAt: string | null };
  system: {
    database: string;
    worker: string;
    ocr: boolean;
    maxUploadMb: number;
    targetFetch: boolean;
    mapTiles: boolean;
    secrets: Record<string, boolean>;
    ai: { configured: boolean; provider: string; model: string };
    defaultRetentionDays: number;
  };
}

interface ProviderRow {
  id: string;
  name: string;
  category: string;
  kind: string;
  description: string;
  homepage: string | null;
  docsUrl: string | null;
  reliability: string;
  requires: Array<{ env: string; label: string; optional: boolean; present: boolean }>;
  status: { configured: boolean; missing: string[]; envEnabled: boolean; disabledByAdmin: boolean };
  limitations: string[];
  rateLimit: { concurrency: number; minIntervalMs: number } | null;
  hasHealthCheck: boolean;
  usable: boolean;
  userEnabled: boolean;
  health: { status: string; message: string | null; latencyMs: number | null; checkedAt: string } | null;
  operations: Array<{ label: string }>;
}

const SECTIONS = [
  ['account', 'Account'],
  ['appearance', 'Appearance'],
  ['defaults', 'Investigation defaults'],
  ['providers', 'Search providers'],
  ['api', 'API configuration'],
  ['ai', 'AI configuration'],
  ['retention', 'Data retention'],
  ['security', 'Security'],
  ['export', 'Export settings'],
] as const;

function usePrefs(initial: SettingsData) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsData>('/api/settings'), initialData: initial });
  async function save(patch: { name?: string; preferences?: Partial<UserPreferences> }, message = 'Settings saved') {
    try {
      await api.patch('/api/settings', patch);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      toast({ tone: 'success', title: message });
    } catch (e) {
      toast({ tone: 'error', title: 'Not saved', description: (e as Error).message });
    }
  }
  return { data: q.data!, save };
}

function Account({ data, save }: ReturnType<typeof usePrefs>) {
  const [name, setName] = useState(data.user.name);
  return (
    <Card>
      <CardHeader title="Account" />
      <CardBody className="space-y-4">
        <Field label="Display name" htmlFor="acct-name">
          <Input id="acct-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className="max-w-sm" />
        </Field>
        <dl className="grid max-w-md grid-cols-[120px_1fr] gap-y-1 text-sm">
          <dt className="text-muted">Email</dt>
          <dd>{data.user.email}</dd>
          <dt className="text-muted">Role</dt>
          <dd>{titleCase(data.user.role)}</dd>
          <dt className="text-muted">Member since</dt>
          <dd>{formatDate(data.user.createdAt)}</dd>
          <dt className="text-muted">Last sign-in</dt>
          <dd>{formatDate(data.user.lastLoginAt, { time: true })}</dd>
        </dl>
        <Button variant="primary" size="sm" disabled={name.trim() === data.user.name || !name.trim()} onClick={() => void save({ name: name.trim() })}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}

function Appearance({ data, save }: ReturnType<typeof usePrefs>) {
  const p = data.user.preferences;
  return (
    <Card>
      <CardHeader title="Appearance" />
      <CardBody className="grid gap-4 sm:grid-cols-2">
        <Field label="Theme" htmlFor="pref-theme">
          <Select
            id="pref-theme"
            value={p.theme}
            onChange={(e) => {
              const theme = e.target.value as UserPreferences['theme'];
              applyTheme(theme);
              void save({ preferences: { theme } }, 'Theme updated');
            }}
          >
            <option value="system">Match system</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </Select>
        </Field>
        <Field label="Density" htmlFor="pref-density" hint="Compact rows fit more data on large monitors.">
          <Select
            id="pref-density"
            value={p.density}
            onChange={(e) => {
              const density = e.target.value as UserPreferences['density'];
              applyDensity(density);
              void save({ preferences: { density } }, 'Density updated');
            }}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </Select>
        </Field>
      </CardBody>
    </Card>
  );
}

function Defaults({ data, save }: ReturnType<typeof usePrefs>) {
  const p = data.user.preferences;
  const [modules, setModules] = useState<ModuleId[]>(p.defaultModules);
  return (
    <Card>
      <CardHeader title="Investigation defaults" description="Pre-filled when you create an investigation." />
      <CardBody className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Default depth" htmlFor="pref-depth">
            <Select id="pref-depth" value={p.defaultDepth} onChange={(e) => void save({ preferences: { defaultDepth: e.target.value as UserPreferences['defaultDepth'] } })}>
              {DEPTHS.map((d) => (
                <option key={d} value={d}>
                  {titleCase(d)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default mode" htmlFor="pref-mode">
            <Select id="pref-mode" value={p.defaultMode} onChange={(e) => void save({ preferences: { defaultMode: e.target.value as 'live' | 'demo' } })}>
              <option value="live">Live sources</option>
              <option value="demo">Demo (simulated)</option>
            </Select>
          </Field>
          <Field label="Default phone country" htmlFor="pref-country" hint="ISO code, e.g. GB">
            <Input id="pref-country" defaultValue={p.defaultCountry ?? ''} maxLength={2} className="w-24 uppercase" onBlur={(e) => { const v = e.target.value.trim().toUpperCase(); if (v === (p.defaultCountry ?? '')) return; if (v && !/^[A-Z]{2}$/.test(v)) return; void save({ preferences: { defaultCountry: v || null } }); }} />
          </Field>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">Default modules for Custom depth</p>
          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((m) => (
              <Checkbox key={m} label={MODULE_LABELS[m].label} checked={modules.includes(m)} onChange={(e) => setModules((ms) => (e.target.checked ? [...ms, m] : ms.filter((x) => x !== m)))} />
            ))}
          </div>
          <Button size="sm" className="mt-2" onClick={() => void save({ preferences: { defaultModules: modules } })}>
            Save modules
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function HealthDot({ status }: { status: string | undefined }) {
  const cls = status === 'healthy' ? 'bg-success' : status === 'degraded' ? 'bg-warning' : status === 'unavailable' ? 'bg-danger' : 'bg-subtle';
  return <span className={cn('inline-block h-2 w-2 rounded-full', cls)} aria-hidden />;
}

function Providers() {
  const qc = useQueryClient();
  const toast = useToast();
  const [checking, setChecking] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'live' | 'local' | 'simulated'>('all');
  const q = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ items: ProviderRow[] }>('/api/providers') });
  async function toggle(p: ProviderRow, enabled: boolean) {
    try {
      await api.patch(`/api/providers/${p.id}`, { enabled });
      await qc.invalidateQueries({ queryKey: ['providers'] });
    } catch (e) {
      toast({ tone: 'error', title: 'Not saved', description: (e as Error).message });
    }
  }
  async function check(p: ProviderRow) {
    setChecking(p.id);
    try {
      const r = await api.post<{ status: string; message: string; latencyMs: number | null }>(`/api/providers/${p.id}/health`);
      toast({ tone: r.status === 'healthy' ? 'success' : r.status === 'unknown' ? 'info' : 'error', title: `${p.name}: ${r.status}`, description: r.message });
      await qc.invalidateQueries({ queryKey: ['providers'] });
    } finally {
      setChecking(null);
    }
  }
  const items = (q.data?.items ?? []).filter((p) => filter === 'all' || p.kind === filter);
  const categories = [...new Set(items.map((p) => p.category))];
  return (
    <div className="space-y-4" data-testid="providers-settings">
      <Card>
        <CardBody className="space-y-2 text-sm text-muted">
          <p>
            Provider credentials are read from server environment variables only (see <code className="font-mono">.env.example</code>) and are never sent to the browser. A provider shows as <span className="text-fg">configured</span> when its required variables are present; you can still disable it for your own investigations.
          </p>
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Provider kind filter">
            {(['all', 'live', 'local', 'simulated'] as const).map((k) => (
              <Button key={k} size="sm" variant={filter === k ? 'secondary' : 'ghost'} onClick={() => setFilter(k)} aria-pressed={filter === k}>
                {titleCase(k)}
              </Button>
            ))}
          </div>
        </CardBody>
      </Card>
      {categories.map((cat) => (
        <Card key={cat}>
          <CardHeader title={titleCase(cat)} />
          <ul className="divide-y divide-border">
            {items
              .filter((p) => p.category === cat)
              .map((p) => (
                <li key={p.id} className="space-y-2 px-4 py-3.5 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <HealthDot status={p.health?.status} />
                    <span className="text-sm font-medium text-fg">{p.name}</span>
                    <Badge tone={p.kind === 'simulated' ? 'simulated' : p.kind === 'local' ? 'neutral' : 'accent'}>{p.kind}</Badge>
                    {p.usable ? (
                      <Badge tone="success">
                        <CheckCircle2 className="h-3 w-3" /> Configured
                      </Badge>
                    ) : (
                      <Badge>
                        <CircleSlash className="h-3 w-3" /> {p.status.disabledByAdmin ? 'Disabled by admin' : 'Not configured'}
                      </Badge>
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      {p.hasHealthCheck ? (
                        <Button size="sm" variant="ghost" onClick={() => void check(p)} disabled={checking === p.id || !p.usable}>
                          {checking === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />} Check
                        </Button>
                      ) : null}
                      <Switch checked={p.userEnabled} onCheckedChange={(v) => void toggle(p, v)} label={`Enable ${p.name} for my investigations`} disabled={!p.usable} />
                    </div>
                  </div>
                  <p className="text-xs text-muted">{p.description}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-subtle">
                    {p.requires.map((r) => (
                      <span key={r.env} className="inline-flex items-center gap-1">
                        <KeyRound className="h-3 w-3" />
                        <span className="font-mono">{r.env}</span>
                        {r.present ? <span className="text-success">set</span> : <span>{r.optional ? 'optional, not set' : 'not set'}</span>}
                      </span>
                    ))}
                    {p.rateLimit ? <span>pacing: {p.rateLimit.concurrency} concurrent{p.rateLimit.minIntervalMs ? `, ≥${p.rateLimit.minIntervalMs} ms apart` : ''}</span> : null}
                    <span>reliability prior: {p.reliability}</span>
                    {p.docsUrl ? (
                      <a href={p.docsUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                        <BookOpen className="h-3 w-3" /> docs <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    ) : null}
                  </div>
                  {p.health ? (
                    <p className="text-[11px] text-subtle">
                      Last health signal {relativeTime(p.health.checkedAt)}: {p.health.status}
                      {p.health.message ? ` — ${p.health.message}` : ''}
                    </p>
                  ) : null}
                  {p.limitations.length ? (
                    <details className="text-[11px] text-muted">
                      <summary className="cursor-pointer">Limitations</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5">
                        {p.limitations.map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </li>
              ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}

function ApiStatus({ data }: { data: SettingsData }) {
  const s = data.system;
  return (
    <Card>
      <CardHeader title="API configuration status" description="Presence only — secret values are never displayed or sent to the browser." />
      <CardBody className="space-y-4">
        <div className="rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-sm text-muted">
          <p className="font-medium text-fg">How to add API keys</p>
          <p className="mt-1">
            Keys are set on the server, not in this page, so they never pass through a browser. In the ATLAS folder, copy{' '}
            <code className="font-mono text-xs">.env.example</code> to <code className="font-mono text-xs">.env</code>, put your keys after the
            matching names (for example <code className="font-mono text-xs">SHODAN_API_KEY=…</code>, without quotes or spaces), save, and
            restart ATLAS (stop <code className="font-mono text-xs">npm run dev</code> with Ctrl+C and start it again; with Docker, pass the
            file with <code className="font-mono text-xs">--env-file .env</code>). Keys are optional — many sources work without one.
          </p>
          <p className="mt-1">
            To check the file for mistakes, run <code className="font-mono text-xs">npm run env:check</code> in the ATLAS folder (it never
            prints the keys).
          </p>
        </div>
        <ul className="grid gap-1.5 text-sm sm:grid-cols-2">
          {Object.entries(s.secrets).map(([k, present]) => (
            <li key={k} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
              <span className="font-mono text-xs">{k}</span>
              {present ? <Badge tone="success">set</Badge> : <Badge>not set</Badge>}
            </li>
          ))}
        </ul>
        <dl className="grid max-w-xl grid-cols-[180px_1fr] gap-y-1 text-sm">
          <dt className="text-muted">Database</dt>
          <dd>{s.database === 'postgres' ? 'PostgreSQL' : 'SQLite (local)'}</dd>
          <dt className="text-muted">Job worker</dt>
          <dd>{s.worker}</dd>
          <dt className="text-muted">OCR</dt>
          <dd>{s.ocr ? 'enabled (offline tesseract.js)' : 'disabled'}</dd>
          <dt className="text-muted">Upload limit</dt>
          <dd>{s.maxUploadMb} MB</dd>
          <dt className="text-muted">Direct target fetching</dt>
          <dd>{s.targetFetch ? 'enabled' : 'disabled (passive only)'}</dd>
          <dt className="text-muted">Map tiles</dt>
          <dd>{s.mapTiles ? 'custom tile server' : 'OpenStreetMap default'}</dd>
        </dl>
      </CardBody>
    </Card>
  );
}

function Ai({ data }: { data: SettingsData }) {
  return (
    <Card>
      <CardHeader title="AI configuration" />
      <CardBody className="space-y-3 text-sm">
        <p>
          Status: {data.system.ai.configured ? <Badge tone="success">configured</Badge> : <Badge>not configured</Badge>} · Provider {data.system.ai.provider} · Model <span className="font-mono">{data.system.ai.model}</span>
        </p>
        <p className="text-muted">AI analysis is optional. Set <code className="font-mono">ANTHROPIC_API_KEY</code> (and optionally <code className="font-mono">ATLAS_AI_MODEL</code>) on the server. The model receives findings as untrusted data, has no tools, and every statement must cite finding references; uncited statements are discarded. Hypotheses are labelled as such.</p>
      </CardBody>
    </Card>
  );
}

function Retention({ data, save }: ReturnType<typeof usePrefs>) {
  const toast = useToast();
  const [days, setDays] = useState(String(data.user.preferences.retentionDays));
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  async function purge() {
    setBusy(true);
    try {
      const r = await api.post<{ deleted: number }>('/api/settings/retention');
      toast({ tone: 'success', title: `${r.deleted} investigation(s) purged` });
      setConfirm(false);
    } catch (e) {
      toast({ tone: 'error', title: 'Purge failed', description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader title="Data retention" description="Investigations not updated within the retention period are deleted automatically (hourly) together with their evidence and files." />
      <CardBody className="space-y-4">
        <Field label="Retention period (days)" htmlFor="pref-retention" hint="0 keeps investigations until you delete them.">
          <Input id="pref-retention" type="number" min={0} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="w-32" />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => void save({ preferences: { retentionDays: Math.max(0, Math.min(3650, Number(days) || 0)) } })}>
            Save retention
          </Button>
          <Button size="sm" variant="danger-outline" disabled={!data.user.preferences.retentionDays} onClick={() => setConfirm(true)}>
            Purge expired now
          </Button>
        </div>
      </CardBody>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Purge expired investigations?" description={`Investigations not updated in the last ${data.user.preferences.retentionDays} days will be permanently deleted.`} confirmLabel="Purge now" requirePhrase="PURGE" loading={busy} onConfirm={purge} />
    </Card>
  );
}

function Security() {
  const toast = useToast();
  const qc = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<{ items: Array<{ id: string; created_at: string; last_seen_at: string; user_agent: string | null; current: boolean }> }>('/api/settings/sessions') });
  async function changePassword() {
    try {
      await api.post('/api/settings/password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      toast({ tone: 'success', title: 'Password changed', description: 'Other sessions were signed out.' });
      await qc.invalidateQueries({ queryKey: ['sessions'] });
    } catch (e) {
      toast({ tone: 'error', title: 'Password not changed', description: (e as Error).message });
    }
  }
  async function revokeOthers() {
    await api.del('/api/settings/sessions', { allOthers: true });
    await qc.invalidateQueries({ queryKey: ['sessions'] });
    toast({ tone: 'success', title: 'Other sessions signed out' });
  }
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Change password" />
        <CardBody className="grid max-w-xl gap-3">
          <Field label="Current password" htmlFor="pw-current">
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" htmlFor="pw-new" hint="At least 10 characters.">
            <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Button size="sm" variant="primary" className="w-fit" disabled={!current || next.length < 10} onClick={() => void changePassword()}>
            Update password
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Active sessions" actions={<Button size="sm" variant="danger-outline" onClick={() => void revokeOthers()}>Sign out other sessions</Button>} />
        <ul className="divide-y divide-border">
          {sessions.data?.items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-xs sm:px-5">
              <span className="min-w-0 flex-1 truncate text-fg">{s.user_agent ?? 'Unknown client'}</span>
              {s.current ? <Badge tone="accent">This session</Badge> : null}
              <span className="text-muted">last active {relativeTime(s.last_seen_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Security posture" />
        <CardBody className="text-sm text-muted">
          <ul className="list-disc space-y-1 pl-5">
            <li>Passwords are hashed with scrypt; session tokens are stored only as SHA-256 hashes in HttpOnly, SameSite cookies.</li>
            <li>Every API request checks ownership server-side; other users’ investigations return 404.</li>
            <li>Mutations require same-origin requests; responses carry a nonce-based Content-Security-Policy.</li>
            <li>Outbound requests are restricted to public addresses (SSRF protection); user-supplied URLs are not fetched by default.</li>
            <li>See the <Link href="/settings?section=api" className="text-accent hover:underline">API configuration</Link> for what is enabled on this server.</li>
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function ExportSettings({ data, save }: ReturnType<typeof usePrefs>) {
  const p = data.user.preferences;
  return (
    <Card>
      <CardHeader title="Export settings" />
      <CardBody className="space-y-4">
        <Field label="Preferred report format" htmlFor="pref-export">
          <Select id="pref-export" value={p.exportFormat} onChange={(e) => void save({ preferences: { exportFormat: e.target.value as UserPreferences['exportFormat'] } })} className="w-56">
            <option value="pdf">PDF</option>
            <option value="markdown">Markdown</option>
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </Select>
        </Field>
        <Checkbox label="Redact emails and phone numbers in quick exports" description="Applies to the Export menu and AI analysis input." checked={p.redactExports} onChange={(e) => void save({ preferences: { redactExports: e.target.checked } })} />
      </CardBody>
    </Card>
  );
}

export function SettingsView({ initial }: { initial: SettingsData }) {
  const params = useSearchParams();
  const router = useRouter();
  const section = (params.get('section') ?? 'account') as (typeof SECTIONS)[number][0];
  const prefs = usePrefs(initial);
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted">Account, providers and platform configuration.</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav aria-label="Settings sections" className="-mx-4 overflow-x-auto px-4 lg:mx-0 lg:px-0">
          <ul className="flex gap-1 lg:flex-col">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => router.replace(`/settings?section=${id}`, { scroll: false })}
                  aria-current={section === id ? 'page' : undefined}
                  className={cn('w-full whitespace-nowrap rounded-md px-3 py-2 text-left text-sm font-medium', section === id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg')}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          {section === 'account' && <Account {...prefs} />}
          {section === 'appearance' && <Appearance {...prefs} />}
          {section === 'defaults' && <Defaults {...prefs} />}
          {section === 'providers' && <Providers />}
          {section === 'api' && <ApiStatus data={prefs.data} />}
          {section === 'ai' && <Ai data={prefs.data} />}
          {section === 'retention' && <Retention {...prefs} />}
          {section === 'security' && <Security />}
          {section === 'export' && <ExportSettings {...prefs} />}
        </div>
      </div>
    </div>
  );
}
