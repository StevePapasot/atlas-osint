'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Bookmark, Filter, Search, SlidersHorizontal, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Table, THead, TH, TR, TD } from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { CategoryBadge, ClaimTypeBadge, ConfidenceBadge, EntityIcon, SimulatedBadge, VerificationBadge } from '@/components/domain/badges';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatPrecisionDate } from '@/lib/format';
import { CATEGORY_LABELS, CLAIM_TYPE_LABELS, CONFIDENCE_LABELS, CONFIDENCE_LEVELS, ENTITY_LABELS, ENTITY_TYPES, EVIDENCE_CATEGORIES, CLAIM_TYPES, VERIFICATION_LABELS, VERIFICATION_STATUSES } from '@/shared/domain';
import { FindingDetailSheet } from './finding-detail';
import { useInvestigation, liveInterval } from './use-investigation';
import type { FindingItem } from './types';

export interface FindingFilters {
  q?: string;
  entityType?: string;
  provider?: string;
  source?: string;
  confidence?: string;
  verification?: string;
  category?: string;
  claimType?: string;
  location?: string;
  dateFrom?: string;
  dateTo?: string;
  dateField?: 'collected' | 'published';
  bookmarked?: string;
  tag?: string;
  includeFalsePositives?: string;
  hasGeo?: string;
}

type SortKey = 'collected_at' | 'published_at' | 'confidence' | 'title' | 'source_count' | 'category';

