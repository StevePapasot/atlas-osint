'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { Activity, Boxes, FileStack, FolderSearch, Network, Plus, Radar, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge, ModeBadge } from '@/components/domain/badges';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { relativeTime, titleCase } from '@/lib/format';
import { CATEGORY_LABELS, CONFIDENCE_LABELS, CONFIDENCE_LEVELS, type EvidenceCategory } from '@/shared/domain';

export interface DashboardData {
  totals: { investigations: number; findings: number; entities: number; evidence: number; relationships: number; active: number };
  statusCounts: Record<string, number>;
  byConfidence: Record<string, number>;
  byCategory: Record<string, number>;
  recent: Array<{ id: string; name: string; status: string; depth: string; mode: string; updatedAt: string; findings: number }>;
  activeJobs: Array<{ id: string; investigationId: string; investigationName: string; status: string; stage: string | null; progress: number; completedTasks: number; totalTasks: number; kind: string }>;
  recentActivity: Array<{ id: string; action: string; created_at: string; investigation_id: string | null; investigation_name: string | null }>;
  providers: Array<{ id: string; name: string; kind: string; category: string; usable: boolean; configured: boolean; health: { status: string; message: string | null; checkedAt: string } | null }>;
}

function Stat({ label, value, icon: Icon, hint }: { label: string; value: number; icon: typeof Boxes; hint?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted">{label}</p>
        <Icon className="h-4 w-4 text-subtle" aria-hidden />
      </div>
      <p className="tabular mt-1.5 text-2xl font-semibold tracking-tight text-fg">{value.toLocaleString('en')}</p>
      {hint ? <p className="mt-0.5 text-[11px] text-subtle">{hint}</p> : null}
    </Card>
  );
}

const tooltipStyle = { background: 'var(--elevated)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--fg)' };

