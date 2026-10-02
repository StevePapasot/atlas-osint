'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileStack, Fingerprint, Search } from 'lucide-react';
import { Input, Select } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { Pagination } from '@/components/ui/pagination';
import { Sheet } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ConfidenceBadge, SimulatedBadge } from '@/components/domain/badges';
import { api, qs } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { SafeLink } from './finding-detail';
import { useInvestigation, liveInterval } from './use-investigation';

interface EvidenceItem {
  id: string;
  kind: string;
  title: string;
  content_type: string;
  sha256: string;
  source_url: string | null;
  provider_id: string | null;
  providerName: string | null;
  collected_at: string;
  isSimulated: boolean;
  preview: string;
  findingIds: string[];
}

export function EvidenceView({ investigationId }: { investigationId: string }) {
  const { data: inv } = useInvestigation(investigationId);
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['evidence', investigationId, kind, q, page],
    queryFn: () => api.get<{ total: number; items: EvidenceItem[] }>(`/api/investigations/${investigationId}/evidence${qs({ kind, q, page, pageSize: 25 })}`),
    refetchInterval: () => liveInterval(inv?.status, 5000),
    placeholderData: (p) => p,
  });
  const detail = useQuery({
    queryKey: ['evidence-item', selected],
    queryFn: () => api.get<EvidenceItem & { content: string; findings: Array<{ id: string; title: string; confidence: string }> }>(`/api/investigations/${investigationId}/evidence/${selected}`),
    enabled: Boolean(selected),
  });
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">Every stored evidence item is immutable and content-hashed (SHA-256) at collection time. Provider responses are stored with secrets redacted and size-limited.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search evidence content" className="pl-9" aria-label="Search evidence" />
        </div>
        <Select value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }} className="sm:w-52" aria-label="Evidence kind">
          <option value="">All kinds</option>
          <option value="excerpt">Excerpts</option>
          <option value="api_response">Provider responses</option>
          <option value="metadata">Metadata</option>
        </Select>
      </div>
      {list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : null}
      {list.isLoading ? <SkeletonRows /> : !list.data?.items.length ? (
        <EmptyState icon={<FileStack />} title="No evidence" description="Evidence is stored for every provider observation." />
      ) : (
        <>
          <ul className="space-y-2" data-testid="evidence-list">
            {list.data.items.map((e) => (
              <li key={e.id}>
                <button type="button" onClick={() => setSelected(e.id)} className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-left hover:border-border-strong">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{e.kind}</Badge>
                    {e.isSimulated ? <SimulatedBadge /> : null}
                    <span className="text-sm font-medium text-fg">{e.title}</span>
                    <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-subtle">
                      <Fingerprint className="h-3 w-3" />
                      {e.sha256.slice(0, 12)}
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted">{e.preview}</p>
                  <p className="mt-1.5 text-[11px] text-subtle">
                    {e.providerName ?? 'local'} · collected {formatDate(e.collected_at, { time: true })} · supports {e.findingIds.length} finding(s)
                  </p>
                </button>
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={25} total={list.data.total} onPage={setPage} />
        </>
      )}
      <Sheet open={Boolean(selected)} onOpenChange={(o) => !o && setSelected(null)} title={detail.data?.title ?? 'Evidence'} description={detail.data ? `SHA-256 ${detail.data.sha256}` : undefined}>
        {detail.data ? (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <Badge>{detail.data.kind}</Badge>
              <span>{detail.data.content_type}</span>
              <span>collected {formatDate(detail.data.collected_at, { time: true })}</span>
            </div>
            {detail.data.source_url ? <SafeLink href={detail.data.source_url}>{detail.data.source_url}</SafeLink> : null}
            <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-surface-2/50 p-3 font-mono text-[11px]">{detail.data.content}</pre>
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Supports findings</p>
              <ul className="space-y-1 text-xs">
                {detail.data.findings.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-2">
                    <a href={`/investigations/${investigationId}/findings?focus=${f.id}`} className="truncate text-accent hover:underline">
                      {f.title}
                    </a>
                    <ConfidenceBadge level={f.confidence} />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <SkeletonRows />
        )}
      </Sheet>
    </div>
  );
}
