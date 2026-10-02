'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, Clock, Loader2, Plus, Trash2, XCircle } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ConfidenceBadge, ClaimTypeBadge, SimulatedBadge } from '@/components/domain/badges';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDuration, titleCase } from '@/lib/format';
import { normalizeTarget } from '@/shared/targets';
import { TARGET_TYPES, TARGET_TYPE_LABELS, type TargetType } from '@/shared/domain';
import { useInvestigation, liveInterval } from './use-investigation';
import type { FindingItem, TaskInfo, JobInfo } from './types';

const TASK_ICON: Record<string, { icon: typeof CheckCircle2; cls: string; label: string }> = {
  succeeded: { icon: CheckCircle2, cls: 'text-success', label: 'Succeeded' },
  failed: { icon: XCircle, cls: 'text-danger', label: 'Failed' },
  running: { icon: Loader2, cls: 'animate-spin text-accent', label: 'Running' },
  queued: { icon: Clock, cls: 'text-subtle', label: 'Queued' },
  skipped: { icon: CircleSlash, cls: 'text-subtle', label: 'Unavailable' },
  cancelled: { icon: CircleDashed, cls: 'text-subtle', label: 'Cancelled' },
};

function ProviderRuns({ tasks }: { tasks: TaskInfo[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const m = new Map<string, TaskInfo[]>();
    for (const t of tasks) m.set(t.providerId, [...(m.get(t.providerId) ?? []), t]);
    return [...m.entries()].map(([provider, ts]) => {
      const count = (s: string) => ts.filter((t) => t.status === s).length;
      const status = count('running') ? 'running' : count('queued') ? 'queued' : count('failed') && !count('succeeded') ? 'failed' : count('succeeded') ? 'succeeded' : count('skipped') ? 'skipped' : 'cancelled';
      return { provider, name: ts[0]?.providerName ?? provider, tasks: ts, status, ok: count('succeeded'), failed: count('failed'), skipped: count('skipped'), results: ts.reduce((s, t) => s + t.resultCount, 0) };
    });
  }, [tasks]);
  if (!groups.length) return <p className="text-sm text-muted">No provider tasks yet. Start collection to plan and run tasks.</p>;
  return (
    <ul className="divide-y divide-border rounded-lg border border-border" data-testid="provider-runs">
      {groups.map((g) => {
        const S = TASK_ICON[g.status] ?? TASK_ICON.queued!;
        return (
          <li key={g.provider}>
            <button type="button" className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-surface-2/60" onClick={() => setOpen(open === g.provider ? null : g.provider)} aria-expanded={open === g.provider}>
              <S.icon className={cn('h-4 w-4 shrink-0', S.cls)} aria-label={S.label} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-fg">{g.name}</span>
                {g.name !== g.provider ? <span className="ml-2 hidden font-mono text-[11px] text-subtle md:inline">{g.provider}</span> : null}
              </span>
              <span className="tabular hidden text-xs text-muted sm:inline">
                {g.ok} ok{g.failed ? ` · ${g.failed} failed` : ''}
                {g.skipped ? ` · ${g.skipped} unavailable` : ''}
              </span>
              <Badge tone={g.results ? 'accent' : 'neutral'} className="tabular">
                {g.results} results
              </Badge>
            </button>
            {open === g.provider ? (
              <ul className="space-y-1.5 border-t border-border bg-surface-2/40 px-3 py-2.5 text-xs">
                {g.tasks.map((t) => {
                  const T = TASK_ICON[t.status] ?? TASK_ICON.queued!;
                  return (
                    <li key={t.id} className="flex flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <T.icon className={cn('h-3.5 w-3.5', T.cls)} aria-label={T.label} />
                        <span className="font-medium text-fg">{titleCase(t.operation)}</span>
                        <span className="text-muted">{t.subject?.display}</span>
                        {t.subject?.derived ? <span className="text-subtle">({t.subject.derived})</span> : null}
                        {t.query ? <span className="font-mono text-subtle">{t.query}</span> : null}
                        <span className="ml-auto text-subtle">
                          {formatDuration(t.durationMs)}
                          {t.attempts > 1 ? ` · ${t.attempts} attempts` : ''}
                        </span>
                      </span>
                      {t.errorMessage ? (
                        <span className={cn('pl-5', t.status === 'failed' ? 'text-danger' : 'text-muted')}>
                          {t.errorCategory ? `${titleCase(t.errorCategory)}: ` : ''}
                          {t.errorMessage}
                        </span>
                      ) : null}
                      {t.notes.length ? <span className="pl-5 text-muted">{t.notes.join(' ')}</span> : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Targets({ id, running }: { id: string; running: boolean }) {
  const { data } = useInvestigation(id);
  const qc = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<TargetType>('domain');
  const [value, setValue] = useState('');
  const check = value.trim() ? normalizeTarget(type, value) : null;
  async function add() {
    try {
      await api.post(`/api/investigations/${id}/targets`, { targets: [{ type, value }] });
      setValue('');
      await qc.invalidateQueries({ queryKey: ['investigation', id] });
      toast({ tone: 'success', title: 'Target added', description: 'Re-run collection to query it.' });
    } catch (e) {
      toast({ tone: 'error', title: 'Could not add target', description: (e as Error).message });
    }
  }
  async function remove(targetId: string) {
    try {
      await api.del(`/api/investigations/${id}/targets/${targetId}`);
      await qc.invalidateQueries({ queryKey: ['investigation', id] });
    } catch (e) {
      toast({ tone: 'error', title: 'Could not remove target', description: (e as Error).message });
    }
  }
  return (
    <Card>
      <CardHeader title="Targets" description="Identifiers under investigation, as normalised by ATLAS." />
      <CardBody className="space-y-3">
        <ul className="space-y-1.5">
          {data?.targets.map((t) => (
            <li key={t.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
              <Badge>{TARGET_TYPE_LABELS[t.type as TargetType] ?? t.type}</Badge>
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{t.value}</span>
              {t.normalizedValue !== t.value ? <span className="hidden truncate font-mono text-[11px] text-subtle md:inline">{t.normalizedValue}</span> : null}
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${t.value}`} disabled={running} onClick={() => void remove(t.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2">
          <Select aria-label="New target type" value={type} onChange={(e) => setType(e.target.value as TargetType)}>
            {TARGET_TYPES.map((t) => (
              <option key={t} value={t}>
                {TARGET_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <div className="flex gap-2">
            <Input aria-label="New target value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="Add another identifier" className="font-mono text-[13px]" />
            <Button onClick={() => void add()} disabled={!check?.ok || running}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
        {check && !check.ok ? <p className="text-xs text-danger">{check.error}</p> : null}
      </CardBody>
    </Card>
  );
}

export function Overview({ id }: { id: string }) {
  const { data: inv } = useInvestigation(id);
  const status = inv?.status;
  const progress = useQuery({
    queryKey: ['progress', id],
    queryFn: () => api.get<{ status: string; latestJob: JobInfo | null; jobs: JobInfo[]; tasks: TaskInfo[] }>(`/api/investigations/${id}/progress`),
    refetchInterval: () => liveInterval(status, 1500),
  });
  const key = useQuery({
    queryKey: ['findings', id, 'key'],
    queryFn: () => api.get<{ items: FindingItem[] }>(`/api/investigations/${id}/findings?sort=confidence&order=desc&pageSize=8`),
    refetchInterval: () => liveInterval(status, 4000),
  });
  const contradictions = useQuery({
    queryKey: ['contradictions', id],
    queryFn: () => api.get<{ items: Array<{ entityValue: string; attribute: string; values: Array<{ value: string; providerNames: string[] }> }> }>(`/api/investigations/${id}/contradictions`),
    refetchInterval: () => liveInterval(status, 8000),
  });
  if (!inv) return null;
  const running = ['queued', 'running'].includes(inv.status);
  const latestJobTasks = (progress.data?.tasks ?? []).filter((t) => t.jobId === progress.data?.latestJob?.id);
  const skippedProviders = [...new Set(latestJobTasks.filter((t) => t.status === 'skipped').map((t) => t.providerId))];

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        {inv.mode === 'demo' ? (
          <div className="flex items-start gap-3 rounded-lg border border-simulated/40 bg-simulated-soft px-4 py-3 text-sm">
            <SimulatedBadge />
            <p className="text-fg">This is a demo investigation. All provider results are simulated with fictional entities and must not be treated as intelligence. Local analysers (phone, file metadata, OCR) still operate on real inputs.</p>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Findings', inv.counts.findings, 'findings'],
            ['Entities', inv.counts.entities, 'entities'],
            ['Relationships', inv.counts.relationships, 'graph'],
            ['Timeline events', inv.counts.timeline, 'timeline'],
          ].map(([label, n, slug]) => (
            <Link key={label as string} href={`/investigations/${id}/${slug}`} className="rounded-xl border border-border bg-surface px-4 py-3 hover:border-border-strong">
              <p className="text-xs text-muted">{label}</p>
              <p className="tabular mt-1 text-2xl font-semibold">{n as number}</p>
            </Link>
          ))}
        </div>

        <Card>
          <CardHeader
            title="Key findings"
            description="Highest-confidence findings. Open Findings for the full, filterable list."
            actions={<Link href={`/investigations/${id}/findings`} className="text-xs font-medium text-accent hover:underline">All findings</Link>}
          />
          <CardBody>
            {key.isLoading ? (
              <SkeletonRows rows={4} />
            ) : key.data?.items.length ? (
              <ul className="space-y-2.5">
                {key.data.items.map((f) => (
                  <li key={f.id} className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                    <div className="min-w-0 flex-1">
                      <Link href={`/investigations/${id}/findings?focus=${f.id}`} className="text-sm font-medium text-fg hover:text-accent">
                        {f.title}
                      </Link>
                      <p className="text-xs text-muted">{(f.providers ?? []).join(', ')}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {f.isSimulated ? <SimulatedBadge /> : null}
                      <ClaimTypeBadge type={f.claimType} />
                      <ConfidenceBadge level={f.confidence} rationale={f.confidenceRationale} score={f.confidenceScore} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title={running ? 'Collecting…' : 'No findings yet'} description={running ? 'Findings appear here as providers return results.' : inv.status === 'draft' ? 'Start collection to query providers.' : 'No provider returned results. Check the provider runs for errors and coverage gaps.'} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Provider runs" description="Every planned provider task, its outcome, duration and errors — for the latest run." />
          <CardBody>{progress.isLoading ? <SkeletonRows rows={4} /> : <ProviderRuns tasks={latestJobTasks} />}</CardBody>
        </Card>
      </div>

      <div className="space-y-6">
        <Targets id={id} running={running} />
        <Card>
          <CardHeader title="Coverage" />
          <CardBody className="space-y-2 text-sm">
            <p className="text-muted">
              Modules: <span className="text-fg">{inv.effectiveModules.map((m) => titleCase(m)).join(', ')}</span>
            </p>
            {skippedProviders.length ? (
              <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-fg">
                <p className="flex items-center gap-1.5 font-medium text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" /> {skippedProviders.length} source(s) unavailable
                </p>
                <p className="mt-1 text-muted">{skippedProviders.join(', ')}</p>
                <Link href="/settings?section=providers" className="mt-1 inline-block font-medium text-accent hover:underline">
                  Configure providers
                </Link>
              </div>
            ) : null}
            <p className="text-xs text-subtle">ATLAS reports only what the queried sources returned. Absence of findings is not evidence of absence.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Contradictions" description="Attributes where sources disagree." />
          <CardBody>
            {contradictions.data?.items.length ? (
              <ul className="space-y-2 text-xs">
                {contradictions.data.items.map((c, i) => (
                  <li key={i} className="rounded-md border border-warning/30 bg-warning-soft/60 px-3 py-2">
                    <p className="font-medium text-fg">
                      {c.entityValue} · {titleCase(c.attribute)}
                    </p>
                    <ul className="mt-1 space-y-0.5 text-muted">
                      {c.values.map((v) => (
                        <li key={v.value}>
                          “{v.value}” — {v.providerNames.join(', ')}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">None detected.</p>
            )}
          </CardBody>
        </Card>
        {inv.counts.pendingCandidates ? (
          <Card className="border-warning/40">
            <CardBody className="text-sm">
              <p className="font-medium text-fg">{inv.counts.pendingCandidates} possible entity match(es) need review</p>
              <p className="mt-1 text-xs text-muted">Accounts are never merged automatically.</p>
              <Link href={`/investigations/${id}/entities?tab=matches`} className="mt-2 inline-block text-xs font-medium text-accent hover:underline">
                Review matches
              </Link>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
