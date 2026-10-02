'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, FileDown, FileText, Sparkles, Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { EmptyState } from '@/components/ui/empty-state';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useInvestigation } from './use-investigation';

interface ReportItem {
  id: string;
  title: string;
  options: { redact?: boolean; includeAi?: boolean };
  createdAt: string;
  createdBy: string;
}
interface AiResult {
  model: string;
  generatedAt: string;
  summary: Array<{ text: string; findingRefs: string[] }>;
  hypotheses: Array<{ text: string; findingRefs: string[] }>;
  contradictions: Array<{ text: string; findingRefs: string[] }>;
  followUps: string[];
  rejectedStatements: number;
}

function AiPanel({ investigationId }: { investigationId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const q = useQuery({ queryKey: ['ai', investigationId], queryFn: () => api.get<{ status: { configured: boolean; model: string }; latest: { createdAt: string; result: AiResult } | null }>(`/api/investigations/${investigationId}/ai`) });
  async function run() {
    setRunning(true);
    try {
      await api.post(`/api/investigations/${investigationId}/ai`);
      await qc.invalidateQueries({ queryKey: ['ai', investigationId] });
      toast({ tone: 'success', title: 'AI analysis complete', description: 'Statements without valid evidence citations were discarded.' });
    } catch (e) {
      toast({ tone: 'error', title: 'AI analysis failed', description: (e as Error).message });
    } finally {
      setRunning(false);
    }
  }
  const status = q.data?.status;
  const r = q.data?.latest?.result;
  return (
    <Card>
      <CardHeader
        icon={<Bot className="h-4 w-4" />}
        title="AI-assisted analysis (optional)"
        description={status?.configured ? `Model ${status.model}. Summaries must cite findings; hypotheses are labelled.` : 'Not configured — all core features work without it.'}
        actions={
          <Button size="sm" variant="primary" onClick={() => void run()} loading={running} disabled={!status?.configured}>
            <Sparkles className="h-3.5 w-3.5" /> Run analysis
          </Button>
        }
      />
      <CardBody className="space-y-3 text-sm">
        {!status?.configured ? (
          <p className="text-muted">
            Set <code className="font-mono">ANTHROPIC_API_KEY</code> on the server to enable evidence summarisation, contradiction notes, hypotheses and follow-up suggestions. Collected content is passed as untrusted data; the model has no tools and cannot collect anything.
          </p>
        ) : !r ? (
          <p className="text-muted">No analysis yet.</p>
        ) : (
          <div className="space-y-3" data-testid="ai-result">
            <p className="text-xs text-subtle">
              Generated {formatDate(q.data?.latest?.createdAt, { time: true })} · {r.rejectedStatements} uncited statement(s) discarded
            </p>
            <ul className="space-y-1.5">
              {r.summary.map((s, i) => (
                <li key={i}>
                  {s.text} <span className="font-mono text-[11px] text-accent">[{s.findingRefs.join(', ')}]</span>
                </li>
              ))}
            </ul>
            {r.hypotheses.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-warning">Hypotheses — not established facts</p>
                <ul className="space-y-1">
                  {r.hypotheses.map((s, i) => (
                    <li key={i} className="text-muted">
                      <Badge tone="warning">Hypothesis</Badge> {s.text} <span className="font-mono text-[11px] text-accent">[{s.findingRefs.join(', ')}]</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {r.followUps.length ? (
              <div>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Suggested follow-up (not executed)</p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted">
                  {r.followUps.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export function ReportsView({ investigationId }: { investigationId: string }) {
  const { data: inv } = useInvestigation(investigationId);
  const toast = useToast();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [redact, setRedact] = useState(false);
  const [includeAi, setIncludeAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toDelete, setToDelete] = useState<ReportItem | null>(null);
  const list = useQuery({ queryKey: ['reports', investigationId], queryFn: () => api.get<{ items: ReportItem[] }>(`/api/investigations/${investigationId}/reports`) });

  async function generate() {
    setBusy(true);
    try {
      const r = await api.post<{ id: string; stats: { findings: number } }>(`/api/investigations/${investigationId}/reports`, { title: title || undefined, redact, includeAi });
      toast({ tone: 'success', title: 'Report generated', description: `${r.stats.findings} findings frozen into a reproducible snapshot.` });
      setTitle('');
      await qc.invalidateQueries({ queryKey: ['reports', investigationId] });
      await qc.invalidateQueries({ queryKey: ['investigation', investigationId] });
    } catch (e) {
      toast({ tone: 'error', title: 'Report failed', description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!toDelete) return;
    await api.del(`/api/investigations/${investigationId}/reports/${toDelete.id}`).catch((e: Error) => toast({ tone: 'error', title: 'Delete failed', description: e.message }));
    setToDelete(null);
    await qc.invalidateQueries({ queryKey: ['reports', investigationId] });
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Generate intelligence report" description="A report freezes the current evidence into a versioned snapshot. Every export format is rendered from that snapshot, so it is reproducible." />
          <CardBody className="space-y-4">
            <Field label="Title" htmlFor="report-title" hint={`Default: “${inv?.name ?? 'Investigation'} — Intelligence Report”`}>
              <Input id="report-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </Field>
            <div className="grid gap-1 sm:grid-cols-2">
              <Checkbox label="Redact sensitive identifiers" description="Masks email addresses and phone numbers in the report." checked={redact} onChange={(e) => setRedact(e.target.checked)} />
              <Checkbox label="Include latest AI analysis" description="Only evidence-cited statements; hypotheses labelled." checked={includeAi} onChange={(e) => setIncludeAi(e.target.checked)} />
            </div>
            <p className="text-xs text-muted">Sections: executive summary, scope & methodology, targets, key findings, online presence, infrastructure, geography, images, documents, relationships, timeline, contradictions, confidence & verification, unverified leads, limitations and source references.</p>
            <Button variant="primary" onClick={() => void generate()} loading={busy} data-testid="generate-report">
              <FileText className="h-4 w-4" /> Generate report
            </Button>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Reports" />
          {list.data?.items.length ? (
            <ul className="divide-y divide-border" data-testid="reports-list">
              {list.data.items.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:px-5 lg:flex-row lg:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{r.title}</p>
                    <p className="text-xs text-muted">
                      {formatDate(r.createdAt, { time: true })} · {r.createdBy}
                      {r.options.redact ? ' · redacted' : ''}
                      {r.options.includeAi ? ' · with AI summary' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(['pdf', 'markdown', 'json', 'csv'] as const).map((f) => (
                      <Button key={f} asChild size="sm">
                        <a href={`/api/investigations/${investigationId}/reports/${r.id}?format=${f}`} data-testid={`download-${f}`}>
                          <FileDown className="h-3.5 w-3.5" /> {f === 'markdown' ? 'MD' : f.toUpperCase()}
                        </a>
                      </Button>
                    ))}
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete report ${r.title}`} onClick={() => setToDelete(r)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <CardBody>
              <EmptyState icon={<FileText />} title="No reports yet" description="Generate a report to export PDF, Markdown, JSON or CSV." />
            </CardBody>
          )}
        </Card>
      </div>
      <AiPanel investigationId={investigationId} />
      <ConfirmDialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setToDelete(null)} title="Delete report?" description="The stored snapshot is removed. Evidence in the investigation is not affected." confirmLabel="Delete report" onConfirm={remove} />
    </div>
  );
}
