'use client';
import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Table, THead, TH, TR, TD } from '@/components/ui/table';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfidenceBadge, GeoPrecisionBadge, SimulatedBadge, ClaimTypeBadge } from '@/components/domain/badges';
import { api } from '@/lib/api';
import { GEO_PRECISION_LABELS, GEO_PRECISIONS } from '@/shared/domain';
import { FindingDetailSheet } from './finding-detail';
import { useInvestigation, liveInterval } from './use-investigation';
import type { FindingItem } from './types';

const GeoMap = dynamic(() => import('./geo-map').then((m) => m.GeoMap), { ssr: false, loading: () => <Skeleton className="h-[560px] w-full" /> });

export function GeointView({ investigationId }: { investigationId: string }) {
  const { data: inv } = useInvestigation(investigationId);
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['geo', investigationId],
    queryFn: () => api.get<{ items: FindingItem[]; tileUrl: string | null }>(`/api/investigations/${investigationId}/geo`),
    refetchInterval: () => liveInterval(inv?.status, 6000),
  });
  const onSelect = useCallback((id: string) => setSelected(id), []);
  const items = q.data?.items ?? [];
  const tileUrl = q.data?.tileUrl || process.env.NEXT_PUBLIC_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-muted">
        Every location carries its source, precision and basis. Circles show the stated uncertainty: country, region, city, approximate area, or exact coordinates. IP-derived locations describe networks, not people; embedded EXIF coordinates are claims made by the file.
      </p>
      <div className="flex flex-wrap gap-2 text-xs">
        {GEO_PRECISIONS.map((p) => (
          <span key={p} className="inline-flex items-center gap-1.5">
            <GeoPrecisionBadge precision={p} /> <span className="text-muted">{items.filter((i) => i.geo?.precision === p).length}</span>
          </span>
        ))}
      </div>
      {q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : null}
      {q.isLoading ? <Skeleton className="h-[560px] w-full" /> : !items.length ? (
        <EmptyState icon={<MapPin />} title="No geographic findings" description="Locations come from self-reported profile locations, IP network data, document place names and image EXIF GPS." />
      ) : (
        <>
          <GeoMap items={items} tileUrl={tileUrl} onSelect={onSelect} />
          <Card className="overflow-hidden">
            <CardHeader title="Geographic findings" description={`${items.length} location(s)`} />
            <Table data-testid="geo-table">
              <THead>
                <tr>
                  <TH>Place</TH>
                  <TH>Precision</TH>
                  <TH>Basis</TH>
                  <TH>Claim</TH>
                  <TH>Confidence</TH>
                  <TH>Finding</TH>
                </tr>
              </THead>
              <tbody>
                {items.map((f) => (
                  <TR key={f.id} className="cursor-pointer" onClick={() => setSelected(f.id)}>
                    <TD className="whitespace-nowrap">
                      <span className="font-medium">{f.geo?.place ?? `${f.geo?.lat?.toFixed(4)}, ${f.geo?.lon?.toFixed(4)}`}</span>
                      {f.geo?.country ? <span className="ml-1 text-xs text-muted">({f.geo.country})</span> : null}
                    </TD>
                    <TD title={GEO_PRECISION_LABELS[f.geo?.precision as keyof typeof GEO_PRECISION_LABELS]}>
                      <GeoPrecisionBadge precision={f.geo?.precision ?? 'country'} />
                    </TD>
                    <TD className="max-w-xs text-xs text-muted">{f.geo?.basis}</TD>
                    <TD><ClaimTypeBadge type={f.claimType} /></TD>
                    <TD><ConfidenceBadge level={f.confidence} /></TD>
                    <TD className="max-w-sm text-xs">
                      {f.isSimulated ? <SimulatedBadge className="mr-1" /> : null}
                      {f.title}
                    </TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
      <FindingDetailSheet investigationId={investigationId} findingId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
