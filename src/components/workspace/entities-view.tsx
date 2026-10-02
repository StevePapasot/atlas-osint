'use client';
import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, GitMerge, Search, Split, ThumbsDown, ThumbsUp } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input, Select, Textarea, Field } from '@/components/ui/field';
import { Dialog, Sheet } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ConfidenceBadge, EntityIcon, EntityTypeLabel, SimulatedBadge, StatusBadge } from '@/components/domain/badges';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, titleCase } from '@/lib/format';
import { ENTITY_LABELS, ENTITY_TYPES } from '@/shared/domain';
import { useInvestigation, liveInterval } from './use-investigation';
import { SafeLink } from './finding-detail';

interface EntityItem {
  id: string;
  type: string;
  value: string;
  display: string;
  attributes: Record<string, unknown>;
  isTarget: boolean;
  isSimulated: boolean;
  clusterId: string | null;
  findingCount: number;
  relationshipCount: number;
}

interface Candidate {
  id: string;
  strength: 'strong' | 'moderate' | 'weak';
  status: string;
  signals: Array<{ signal: string; weight: string; detail: string }>;
  decidedAt: string | null;
  decidedBy: string | null;
  a: { id: string; display: string; type: string; attributes: Record<string, unknown> };
  b: { id: string; display: string; type: string; attributes: Record<string, unknown> };
}

interface RelationshipItem {
  id: string;
  type: string;
  status: string;
  confidence: string;
  rationale: string | null;
  evidenceCount: number;
  from: { id: string; type: string; display: string };
  to: { id: string; type: string; display: string };
}

const STRENGTH_TONE = { strong: 'success', moderate: 'warning', weak: 'neutral' } as const;
const ATTR_KEYS = ['platform', 'username', 'displayName', 'bio', 'website', 'location', 'profileUrl', 'created'];

