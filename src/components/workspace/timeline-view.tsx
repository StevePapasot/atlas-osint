'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/field';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ConfidenceBadge, EntityIcon, SimulatedBadge } from '@/components/domain/badges';
import { api, qs } from '@/lib/api';
import { formatPrecisionDate, titleCase } from '@/lib/format';
import { SafeLink } from './finding-detail';
import { useInvestigation, liveInterval } from './use-investigation';

interface TimelineItem {
  id: string;
  date: string | null;
  precision: string;
  kind: string;
  label: string;
  sourceUrl: string | null;
  providerName: string | null;
  isSimulated: boolean;
  entity: { id: string; display: string; type: string } | null;
  finding: { id: string; confidence: string; title: string } | null;
}

const KIND_TONE: Record<string, 'info' | 'violet' | 'accent' | 'neutral'> = { registration: 'violet', source_published: 'info', event: 'accent', observed: 'neutral' };
const KIND_LABEL: Record<string, string> = { registration: 'Registration', source_published: 'Source published', event: 'Event', observed: 'Observed' };

export function TimelineView({ investigationId }: { investigationId: string }) {
  const { data: inv } = useInvestigation(investigationId);
  const [kind, setKind] = useState('');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const q = useQuery({
    queryKey: ['timeline', investigationId, kind],
    queryFn: () => api.get<{ items: TimelineItem[] }>(`/api/investigations/${investigationId}/timeline${qs({ kind })}`),
    refetchInterval: () => liveInterval(inv?.status, 5000),
  });
  const groups = useMemo(() => {
    const items = [...(q.data?.items ?? [])].filter((i) => i.date).sort((a, b) => (order === 'asc' ? a.date!.localeCompare(b.date!) : b.date!.localeCompare(a.date!)));
    const m = new Map<string, TimelineItem[]>();
    for (const i of items) {
      const y = i.date!.slice(0, 4);
      m.set(y, [...(m.get(y) ?? []), i]);
    }
    return [...m.entries()];
  }, [q.data, order]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">Dates stated by sources or file metadata. Collection times are never shown as event dates, and ATLAS never invents dates — precision is shown for every entry.</p>
        <div className="flex gap-2">
          <Select aria-label="Event kind" value={kind} onChange={(e) => setKind(e.target.value)} className="w-44">
            <option value="">All event kinds</option>
            {Object.entries(KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select aria-label="Sort order" value={order} onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')} className="w-36">
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </Select>
        </div>
      </div>
      {q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : null}
      {q.isLoading ? <SkeletonRows /> : !groups.length ? (
        <EmptyState icon={<CalendarClock />} title="No dated events" description="Events appear when sources state dates: registrations, account creation, publications, certificates, EXIF capture times, breach dates." />
      ) : (
        <div className="space-y-6" data-testid="timeline">
          {groups.map(([year, items]) => (
            <section key={year}>
              <h2 className="sticky top-14 z-10 mb-2 bg-bg/90 py-1 text-sm font-semibold text-fg backdrop-blur">{year}</h2>
              <ol className="relative space-y-3 border-l border-border pl-5">
                {items.map((i) => (
                  <li key={i.id} className="relative">
                    <span className="absolute -left-[25px] top-3 h-2.5 w-2.5 rounded-full border-2 border-bg bg-accent" aria-hidden />
                    <Card className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="tabular text-xs font-medium text-fg">{formatPrecisionDate(i.date, i.precision)}</span>
                        <Badge tone={KIND_TONE[i.kind] ?? 'neutral'}>{KIND_LABEL[i.kind] ?? titleCase(i.kind)}</Badge>
                        {i.precision !== 'exact' && i.precision !== 'day' ? <Badge tone="warning">{titleCase(i.precision)} precision</Badge> : null}
                        {i.isSimulated ? <SimulatedBadge /> : null}
                        {i.finding ? <span className="ml-auto"><ConfidenceBadge level={i.finding.confidence} /></span> : null}
                      </div>
                      <p className="mt-1.5 text-sm text-fg">{i.label}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        {i.entity ? (
                          <span className="inline-flex items-center gap-1">
                            <EntityIcon type={i.entity.type} className="h-3.5 w-3.5" /> <span className="font-mono">{i.entity.display}</span>
                          </span>
                        ) : null}
                        {i.providerName ? <span>via {i.providerName}</span> : null}
                        {i.sourceUrl ? <SafeLink href={i.sourceUrl}>source</SafeLink> : null}
                        {i.finding ? (
                          <a className="text-accent hover:underline" href={`/investigations/${investigationId}/findings?focus=${i.finding.id}`}>
                            evidence
                          </a>
                        ) : null}
                      </div>
                    </Card>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