function ChartTable({ rows, caption }: { rows: Array<{ label: string; value: number }>; caption: string }) {
  return (
    <details className="mt-2 text-xs text-muted">
      <summary className="cursor-pointer select-none">View as table</summary>
      <table className="mt-2 w-full">
        <caption className="sr-only">{caption}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border last:border-0">
              <td className="py-1">{r.label}</td>
              <td className="tabular py-1 text-right text-fg">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'investigation.created': 'Created investigation',
  'investigation.started': 'Started collection',
  'investigation.cancel_requested': 'Cancelled collection',
  'investigation.deleted': 'Deleted investigation',
  'investigation.exported': 'Exported results',
  'report.generated': 'Generated report',
  'report.downloaded': 'Downloaded report',
  'finding.verified': 'Verified a finding',
  'finding.disputed': 'Disputed a finding',
  'finding.false_positive': 'Marked false positive',
  'artifact.uploaded': 'Uploaded file',
  'note.added': 'Added note',
  'auth.login': 'Signed in',
};

export function DashboardView({ initial, userName }: { initial: DashboardData; userName: string }) {
  const { data } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/api/dashboard'),
    initialData: initial,
    refetchInterval: (q) => ((q.state.data?.activeJobs.length ?? 0) > 0 ? 3000 : 30_000),
  });
  const d = data;
  const confidenceRows = CONFIDENCE_LEVELS.map((c) => ({ label: CONFIDENCE_LABELS[c], value: d.byConfidence[c] ?? 0 }));
  const categoryRows = Object.entries(d.byCategory)
    .map(([k, v]) => ({ label: CATEGORY_LABELS[k as EvidenceCategory] ?? k, value: v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const live = d.providers.filter((p) => p.kind === 'live');
  const usable = live.filter((p) => p.usable);
  const degraded = live.filter((p) => p.health && p.health.status !== 'healthy' && p.health.status !== 'unknown');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-fg">Dashboard</h1>
          <p className="text-sm text-muted">Welcome back, {userName.split(' ')[0]}. All figures come from your stored investigations.</p>
        </div>
        <Button asChild variant="primary" size="lg">
          <Link href="/investigations/new">
            <Plus className="h-4 w-4" /> New investigation
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Investigations" value={d.totals.investigations} icon={FolderSearch} hint={`${d.statusCounts.completed ?? 0} completed · ${d.statusCounts.partially_completed ?? 0} partial`} />
        <Stat label="Active now" value={d.totals.active} icon={Activity} hint="Queued or running" />
        <Stat label="Findings" value={d.totals.findings} icon={Radar} />
        <Stat label="Entities" value={d.totals.entities} icon={Boxes} />
        <Stat label="Relationships" value={d.totals.relationships} icon={Network} />
        <Stat label="Evidence items" value={d.totals.evidence} icon={FileStack} hint="Hashed and stored" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title="Recent investigations" actions={<Link href="/investigations" className="text-xs font-medium text-accent hover:underline">View all</Link>} />
          {d.recent.length ? (
            <ul className="divide-y divide-border">
              {d.recent.map((inv) => (
                <li key={inv.id}>
                  <Link href={`/investigations/${inv.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-surface-2/60 sm:px-5">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{inv.name}</span>
                    <span className="flex items-center gap-2">
                      <ModeBadge mode={inv.mode} />
                      <Badge>{titleCase(inv.depth)}</Badge>
                      <StatusBadge status={inv.status} />
                    </span>
                    <span className="tabular w-24 text-right text-xs text-muted">{inv.findings} findings</span>
                    <span className="w-20 text-right text-xs text-subtle">{relativeTime(inv.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <CardBody>
              <EmptyState
                icon={<FolderSearch />}
                title="No investigations yet"
                description="Create an investigation, add one or more identifiers, and run a live or demo collection."
                action={
                  <Button asChild variant="primary">
                    <Link href="/investigations/new">Start an investigation</Link>
                  </Button>
                }
              />
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader title="Active collection" description="Progress reflects completed provider tasks." />
          <CardBody className="space-y-4">
            {d.activeJobs.length ? (
              d.activeJobs.map((j) => (
                <Link key={j.id} href={`/investigations/${j.investigationId}`} className="block space-y-1.5 rounded-lg p-1 hover:bg-surface-2/60">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate font-medium text-fg">{j.investigationName}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  <ProgressBar value={j.progress} label={`${j.investigationName} progress`} />
                  <p className="tabular text-[11px] text-muted">
                    {j.completedTasks}/{j.totalTasks} tasks · {j.kind === 'artifact' ? 'file analysis' : (j.stage ?? 'queued')}
                  </p>
                </Link>
              ))
            ) : (
              <p className="text-sm text-muted">Nothing is running.</p>
            )}
          </CardBody>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
        <Card>
          <CardHeader title="Findings by confidence" description="Excludes false positives. Confidence is ordinal, not a probability." />
          <CardBody>
            {d.totals.findings ? (
              <>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={confidenceRows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
                      <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 11 }} tickLine={false} axisLine={false} interval={0} tickFormatter={(v: string) => v.replace(' confidence', '')} />
                      <YAxis allowDecimals={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} tickLine={false} axisLine={false} />
                      <ChartTooltip cursor={{ fill: 'var(--surface-2)' }} contentStyle={tooltipStyle} labelStyle={{ color: 'var(--fg)' }} itemStyle={{ color: 'var(--fg)' }} />
                      <Bar dataKey="value" name="Findings" fill="var(--chart-1)" radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ChartTable rows={confidenceRows} caption="Findings by confidence" />
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted">No findings yet.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Findings by evidence category" />
          <CardBody>
            {categoryRows.length ? (
              <>
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={categoryRows} layout="vertical" margin={{ top: 0, right: 12, left: 8, bottom: 0 }}>
                      <CartesianGrid horizontal={false} stroke="var(--chart-grid)" />
                      <XAxis type="number" allowDecimals={false} tick={{ fill: 'var(--muted)', fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis type="category" dataKey="label" width={104} tick={{ fill: 'var(--muted)', fontSize: 11 }} tickLine={false} axisLine={false} />
                      <ChartTooltip cursor={{ fill: 'var(--surface-2)' }} contentStyle={tooltipStyle} labelStyle={{ color: 'var(--fg)' }} itemStyle={{ color: 'var(--fg)' }} />
                      <Bar dataKey="value" name="Findings" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ChartTable rows={categoryRows} caption="Findings by evidence category" />
              </>
            ) : (
              <p className="py-10 text-center text-sm text-muted">No findings yet.</p>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2 xl:col-span-1">
          <CardHeader
            title="Provider health"
            description={`${usable.length} of ${live.length} live providers configured`}
            actions={<Link href="/settings?section=providers" className="text-xs font-medium text-accent hover:underline">Manage</Link>}
          />
          <CardBody className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-surface-2 px-2 py-2.5">
                <ShieldCheck className="mx-auto h-4 w-4 text-success" aria-hidden />
                <p className="tabular mt-1 text-lg font-semibold">{usable.length - degraded.filter((p) => p.usable).length}</p>
                <p className="text-[11px] text-muted">Available</p>
              </div>
              <div className="rounded-lg bg-surface-2 px-2 py-2.5">
                <ShieldAlert className="mx-auto h-4 w-4 text-warning" aria-hidden />
                <p className="tabular mt-1 text-lg font-semibold">{degraded.length}</p>
                <p className="text-[11px] text-muted">Recent errors</p>
              </div>
              <div className="rounded-lg bg-surface-2 px-2 py-2.5">
                <ShieldQuestion className="mx-auto h-4 w-4 text-subtle" aria-hidden />
                <p className="tabular mt-1 text-lg font-semibold">{live.length - usable.length}</p>
                <p className="text-[11px] text-muted">Not configured</p>
              </div>
            </div>
            <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1 text-xs">
              {degraded.slice(0, 8).map((p) => (
                <li key={p.id} className="flex items-start justify-between gap-2">
                  <span className="font-medium text-fg">{p.name}</span>
                  <span className="truncate text-right text-muted" title={p.health?.message ?? ''}>
                    {p.health?.message?.slice(0, 60)}
                  </span>
                </li>
              ))}
              {!degraded.length ? <li className="text-muted">No provider errors recorded.</li> : null}
            </ul>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader title="Recent activity" description="From your audit log." />
        {d.recentActivity.length ? (
          <ul className="divide-y divide-border">
            {d.recentActivity.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm sm:px-5">
                <span className="text-fg">{ACTION_LABELS[a.action] ?? titleCase(a.action.replace('.', ' '))}</span>
                {a.investigation_name ? (
                  <Link href={`/investigations/${a.investigation_id}`} className="truncate text-accent hover:underline">
                    {a.investigation_name}
                  </Link>
                ) : null}
                <span className="ml-auto text-xs text-subtle">{relativeTime(a.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <CardBody>
            <p className="text-sm text-muted">No activity yet.</p>
          </CardBody>
        )}
      </Card>
    </div>
  );
}
