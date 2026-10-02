'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Download, MoreHorizontal, Play, RotateCw, Square, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ProgressBar } from '@/components/ui/progress';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { ModeBadge, StatusBadge } from '@/components/domain/badges';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime, titleCase } from '@/lib/format';
import { useInvestigation } from './use-investigation';
import { ACTIVE_STATUSES, type InvestigationDetail } from './types';

const TABS = [
  { slug: '', label: 'Overview' },
  { slug: 'findings', label: 'Findings' },
  { slug: 'entities', label: 'Entities' },
  { slug: 'graph', label: 'Relationship Graph' },
  { slug: 'timeline', label: 'Timeline' },
  { slug: 'geoint', label: 'GEOINT' },
  { slug: 'documents', label: 'Documents' },
  { slug: 'images', label: 'Image Analysis' },
  { slug: 'darkweb', label: 'Dark-Web Sources' },
  { slug: 'evidence', label: 'Evidence' },
  { slug: 'reports', label: 'Reports' },
  { slug: 'activity', label: 'Activity & Notes' },
];

export function WorkspaceHeader({ initial }: { initial: InvestigationDetail }) {
  const { data } = useInvestigation(initial.id, initial);
  const inv = data ?? initial;
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'start' | 'cancel' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const running = ACTIVE_STATUSES.includes(inv.status);
  const base = `/investigations/${inv.id}`;
  const job = inv.latestJob;

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ['investigation', inv.id] });
    await qc.invalidateQueries({ queryKey: ['progress', inv.id] });
  }

  async function start() {
    setBusy('start');
    try {
      await api.post(`/api/investigations/${inv.id}/start`);
      toast({ tone: 'success', title: inv.status === 'draft' ? 'Collection started' : 'Collection re-run started', description: 'Progress updates as provider tasks complete.' });
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: 'Could not start', description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy('cancel');
    try {
      await api.post(`/api/investigations/${inv.id}/cancel`);
      toast({ tone: 'info', title: 'Cancellation requested', description: 'In-flight provider calls are being stopped. Partial results are kept.' });
      setConfirmCancel(false);
      await refresh();
    } catch (e) {
      toast({ tone: 'error', title: 'Could not cancel', description: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy('delete');
    try {
      await api.del(`/api/investigations/${inv.id}`);
      toast({ tone: 'success', title: 'Investigation deleted' });
      router.replace('/investigations');
    } catch (e) {
      toast({ tone: 'error', title: 'Delete failed', description: (e as Error).message });
      setBusy(null);
    }
  }

  const activeSlug = pathname.replace(base, '').replace(/^\//, '').split('/')[0] ?? '';

  return (
    <div className="mb-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/investigations" className="text-xs text-muted hover:text-fg">
              Investigations
            </Link>
            <span className="text-xs text-subtle">/</span>
            <ModeBadge mode={inv.mode} />
            <Badge>{titleCase(inv.depth)}</Badge>
            <StatusBadge status={inv.status} />
          </div>
          <h1 className="truncate text-xl font-semibold tracking-tight text-fg" data-testid="investigation-name">
            {inv.name}
          </h1>
          <div className="flex flex-wrap gap-1.5">
            {inv.targets.slice(0, 6).map((t) => (
              <span key={t.id} className="inline-flex max-w-[260px] items-center gap-1 rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[11px] text-muted">
                <span className="font-sans text-subtle">{t.type}</span>
                <span className="truncate text-fg">{t.value}</span>
              </span>
            ))}
            {inv.targets.length > 6 ? <span className="text-xs text-muted">+{inv.targets.length - 6} more</span> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button variant="danger-outline" onClick={() => setConfirmCancel(true)} loading={busy === 'cancel'} disabled={job?.cancelRequested}>
              <Square className="h-3.5 w-3.5" /> {job?.cancelRequested ? 'Cancelling…' : 'Cancel'}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void start()} loading={busy === 'start'} disabled={!inv.targets.length} data-testid="start-collection">
              {inv.status === 'draft' ? <Play className="h-3.5 w-3.5" /> : <RotateCw className="h-3.5 w-3.5" />}
              {inv.status === 'draft' ? 'Start collection' : 'Re-run'}
            </Button>
          )}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button>
                <Download className="h-3.5 w-3.5" /> Export <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-44 rounded-lg border border-border bg-elevated p-1 text-sm shadow-xl">
                {[
                  ['pdf', 'PDF report'],
                  ['markdown', 'Markdown'],
                  ['json', 'JSON (structured)'],
                  ['csv', 'CSV (findings)'],
                ].map(([f, label]) => (
                  <DropdownMenu.Item key={f} asChild>
                    <a href={`/api/investigations/${inv.id}/export?format=${f}`} className="block cursor-pointer rounded-md px-2.5 py-2 text-fg outline-none data-[highlighted]:bg-surface-2" data-testid={`export-${f}`}>
                      {label}
                    </a>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button size="icon" variant="ghost" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={6} className="z-50 min-w-44 rounded-lg border border-border bg-elevated p-1 text-sm shadow-xl">
                <DropdownMenu.Item onSelect={() => setConfirmDelete(true)} className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-danger outline-none data-[highlighted]:bg-danger-soft">
                  <Trash2 className="h-4 w-4" /> Delete investigation
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      {job ? (
        <div className="space-y-1.5 rounded-lg border border-border bg-surface px-4 py-3" data-testid="job-progress">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium text-fg">
              {running ? `Collecting — ${job.stage ?? 'queued'}` : `Last run ${titleCase(job.status)}`} · {job.completedTasks}/{job.totalTasks} tasks
              {job.failedTasks ? <span className="text-danger"> · {job.failedTasks} failed</span> : null}
              {job.skippedTasks ? <span className="text-muted"> · {job.skippedTasks} unavailable</span> : null}
            </span>
            <span className="text-muted">{running ? `started ${relativeTime(job.startedAt ?? job.createdAt)}` : `finished ${relativeTime(job.finishedAt)}`}</span>
          </div>
          <ProgressBar value={job.progress} tone={job.status === 'failed' ? 'danger' : job.status === 'partially_completed' ? 'warning' : job.status === 'completed' ? 'success' : 'accent'} label="Collection progress" />
          {job.error ? <p className="text-xs text-danger">{job.error}</p> : null}
        </div>
      ) : null}

      <nav className="-mx-4 overflow-x-auto border-b border-border px-4 scrollbar-none sm:mx-0 sm:px-0" aria-label="Investigation sections">
        <ul className="flex min-w-max gap-1">
          {TABS.map((t) => {
            const active = activeSlug === t.slug;
            const count =
              t.slug === 'findings' ? inv.counts.findings : t.slug === 'entities' ? inv.counts.entities : t.slug === 'evidence' ? inv.counts.evidence : t.slug === 'reports' ? inv.counts.reports : null;
            return (
              <li key={t.slug}>
                <Link
                  href={t.slug ? `${base}/${t.slug}` : base}
                  aria-current={active ? 'page' : undefined}
                  className={cn('flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors', active ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}
                >
                  {t.label}
                  {count ? <span className="tabular rounded bg-surface-2 px-1.5 text-[11px] text-muted">{count}</span> : null}
                  {t.slug === 'entities' && inv.counts.pendingCandidates ? <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="Pending entity matches" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <ConfirmDialog open={confirmCancel} onOpenChange={setConfirmCancel} title="Cancel collection?" description="Queued provider tasks are skipped and in-flight calls are aborted. Results already collected are kept." confirmLabel="Cancel collection" loading={busy === 'cancel'} onConfirm={cancel} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this investigation?"
        description="All targets, findings, evidence, uploaded files, notes and reports will be permanently deleted."
        confirmLabel="Delete permanently"
        requirePhrase={inv.name}
        loading={busy === 'delete'}
        onConfirm={remove}
      />
    </div>
  );
}