function AttrTable({ attrs }: { attrs: Record<string, unknown> }) {
  const entries = Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object');
  if (!entries.length) return <p className="text-xs text-muted">No attributes.</p>;
  return (
    <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs">
      {entries.slice(0, 20).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{titleCase(k.replace(/([A-Z])/g, ' $1'))}</dt>
          <dd className="break-all text-fg">{typeof v === 'string' && /^https?:\/\//.test(v) ? <SafeLink href={v}>{v}</SafeLink> : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function EntitySheet({ investigationId, entityId, onClose }: { investigationId: string; entityId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['entity', entityId],
    queryFn: () => api.get<EntityItem & { relationships: RelationshipItem[]; findings: Array<{ id: string; title: string; confidence: string }>; firstSeenAt: string }>(`/api/investigations/${investigationId}/entities/${entityId}`),
    enabled: Boolean(entityId),
  });
  const e = q.data;
  return (
    <Sheet open={Boolean(entityId)} onOpenChange={(o) => !o && onClose()} title={e?.display ?? 'Entity'} description={e ? `${ENTITY_LABELS[e.type as keyof typeof ENTITY_LABELS] ?? e.type} · first seen ${formatDate(e.firstSeenAt)}` : undefined}>
      {q.isLoading ? <SkeletonRows /> : e ? (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap gap-1.5">
            {e.isTarget ? <Badge tone="accent">Investigation target</Badge> : null}
            {e.isSimulated ? <SimulatedBadge /> : null}
            {e.clusterId ? <Badge tone="success">Analyst-confirmed cluster</Badge> : null}
          </div>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Attributes</h3>
            <AttrTable attrs={e.attributes} />
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Relationships ({e.relationships.length})</h3>
            <ul className="space-y-1.5">
              {e.relationships.map((r) => {
                const outgoing = r.from.id === e.id;
                const other = outgoing ? r.to : r.from;
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                    <Badge tone={r.status === 'confirmed' ? 'info' : 'neutral'} className={cn(r.status === 'possible' && 'border-dashed')}>
                      {outgoing ? r.type : `← ${r.type}`}
                    </Badge>
                    <EntityIcon type={other.type} className="h-3.5 w-3.5 text-subtle" />
                    <span className="min-w-0 flex-1 truncate font-mono text-fg">{other.display}</span>
                    <span className="text-muted">{r.status}</span>
                    <span className="w-full pl-1 text-subtle">{r.rationale}</span>
                  </li>
                );
              })}
            </ul>
          </section>
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Findings ({e.findings.length})</h3>
            <ul className="space-y-1 text-xs">
              {e.findings.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2">
                  <a href={`/investigations/${investigationId}/findings?focus=${f.id}`} className="truncate text-accent hover:underline">
                    {f.title}
                  </a>
                  <ConfidenceBadge level={f.confidence} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}

function Matches({ investigationId }: { investigationId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState('pending');
  const [decision, setDecision] = useState<{ c: Candidate; action: 'accept' | 'reject' | 'separate' } | null>(null);
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const q = useQuery({ queryKey: ['candidates', investigationId, status], queryFn: () => api.get<{ items: Candidate[] }>(`/api/investigations/${investigationId}/candidates${qs({ status })}`) });

  async function decide() {
    if (!decision) return;
    setSaving(true);
    try {
      await api.post(`/api/investigations/${investigationId}/candidates/${decision.c.id}`, { decision: decision.action, rationale });
      toast({ tone: 'success', title: decision.action === 'accept' ? 'Match accepted' : decision.action === 'reject' ? 'Match rejected' : 'Entities separated' });
      setDecision(null);
      setRationale('');
      await qc.invalidateQueries({ queryKey: ['candidates', investigationId] });
      await qc.invalidateQueries({ queryKey: ['investigation', investigationId] });
      await qc.invalidateQueries({ queryKey: ['graph', investigationId] });
    } catch (e) {
      toast({ tone: 'error', title: 'Decision not saved', description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted">
          Candidate identity matches between accounts. A shared username alone is weak evidence; ATLAS never merges identities automatically. Accepting records an analyst-confirmed <span className="font-mono">SIMILAR_TO</span> link; separating reverses it.
        </p>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40" aria-label="Candidate status">
          {['pending', 'accepted', 'rejected', 'separated'].map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
      </div>
      {q.isLoading ? <SkeletonRows /> : !q.data?.items.length ? (
        <EmptyState icon={<GitMerge />} title={`No ${status} matches`} description="Candidates are generated after collection from shared websites, emails, display names, biographies and usernames." />
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2" data-testid="candidates">
          {q.data.items.map((c) => (
            <li key={c.id}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={STRENGTH_TONE[c.strength]}>{titleCase(c.strength)} signals</Badge>
                    <StatusBadge status={c.status} />
                    {c.decidedBy ? <span className="text-xs text-muted">by {c.decidedBy} · {formatDate(c.decidedAt)}</span> : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[c.a, c.b].map((side) => (
                      <div key={side.id} className="rounded-lg border border-border p-2.5">
                        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-fg">
                          <EntityIcon type={side.type} className="h-3.5 w-3.5" /> {side.display}
                        </p>
                        <AttrTable attrs={Object.fromEntries(ATTR_KEYS.map((k) => [k, side.attributes[k]]))} />
                      </div>
                    ))}
                  </div>
                  <ul className="space-y-1 text-xs">
                    {c.signals.map((s) => (
                      <li key={s.signal} className="flex items-start gap-2">
                        <Badge tone={s.weight === 'strong' ? 'success' : s.weight === 'moderate' ? 'warning' : 'neutral'}>{s.weight}</Badge>
                        <span className="text-muted">{s.detail}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap justify-end gap-2">
                    {c.status === 'pending' ? (
                      <>
                        <Button size="sm" variant="danger-outline" onClick={() => setDecision({ c, action: 'reject' })}>
                          <ThumbsDown className="h-3.5 w-3.5" /> Reject
                        </Button>
                        <Button size="sm" variant="primary" onClick={() => setDecision({ c, action: 'accept' })}>
                          <ThumbsUp className="h-3.5 w-3.5" /> Accept match
                        </Button>
                      </>
                    ) : c.status === 'accepted' ? (
                      <Button size="sm" onClick={() => setDecision({ c, action: 'separate' })}>
                        <Split className="h-3.5 w-3.5" /> Separate
                      </Button>
                    ) : null}
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(decision)}
        onOpenChange={(o) => !o && setDecision(null)}
        title={decision?.action === 'accept' ? 'Accept identity match' : decision?.action === 'reject' ? 'Reject identity match' : 'Separate entities'}
        description={decision ? `${decision.c.a.display} ↔ ${decision.c.b.display}` : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDecision(null)}>
              Cancel
            </Button>
            <Button variant={decision?.action === 'accept' ? 'primary' : 'danger'} loading={saving} disabled={rationale.trim().length < 10} onClick={() => void decide()}>
              Confirm
            </Button>
          </>
        }
      >
        <Field label="Rationale (recorded in the audit trail)" htmlFor="match-rationale" hint="At least 10 characters. Cite the evidence you relied on.">
          <Textarea id="match-rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} rows={3} />
        </Field>
      </Dialog>
    </div>
  );
}

export function EntitiesView({ investigationId }: { investigationId: string }) {
  const params = useSearchParams();
  const { data: inv } = useInvestigation(investigationId);
  const [tab, setTab] = useState(params.get('tab') === 'matches' ? 'matches' : 'entities');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ['entities', investigationId, type, q],
    queryFn: () => api.get<{ items: EntityItem[] }>(`/api/investigations/${investigationId}/entities${qs({ type, q })}`),
    refetchInterval: () => liveInterval(inv?.status, 5000),
  });
  const items = list.data?.items ?? [];
  const counts = items.reduce<Record<string, number>>((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg border border-border bg-surface p-1 sm:w-fit" role="tablist">
        {[
          ['entities', `Entities (${items.length})`],
          ['matches', `Possible matches${inv?.counts.pendingCandidates ? ` (${inv.counts.pendingCandidates})` : ''}`],
        ].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k!)} className={cn('flex-1 rounded-md px-3 py-1.5 text-sm font-medium sm:flex-none', tab === k ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg')}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'matches' ? (
        <Matches investigationId={investigationId} />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search entities" className="pl-9" aria-label="Search entities" />
            </div>
            <Select value={type} onChange={(e) => setType(e.target.value)} className="sm:w-52" aria-label="Entity type">
              <option value="">All types</option>
              {ENTITY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ENTITY_LABELS[t]}
                </option>
              ))}
            </Select>
          </div>
          {!type && Object.keys(counts).length ? (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => (
                <button key={t} type="button" onClick={() => setType(t)} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs hover:border-border-strong">
                  <EntityIcon type={t} className="h-3.5 w-3.5 text-subtle" /> {ENTITY_LABELS[t as keyof typeof ENTITY_LABELS] ?? t} <span className="tabular text-muted">{n}</span>
                </button>
              ))}
            </div>
          ) : null}
          {list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : null}
          {list.isLoading ? <SkeletonRows /> : !items.length ? (
            <EmptyState icon={<Boxes />} title="No entities" description="Entities are created from targets and from evidence collected by providers." />
          ) : (
            <Card>
              <CardHeader title="Entities" description="Click an entity to see its relationships and supporting findings." />
              <ul className="divide-y divide-border" data-testid="entities-list">
                {items.map((e) => (
                  <li key={e.id}>
                    <button type="button" onClick={() => setSelected(e.id)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-surface-2/60 sm:px-5">
                      <EntityTypeLabel type={e.type} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{e.display}</span>
                      {e.isTarget ? <Badge tone="accent">Target</Badge> : null}
                      {e.isSimulated ? <SimulatedBadge /> : null}
                      <span className="tabular text-xs text-muted">
                        {e.findingCount} findings · {e.relationshipCount} links
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <EntitySheet investigationId={investigationId} entityId={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
