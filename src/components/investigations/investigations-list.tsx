'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderSearch, Plus, Search, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Table, THead, TH, TR, TD } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { StatusBadge, ModeBadge } from '@/components/domain/badges';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/toast';
import { api, qs } from '@/lib/api';
import { relativeTime, titleCase } from '@/lib/format';

interface Item {
  id: string;
  name: string;
  status: string;
  depth: string;
  mode: string;
  updatedAt: string;
  counts: { targets: number; findings: number; entities: number; evidence: number };
}

export function InvestigationsList() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [toDelete, setToDelete] = useState<Item | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['investigations', q, status],
    queryFn: () => api.get<{ items: Item[] }>(`/api/investigations${qs({ q, status })}`),
    refetchInterval: (s) => (s.state.data?.items.some((i) => i.status === 'running' || i.status === 'queued') ? 3000 : false),
  });

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.del(`/api/investigations/${toDelete.id}`);
      toast({ tone: 'success', title: 'Investigation deleted', description: `${toDelete.name} and all of its evidence were removed.` });
      setToDelete(null);
      await qc.invalidateQueries({ queryKey: ['investigations'] });
    } catch (e) {
      toast({ tone: 'error', title: 'Delete failed', description: (e as Error).message });
    } finally {
      setDeleting(false);
    }
  }

  const items = query.data?.items ?? [];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Investigations</h1>
          <p className="text-sm text-muted">Private to your account.</p>
        </div>
        <Button asChild variant="primary">
          <Link href="/investigations/new">
            <Plus className="h-4 w-4" /> New investigation
          </Link>
        </Button>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" className="pl-9" aria-label="Search investigations" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-56" aria-label="Filter by status">
          <option value="">All statuses</option>
          {['draft', 'queued', 'running', 'partially_completed', 'completed', 'failed', 'cancelled'].map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
      </div>
      {query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}
      {query.isLoading ? (
        <SkeletonRows />
      ) : !items.length ? (
        <EmptyState icon={<FolderSearch />} title={q || status ? 'No matching investigations' : 'No investigations yet'} description="Investigations group targets, collected evidence, analysis and reports." action={<Button asChild variant="primary"><Link href="/investigations/new">Create investigation</Link></Button>} />
      ) : (
        <>
          <Card className="hidden overflow-hidden md:block">
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Mode</TH>
                  <TH>Depth</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Targets</TH>
                  <TH className="text-right">Findings</TH>
                  <TH className="text-right">Entities</TH>
                  <TH className="text-right">Updated</TH>
                  <TH className="w-10"><span className="sr-only">Actions</span></TH>
                </tr>
              </THead>
              <tbody>
                {items.map((i) => (
                  <TR key={i.id}>
                    <TD className="max-w-[320px]">
                      <Link href={`/investigations/${i.id}`} className="font-medium text-fg hover:text-accent">
                        {i.name}
                      </Link>
                    </TD>
                    <TD><ModeBadge mode={i.mode} /></TD>
                    <TD><Badge>{titleCase(i.depth)}</Badge></TD>
                    <TD><StatusBadge status={i.status} /></TD>
                    <TD className="tabular text-right">{i.counts.targets}</TD>
                    <TD className="tabular text-right">{i.counts.findings}</TD>
                    <TD className="tabular text-right">{i.counts.entities}</TD>
                    <TD className="text-right text-xs text-muted">{relativeTime(i.updatedAt)}</TD>
                    <TD>
                      <Button size="icon-sm" variant="ghost" aria-label={`Delete ${i.name}`} onClick={() => setToDelete(i)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="space-y-2 md:hidden">
            {items.map((i) => (
              <li key={i.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Link href={`/investigations/${i.id}`} className="font-medium text-fg">
                      {i.name}
                    </Link>
                    <StatusBadge status={i.status} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <ModeBadge mode={i.mode} />
                    <Badge>{titleCase(i.depth)}</Badge>
                    <span>{i.counts.findings} findings</span>
                    <span>· {relativeTime(i.updatedAt)}</span>
                    <button type="button" className="ml-auto inline-flex min-h-[36px] items-center gap-1 text-danger" onClick={() => setToDelete(i)}>
                      <Trash2 className="h-3.5 w-3.5" /> Delete
                    </button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(o) => !o && setToDelete(null)}
        title="Delete investigation?"
        description="This permanently deletes the investigation, its targets, findings, evidence, uploaded files and reports. This cannot be undone."
        confirmLabel="Delete permanently"
        requirePhrase={toDelete?.name}
        loading={deleting}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
