'use client';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { FindingsTable } from './findings-table';
import { useInvestigation } from './use-investigation';

interface P {
  id: string;
  name: string;
  kind: string;
  category: string;
  description: string;
  usable: boolean;
  userEnabled: boolean;
  limitations: string[];
  status: { missing: string[] };
}

export function DarkwebView({ investigationId }: { investigationId: string }) {
  const { data: inv } = useInvestigation(investigationId);
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api.get<{ items: P[] }>('/api/providers') });
  const dw = (providers.data?.items ?? []).filter((p) => p.category === 'darkweb' || p.id === 'demo.darkweb');
  const live = dw.filter((p) => p.kind === 'live');
  const anyLive = live.some((p) => p.usable && p.userEnabled);
  const moduleOn = inv?.effectiveModules.includes('darkweb');
  return (
    <div className="space-y-6">
      <Card className="border-warning/40">
        <CardHeader icon={<ShieldAlert className="h-4 w-4 text-warning" />} title="Dark-web research — scope and limits" />
        <CardBody className="space-y-2 text-sm text-muted">
          <p>ATLAS only queries lawful, clearnet-accessible research indexes that you configure. It never connects to onion services, routes traffic through Tor, fetches arbitrary onion URLs, purchases data, tests credentials or interacts with marketplaces. Only result metadata is stored.</p>
          <p>Coverage is inherently partial and volatile. Mentions are unverified leads with low source reliability; absence of results is not evidence of absence.</p>
          {!moduleOn ? <p className="text-fg">The dark-web module is not enabled for this investigation (it runs at Deep depth or when selected in Custom depth).</p> : null}
          {!anyLive && inv?.mode === 'live' ? (
            <p className="text-fg">
              No dark-web provider is configured, so no dark-web sources were queried. The rest of the investigation is unaffected.{' '}
              <Link href="/settings?section=providers" className="font-medium text-accent hover:underline">
                Configure providers
              </Link>
            </p>
          ) : null}
        </CardBody>
      </Card>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {dw.map((p) => (
          <Card key={p.id} className="p-4">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{p.name}</p>
              {p.kind === 'simulated' ? <Badge tone="simulated">Demo</Badge> : p.usable ? <Badge tone="success">Configured</Badge> : <Badge>Not configured</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted">{p.description}</p>
            {!p.usable && p.status.missing.length ? <p className="mt-2 font-mono text-[11px] text-subtle">Requires {p.status.missing.join(', ')}</p> : null}
          </Card>
        ))}
      </div>
      <FindingsTable investigationId={investigationId} preset={{ category: 'darkweb' }} title="Dark-web source findings" />
    </div>
  );
}