export function FindingsTable({ investigationId, preset = {}, hideFilters = [], title }: { investigationId: string; preset?: FindingFilters; hideFilters?: Array<keyof FindingFilters>; title?: string }) {
  const params = useSearchParams();
  const { data: inv } = useInvestigation(investigationId);
  const [filters, setFilters] = useState<FindingFilters>(preset);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('confidence');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<string | null>(params.get('focus'));

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => ({ ...f, q: q || undefined }));
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ items: Array<{ id: string; name: string }> }>('/api/providers'), staleTime: 60_000 });
  const tags = useQuery({ queryKey: ['tags', investigationId], queryFn: () => api.get<{ items: Array<{ name: string; count: number }> }>(`/api/investigations/${investigationId}/tags`) });

  const query = useQuery({
    queryKey: ['findings', investigationId, filters, sort, order, page, pageSize],
    queryFn: () => api.get<{ total: number; items: FindingItem[] }>(`/api/investigations/${investigationId}/findings${qs({ ...filters, ...preset, sort, order, page, pageSize })}`),
    refetchInterval: () => liveInterval(inv?.status, 4000),
    placeholderData: (prev) => prev,
  });

  const set = (k: keyof FindingFilters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v || undefined }));
    setPage(1);
  };
  const activeCount = useMemo(() => Object.entries(filters).filter(([k, v]) => v && k !== 'q' && !(k in preset)).length, [filters, preset]);
  const toggleSort = (k: SortKey) => {
    if (sort === k) setOrder(order === 'asc' ? 'desc' : 'asc');
    else {
      setSort(k);
      setOrder(k === 'title' ? 'asc' : 'desc');
    }
  };
  const sortHead = (k: SortKey, children: React.ReactNode, className?: string) => (
    <TH className={className} aria-sort={sort === k ? (order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-fg" onClick={() => toggleSort(k)}>
        {children}
        {sort === k ? order === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" /> : null}
      </button>
    </TH>
  );
  const show = (k: keyof FindingFilters) => !hideFilters.includes(k) && !(k in preset);
  const items = query.data?.items ?? [];

  return (
    <div className="space-y-3">
      {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search findings" className="pl-9" aria-label="Search findings" />
        </div>
        <div className="flex gap-2">
          <Select aria-label="Filter by confidence" value={filters.confidence ?? ''} onChange={(e) => set('confidence', e.target.value)} className="sm:w-44">
            <option value="">Any confidence</option>
            {CONFIDENCE_LEVELS.map((c) => (
              <option key={c} value={c}>
                {CONFIDENCE_LABELS[c]}
              </option>
            ))}
          </Select>
          <Button onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters} aria-controls="finding-filters">
            <SlidersHorizontal className="h-4 w-4" /> Filters{activeCount ? <Badge tone="accent">{activeCount}</Badge> : null}
          </Button>
        </div>
      </div>
      {showFilters ? (
        <Card id="finding-filters" className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {show('entityType') ? (
            <Select aria-label="Entity type" value={filters.entityType ?? ''} onChange={(e) => set('entityType', e.target.value)}>
              <option value="">Any entity type</option>
              {ENTITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ENTITY_LABELS[t]}
                </option>
              ))}
            </Select>
          ) : null}
          {show('provider') ? (
            <Select aria-label="Provider" value={filters.provider ?? ''} onChange={(e) => set('provider', e.target.value)}>
              <option value="">Any provider</option>
              {(providers.data?.items ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : null}
          {show('source') ? <Input aria-label="Source contains" placeholder="Source name or URL contains" value={filters.source ?? ''} onChange={(e) => set('source', e.target.value)} /> : null}
          {show('verification') ? (
            <Select aria-label="Verification status" value={filters.verification ?? ''} onChange={(e) => set('verification', e.target.value)}>
              <option value="">Any review status</option>
              {VERIFICATION_STATUSES.map((v) => (
                <option key={v} value={v}>
                  {VERIFICATION_LABELS[v]}
                </option>
              ))}
            </Select>
          ) : null}
          {show('category') ? (
            <Select aria-label="Evidence category" value={filters.category ?? ''} onChange={(e) => set('category', e.target.value)}>
              <option value="">Any category</option>
              {EVIDENCE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          ) : null}
          {show('claimType') ? (
            <Select aria-label="Claim type" value={filters.claimType ?? ''} onChange={(e) => set('claimType', e.target.value)}>
              <option value="">Any claim type</option>
              {CLAIM_TYPES.map((c) => (
                <option key={c} value={c}>
                  {CLAIM_TYPE_LABELS[c].label}
                </option>
              ))}
            </Select>
          ) : null}
          {show('location') ? <Input aria-label="Location contains" placeholder="Location (place or country code)" value={filters.location ?? ''} onChange={(e) => set('location', e.target.value)} /> : null}
          {show('tag') ? (
            <Select aria-label="Tag" value={filters.tag ?? ''} onChange={(e) => set('tag', e.target.value)}>
              <option value="">Any tag</option>
              {(tags.data?.items ?? []).map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.count})
                </option>
              ))}
            </Select>
          ) : null}
          <div className="flex gap-2 sm:col-span-2">
            <Select aria-label="Date field" value={filters.dateField ?? 'collected'} onChange={(e) => set('dateField', e.target.value)} className="w-40">
              <option value="collected">Collected</option>
              <option value="published">Source date</option>
            </Select>
            <Input type="date" aria-label="From date" value={filters.dateFrom ?? ''} onChange={(e) => set('dateFrom', e.target.value)} />
            <Input type="date" aria-label="To date" value={filters.dateTo ?? ''} onChange={(e) => set('dateTo', e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={filters.bookmarked === 'true'} onChange={(e) => set('bookmarked', e.target.checked ? 'true' : '')} className="accent-[var(--accent)]" /> Bookmarked only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={filters.includeFalsePositives === 'true'} onChange={(e) => set('includeFalsePositives', e.target.checked ? 'true' : '')} className="accent-[var(--accent)]" /> Include false positives
          </label>
          <Button
            variant="ghost"
            size="sm"
            className="justify-self-start"
            onClick={() => {
              setFilters(preset);
              setQ('');
            }}
          >
            <X className="h-3.5 w-3.5" /> Clear filters
          </Button>
        </Card>
      ) : null}

      {query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : null}
      {query.isLoading ? (
        <SkeletonRows />
      ) : !items.length ? (
        <EmptyState icon={<Filter />} title="No findings match" description={activeCount || filters.q ? 'Adjust or clear the filters.' : 'Nothing has been collected for this view yet.'} />
      ) : (
        <>
          <Card className="hidden overflow-hidden md:block">
            <Table data-testid="findings-table">
              <THead>
                <tr>
                  {sortHead('title', 'Finding')}
                  <TH>Claim</TH>
                  {sortHead('confidence', 'Confidence')}
                  <TH>Review</TH>
                  {sortHead('source_count', 'Sources', 'text-right')}
                  {sortHead('published_at', 'Source date')}
                  {sortHead('collected_at', 'Collected')}
                </tr>
              </THead>
              <tbody>
                {items.map((f) => (
                  <TR key={f.id} className={cn('cursor-pointer', selected === f.id && 'bg-accent-soft/40')} onClick={() => setSelected(f.id)}>
                    <TD className="max-w-[520px]">
                      <button type="button" className="text-left" onClick={() => setSelected(f.id)}>
                        <span className="flex items-start gap-2">
                          {f.entity?.type ? <EntityIcon type={f.entity.type} className="mt-0.5 text-subtle" /> : null}
                          <span className="font-medium text-fg">{f.title}</span>
                          {f.bookmarked ? <Bookmark className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-accent text-accent" aria-label="Bookmarked" /> : null}
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5 pl-6">
                          {f.isSimulated ? <SimulatedBadge /> : null}
                          <CategoryBadge category={f.category} />
                          {f.tags?.map((t) => (
                            <Badge key={t.name} tone="accent">
                              {t.name}
                            </Badge>
                          ))}
                          <span className="text-[11px] text-subtle">{(f.providers ?? []).join(', ')}</span>
                        </span>
                      </button>
                    </TD>
                    <TD><ClaimTypeBadge type={f.claimType} /></TD>
                    <TD><ConfidenceBadge level={f.confidence} rationale={f.confidenceRationale} score={f.confidenceScore} /></TD>
                    <TD><VerificationBadge status={f.verificationStatus} /></TD>
                    <TD className="tabular text-right">{f.providerCount > 1 ? <Badge tone="accent">{f.providerCount} providers</Badge> : f.sourceCount}</TD>
                    <TD className="whitespace-nowrap text-xs text-muted">{formatPrecisionDate(f.publishedAt, f.publishedPrecision)}</TD>
                    <TD className="whitespace-nowrap text-xs text-muted">{formatDate(f.collectedAt)}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
          <ul className="space-y-2 md:hidden" data-testid="findings-cards">
            {items.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => setSelected(f.id)} className="w-full rounded-xl border border-border bg-surface p-3.5 text-left">
                  <p className="text-sm font-medium text-fg">{f.title}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {f.isSimulated ? <SimulatedBadge /> : null}
                    <ClaimTypeBadge type={f.claimType} />
                    <ConfidenceBadge level={f.confidence} />
                    <VerificationBadge status={f.verificationStatus} />
                  </div>
                  <p className="mt-2 text-[11px] text-muted">
                    {(f.providers ?? []).join(', ')} · {formatPrecisionDate(f.publishedAt, f.publishedPrecision)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2">
            <Select aria-label="Rows per page" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} className="h-8 w-24 text-xs">
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n} / page
                </option>
              ))}
            </Select>
            <Pagination page={page} pageSize={pageSize} total={query.data?.total ?? 0} onPage={setPage} />
          </div>
        </>
      )}
      <FindingDetailSheet investigationId={investigationId} findingId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
