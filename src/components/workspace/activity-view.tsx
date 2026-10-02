'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { formatDate, titleCase } from '@/lib/format';

interface Note {
  id: string;
  body: string;
  created_at: string;
  author: string;
  finding_id: string | null;
  finding_title: string | null;
  entity_display: string | null;
}
interface Event {
  id: string;
  action: string;
  created_at: string;
  user_name: string | null;
  metadata: Record<string, unknown>;
}
interface Source {
  id: string;
  providerName: string;
  name: string;
  url: string | null;
  reliability: string;
  kind: string;
  first_seen_at: string;
  observationCount: number;
}

export function ActivityView({ investigationId }: { investigationId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [toDelete, setToDelete] = useState<string | null>(null);
  const notes = useQuery({ queryKey: ['notes', investigationId], queryFn: () => api.get<{ items: Note[] }>(`/api/investigations/${investigationId}/notes`) });
  const activity = useQuery({ queryKey: ['activity', investigationId], queryFn: () => api.get<{ items: Event[] }>(`/api/investigations/${investigationId}/activity`) });
  const sources = useQuery({ queryKey: ['sources', investigationId], queryFn: () => api.get<{ items: Source[] }>(`/api/investigations/${investigationId}/sources`) });

  async function add() {
    try {
      await api.post(`/api/investigations/${investigationId}/notes`, { body });
      setBody('');
      await qc.invalidateQueries({ queryKey: ['notes', investigationId] });
      await qc.invalidateQueries({ queryKey: ['activity', investigationId] });
    } catch (e) {
      toast({ tone: 'error', title: 'Note not saved', description: (e as Error).message });
    }
  }
  async function remove() {
    if (!toDelete) return;
    try {
      await api.del(`/api/investigations/${investigationId}/notes/${toDelete}`);
      await qc.invalidateQueries({ queryKey: ['notes', investigationId] });
    } catch (e) {
      toast({ tone: 'error', title: 'Delete failed', description: (e as Error).message });
    }
    setToDelete(null);
  }

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        <Card>
          <CardHeader title="Analyst notes" description="Notes are private to this investigation and included in the audit trail." />
          <CardBody className="space-y-3">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Record context, hypotheses to test, or next steps…" aria-label="New analyst note" />
            <div className="flex justify-end">
              <Button variant="primary" size="sm" disabled={!body.trim()} onClick={() => void add()} data-testid="add-note">
                Add note
              </Button>
            </div>
            <ul className="space-y-2" data-testid="notes-list">
              {notes.data?.items.map((n) => (
                <li key={n.id} className="rounded-lg border border-border px-3 py-2.5 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="whitespace-pre-wrap text-fg">{n.body}</p>
                    <Button size="icon-sm" variant="ghost" aria-label="Delete note" onClick={() => setToDelete(n.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-subtle">
                    {n.author} · {formatDate(n.created_at, { time: true })}
                    {n.finding_title ? <> · on finding “{n.finding_title}”</> : null}
                    {n.entity_display ? <> · on entity {n.entity_display}</> : null}
                  </p>
                </li>
              ))}
              {!notes.data?.items.length ? <li className="text-sm text-muted">No notes yet.</li> : null}
            </ul>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Sources" description="Distinct sources that contributed observations." />
          <ul className="max-h-[420px] divide-y divide-border overflow-y-auto">
            {sources.data?.items.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs sm:px-5">
                <span className="font-medium text-fg">{s.name}</span>
                <Badge tone={s.kind === 'simulated' ? 'simulated' : s.kind === 'local' ? 'neutral' : 'accent'}>{s.kind}</Badge>
                <span className="text-muted">reliability {s.reliability}</span>
                <span className="ml-auto text-subtle">{s.observationCount} obs.</span>
              </li>
            ))}
            {!sources.data?.items.length ? <li className="px-5 py-3 text-sm text-muted">No sources yet.</li> : null}
          </ul>
        </Card>
      </div>
      <Card>
        <CardHeader title="Audit trail" description="Immutable record of actions taken in this investigation." />
        <ol className="max-h-[760px] divide-y divide-border overflow-y-auto" data-testid="audit-list">
          {activity.data?.items.map((e) => (
            <li key={e.id} className="px-4 py-2.5 text-sm sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-fg">{e.action}</span>
                <span className="text-xs text-muted">{e.user_name ?? 'system'}</span>
                <span className="ml-auto text-xs text-subtle">{formatDate(e.created_at, { time: true })}</span>
              </div>
              {Object.keys(e.metadata).length ? (
                <p className="mt-0.5 truncate text-[11px] text-subtle">
                  {Object.entries(e.metadata)
                    .map(([k, v]) => `${titleCase(k)}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                    .join(' · ')}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </Card>
      <ConfirmDialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setToDelete(null)} title="Delete note?" description="This removes the note permanently. The deletion is recorded in the audit trail." confirmLabel="Delete note" onConfirm={remove} />
    </div>
  );
}
