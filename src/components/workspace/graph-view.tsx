'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Core, ElementDefinition } from 'cytoscape';
import { Expand, List, Network, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Select, Textarea } from '@/components/ui/field';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ConfidenceBadge, EntityIcon, ENTITY_COLORS, SimulatedBadge } from '@/components/domain/badges';
import { api, qs } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { ENTITY_LABELS, RELATIONSHIP_TYPES } from '@/shared/domain';
import { useInvestigation, liveInterval } from './use-investigation';

interface GraphNode {
  id: string;
  type: string;
  label: string;
  value: string;
  isTarget: boolean;
  isSimulated: boolean;
  clusterId: string | null;
  degree: number;
  findingCount: number;
}
interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  status: string;
  confidence: string;
  rationale: string | null;
  evidenceCount: number;
  isSimulated: boolean;
}
interface RelDetail extends Omit<GraphEdge, 'source' | 'target'> {
  from: { id: string; type: string; display: string };
  to: { id: string; type: string; display: string };
  firstSeenAt: string;
  evidence: Array<{ id: string; kind: string; title: string; content: string; source_url: string | null; collected_at: string; sha256: string }>;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

function RelationshipPanel({ investigationId, relId, onChanged }: { investigationId: string; relId: string; onChanged: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [rationale, setRationale] = useState('');
  const q = useQuery({ queryKey: ['relationship', relId], queryFn: () => api.get<RelDetail>(`/api/investigations/${investigationId}/relationships/${relId}`) });
  const r = q.data;
  if (!r) return <Skeleton className="h-40" />;
  async function save() {
    try {
      await api.patch(`/api/investigations/${investigationId}/relationships/${relId}`, { status, rationale });
      toast({ tone: 'success', title: 'Relationship updated' });
      setRationale('');
      await q.refetch();
      onChanged();
    } catch (e) {
      toast({ tone: 'error', title: 'Update failed', description: (e as Error).message });
    }
  }
  return (
    <div className="space-y-3 text-sm" data-testid="relationship-panel">
      <p className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
        <span className="text-fg">{r.from.display}</span>
        <Badge tone={r.status === 'confirmed' ? 'info' : 'neutral'} className={cn(r.status === 'possible' && 'border-dashed')}>
          {r.type}
        </Badge>
        <span className="text-fg">{r.to.display}</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        <Badge>{r.status}</Badge>
        <ConfidenceBadge level={r.confidence} />
        {r.isSimulated ? <SimulatedBadge /> : null}
      </div>
      <p className="text-xs text-muted">{r.rationale}</p>
      <p className="text-xs text-subtle">First observed {formatDate(r.firstSeenAt, { time: true })}</p>
      <div>
        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Supporting evidence ({r.evidence.length})</p>
        <ul className="space-y-1.5">
          {r.evidence.map((e) => (
            <li key={e.id} className="rounded-md border border-border px-2 py-1.5 text-xs">
              <p className="font-medium text-fg">{e.title}</p>
              <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted">{e.content}</pre>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2 rounded-lg border border-border p-2.5">
        <Field label="Analyst decision" htmlFor="rel-status">
          <Select id="rel-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Choose…</option>
            <option value="confirmed">Confirm relationship</option>
            <option value="possible">Mark as possible only</option>
            <option value="rejected">Reject relationship</option>
          </Select>
        </Field>
        <Textarea value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder="Rationale (min. 10 characters)" aria-label="Relationship rationale" />
        <Button size="sm" variant="primary" disabled={!status || rationale.trim().length < 10} onClick={() => void save()}>
          Save decision
        </Button>
      </div>
    </div>
  );
}

export function GraphView({ investigationId }: { investigationId: string }) {
  const { data: inv } = useInvestigation(investigationId);
  const qc = useQueryClient();
  const container = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [relTypes, setRelTypes] = useState<string[]>([]);
  const [includePossible, setIncludePossible] = useState(true);
  const [selection, setSelection] = useState<{ kind: 'node'; id: string } | { kind: 'edge'; id: string } | null>(null);
  const [view, setView] = useState<'graph' | 'list'>(() => (typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'graph'));
  const q = useQuery({
    queryKey: ['graph', investigationId, relTypes, includePossible],
    queryFn: () => api.get<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }>(`/api/investigations/${investigationId}/graph${qs({ relTypes: relTypes.join(','), includePossible })}`),
    refetchInterval: () => liveInterval(inv?.status, 6000),
  });
  const data = q.data;
  const nodeById = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);

  useEffect(() => {
    if (view !== 'graph' || !container.current || !data) return;
    let disposed = false;
    void import('cytoscape').then(({ default: cytoscape }) => {
      if (disposed || !container.current) return;
      const elements: ElementDefinition[] = [
        ...data.nodes.map((n) => ({ data: { id: n.id, label: n.label.length > 32 ? n.label.slice(0, 31) + '…' : n.label, type: n.type, target: n.isTarget ? 1 : 0, sim: n.isSimulated ? 1 : 0, size: n.isTarget ? 34 : Math.min(28, 14 + n.degree * 1.5) } })),
        ...data.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, label: e.type, status: e.status } })),
      ];
      const fg = cssVar('--fg');
      const muted = cssVar('--muted');
      const border = cssVar('--border-strong');
      const accent = cssVar('--accent');
      const surface = cssVar('--surface');
      cyRef.current?.destroy();
      const cy = cytoscape({
        container: container.current,
        elements,
        minZoom: 0.15,
        maxZoom: 3,
        wheelSensitivity: 0.3,
        style: [
          {
            selector: 'node',
            style: {
              'background-color': (ele: { data: (k: string) => string }) => ENTITY_COLORS[ele.data('type')] ?? '#94a3b8',
              width: 'data(size)',
              height: 'data(size)',
              label: 'data(label)',
              color: fg,
              'font-size': 9,
              'text-valign': 'bottom',
              'text-margin-y': 4,
              'text-outline-color': surface,
              'text-outline-width': 2,
              'border-width': 2,
              'border-color': surface,
            },
          },
          { selector: 'node[target = 1]', style: { 'border-color': accent, 'border-width': 3, 'font-weight': 'bold', 'font-size': 10 } },
          { selector: 'node[sim = 1]', style: { 'border-style': 'dashed' } },
          {
            selector: 'edge',
            style: { width: 1.5, 'line-color': border, 'target-arrow-color': border, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.8, 'curve-style': 'bezier', label: '', 'font-size': 8, color: muted },
          },
          { selector: 'edge[status = "possible"]', style: { 'line-style': 'dashed' } },
          { selector: ':selected', style: { 'border-color': accent, 'line-color': accent, 'target-arrow-color': accent, 'border-width': 4 } },
          { selector: 'edge:selected', style: { label: 'data(label)', width: 2.5 } },
          { selector: '.faded', style: { opacity: 0.15 } },
        ],
        layout: { name: data.nodes.length > 250 ? 'concentric' : 'cose', animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 70, padding: 30 } as cytoscape.LayoutOptions,
      });
      cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        setSelection({ kind: 'node', id: node.id() });
        cy.elements().addClass('faded');
        node.closedNeighborhood().removeClass('faded');
      });
      cy.on('tap', 'edge', (evt) => {
        setSelection({ kind: 'edge', id: evt.target.id() });
        cy.elements().removeClass('faded');
      });
      cy.on('tap', (evt) => {
        if (evt.target === cy) {
          setSelection(null);
          cy.elements().removeClass('faded');
        }
      });
      cyRef.current = cy;
    });
    return () => {
      disposed = true;
    };
  }, [data, view]);

  useEffect(() => () => cyRef.current?.destroy(), []);

  const selectedNode = selection?.kind === 'node' ? nodeById.get(selection.id) : null;
  const neighbours = selectedNode ? (data?.edges ?? []).filter((e) => e.source === selectedNode.id || e.target === selectedNode.id) : [];

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="flex flex-wrap items-center gap-2 py-3">
          <div className="flex rounded-md border border-border p-0.5">
            <Button size="sm" variant={view === 'graph' ? 'secondary' : 'ghost'} onClick={() => setView('graph')} aria-pressed={view === 'graph'}>
              <Network className="h-3.5 w-3.5" /> Graph
            </Button>
            <Button size="sm" variant={view === 'list' ? 'secondary' : 'ghost'} onClick={() => setView('list')} aria-pressed={view === 'list'}>
              <List className="h-3.5 w-3.5" /> Connections list
            </Button>
          </div>
          <details className="relative">
            <summary className="flex h-8 cursor-pointer items-center rounded-md border border-border px-3 text-xs font-medium">Relationship types{relTypes.length ? ` (${relTypes.length})` : ''}</summary>
            <div className="absolute z-20 mt-1 grid w-56 gap-1 rounded-lg border border-border bg-elevated p-2 shadow-xl">
              {RELATIONSHIP_TYPES.map((t) => (
                <label key={t} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={relTypes.includes(t)} onChange={(e) => setRelTypes((r) => (e.target.checked ? [...r, t] : r.filter((x) => x !== t)))} className="accent-[var(--accent)]" />
                  <span className="font-mono">{t}</span>
                </label>
              ))}
              <p className="text-[11px] text-subtle">None selected = all types.</p>
            </div>
          </details>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={includePossible} onChange={(e) => setIncludePossible(e.target.checked)} className="accent-[var(--accent)]" /> Show possible (dashed) relationships
          </label>
          {view === 'graph' ? (
            <div className="ml-auto flex gap-1">
              <Button size="icon-sm" variant="ghost" aria-label="Zoom in" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.25)}>
                <ZoomIn className="h-4 w-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Zoom out" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() / 1.25)}>
                <ZoomOut className="h-4 w-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Fit graph" onClick={() => cyRef.current?.fit(undefined, 30)}>
                <Expand className="h-4 w-4" />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="Re-layout" onClick={() => cyRef.current?.layout({ name: 'cose', animate: true } as cytoscape.LayoutOptions).run()}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : null}
      {q.isLoading ? (
        <Skeleton className="h-[560px] w-full" />
      ) : !data?.nodes.length ? (
        <EmptyState icon={<Network />} title="No relationships yet" description="Relationships are built from collected evidence: DNS resolutions, profile links, mentions, registrations and analyst-confirmed matches." />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
          {view === 'graph' ? (
            <Card className="relative overflow-hidden">
              <div ref={container} className="h-[min(70dvh,640px)] w-full touch-none" data-testid="graph-canvas" role="img" aria-label={`Relationship graph with ${data.nodes.length} entities and ${data.edges.length} relationships. Use the connections list for a text alternative.`} />
              <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[90%] flex-wrap gap-1.5 rounded-md bg-surface/90 p-1.5 text-[10px] text-muted">
                {[...new Set(data.nodes.map((n) => n.type))].map((t) => (
                  <span key={t} className="inline-flex items-center gap-1">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: ENTITY_COLORS[t] ?? '#94a3b8' }} />
                    {ENTITY_LABELS[t as keyof typeof ENTITY_LABELS] ?? t}
                  </span>
                ))}
                <span>· solid = confirmed · dashed = possible · blue ring = target</span>
              </div>
              {data.truncated ? <p className="absolute right-2 top-2 rounded bg-warning-soft px-2 py-1 text-[11px] text-warning">Showing most-connected entities only</p> : null}
            </Card>
          ) : (
            <Card>
              <CardHeader title="Connections" description={`${data.edges.length} relationships between ${data.nodes.length} entities`} />
              <ul className="max-h-[70dvh] divide-y divide-border overflow-y-auto" data-testid="graph-list">
                {data.edges.map((e) => {
                  const a = nodeById.get(e.source);
                  const b = nodeById.get(e.target);
                  return (
                    <li key={e.id}>
                      <button type="button" onClick={() => setSelection({ kind: 'edge', id: e.id })} className="flex w-full flex-col gap-1 px-4 py-2.5 text-left text-xs hover:bg-surface-2/60">
                        <span className="flex items-center gap-1.5">
                          {a ? <EntityIcon type={a.type} className="h-3.5 w-3.5 text-subtle" /> : null}
                          <span className="truncate font-mono text-fg">{a?.label}</span>
                        </span>
                        <span className="flex items-center gap-1.5 pl-5">
                          <Badge tone={e.status === 'confirmed' ? 'info' : 'neutral'} className={cn(e.status === 'possible' && 'border-dashed')}>
                            {e.type}
                          </Badge>
                          {b ? <EntityIcon type={b.type} className="h-3.5 w-3.5 text-subtle" /> : null}
                          <span className="truncate font-mono text-fg">{b?.label}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
          <Card className="xl:sticky xl:top-20 xl:self-start">
            <CardHeader title={selection ? (selection.kind === 'node' ? 'Entity' : 'Relationship') : 'Details'} />
            <CardBody>
              {!selection ? (
                <p className="text-sm text-muted">Select a node or relationship to inspect its evidence. Drag to pan, pinch or scroll to zoom.</p>
              ) : selection.kind === 'node' && selectedNode ? (
                <div className="space-y-3 text-sm" data-testid="node-panel">
                  <p className="flex items-center gap-2 font-mono text-fg">
                    <EntityIcon type={selectedNode.type} /> <span className="break-all">{selectedNode.label}</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge>{ENTITY_LABELS[selectedNode.type as keyof typeof ENTITY_LABELS] ?? selectedNode.type}</Badge>
                    {selectedNode.isTarget ? <Badge tone="accent">Target</Badge> : null}
                    {selectedNode.isSimulated ? <SimulatedBadge /> : null}
                    <Badge>{selectedNode.findingCount} findings</Badge>
                  </div>
                  <ul className="space-y-1 text-xs">
                    {neighbours.map((e) => {
                      const other = nodeById.get(e.source === selectedNode.id ? e.target : e.source);
                      return (
                        <li key={e.id}>
                          <button type="button" className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-surface-2" onClick={() => setSelection({ kind: 'edge', id: e.id })}>
                            <Badge className={cn(e.status === 'possible' && 'border-dashed')}>{e.source === selectedNode.id ? e.type : `← ${e.type}`}</Badge>
                            <span className="truncate font-mono">{other?.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <a href={`/investigations/${investigationId}/findings?focus=`} className="hidden" />
                </div>
              ) : selection.kind === 'edge' ? (
                <RelationshipPanel investigationId={investigationId} relId={selection.id} onChanged={() => void qc.invalidateQueries({ queryKey: ['graph', investigationId] })} />
              ) : null}
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
