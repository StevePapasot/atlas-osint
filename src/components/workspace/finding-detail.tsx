'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, BookmarkCheck, ExternalLink, Fingerprint, MapPin, Tag, X } from 'lucide-react';
import { Sheet } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { SkeletonRows } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/ui/empty-state';
import { useToast } from '@/components/ui/toast';
import { CategoryBadge, ClaimTypeBadge, ConfidenceBadge, GeoPrecisionBadge, SimulatedBadge, VerificationBadge, EntityTypeLabel } from '@/components/domain/badges';
import { api } from '@/lib/api';
import { formatDate, formatPrecisionDate } from '@/lib/format';
import { VERIFICATION_LABELS, VERIFICATION_STATUSES } from '@/shared/domain';
import type { FindingItem } from './types';

interface FindingDetail extends FindingItem {
  entity: { id: string; type: string; value: string; display: string; isTarget: boolean } | null;
  observations: Array<{
    id: string;
    providerId: string;
    providerName: string;
    sourceName: string;
    sourceReliability: string;
    sourceKind: string;
    title: string;
    description: string | null;
    sourceUrl: string | null;
    collectedAt: string;
    publishedAt: string | null;
    publishedPrecision: string | null;
    claimType: string;
    confidenceInputs: Record<string, unknown>;
    limitations: string[];
    isSimulated: boolean;
  }>;
  evidence: Array<{ id: string; kind: string; title: string; content: string; content_type: string; sha256: string; source_url: string | null; provider_id: string | null; collected_at: string; isSimulated: boolean }>;
  reviews: Array<{ id: string; from_status: string; to_status: string; rationale: string | null; created_at: string; reviewer: string }>;
  notes: Array<{ id: string; body: string; created_at: string; author: string }>;
  tags: Array<{ id: string; name: string; color: string }>;
  events: Array<{ id: string; date: string | null; precision: string; kind: string; label: string }>;
  related: Array<{ id: string; title: string; confidence: string; category: string; claim_type: string }>;
}

/** URLs from sources are untrusted: only http(s) links are rendered, always with rel=noopener noreferrer. */
export function SafeLink({ href, children }: { href: string; children: React.ReactNode }) {
  const ok = /^https?:\/\//i.test(href);
  if (!ok) return <span className="break-all">{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

function ReviewForm({ detail, investigationId }: { detail: FindingDetail; investigationId: string }) {
  const [status, setStatus] = useState(detail.verificationStatus);
  const [rationale, setRationale] = useState('');
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  async function save() {
    setSaving(true);
    try {
      await api.post(`/api/investigations/${investigationId}/findings/${detail.id}/review`, { status, rationale: rationale || undefined });
      setRationale('');
      toast({ tone: 'success', title: 'Review recorded', description: `Marked ${VERIFICATION_LABELS[status as keyof typeof VERIFICATION_LABELS].toLowerCase()}. The change is kept in the audit trail.` });
      await qc.invalidateQueries({ queryKey: ['finding', detail.id] });
      await qc.invalidateQueries({ queryKey: ['findings', investigationId] });
    } catch (e) {
      toast({ tone: 'error', title: 'Review not saved', description: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface-2/40 p-3" data-testid="review-form">
      <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
        <Field label="Verification status" htmlFor="review-status">
          <Select id="review-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            {VERIFICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {VERIFICATION_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Rationale" htmlFor="review-rationale" hint="Required: what evidence did you check?">
          <Textarea id="review-rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} placeholder="e.g. Confirmed via registry record and archived page from 2023." />
        </Field>
      </div>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" loading={saving} disabled={status === detail.verificationStatus || (status !== 'unreviewed' && rationale.trim().length < 10)} onClick={() => void save()}>
          Record review
        </Button>
      </div>
    </div>
  );
}

export function FindingDetailSheet({ investigationId, findingId, onClose }: { investigationId: string; findingId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [tag, setTag] = useState('');
  const q = useQuery({
    queryKey: ['finding', findingId],
    queryFn: () => api.get<FindingDetail>(`/api/investigations/${investigationId}/findings/${findingId}`),
    enabled: Boolean(findingId),
  });
  const d = q.data;

  async function patch(body: Record<string, unknown>) {
    try {
      await api.patch(`/api/investigations/${investigationId}/findings/${findingId}`, body);
      await qc.invalidateQueries({ queryKey: ['finding', findingId] });
      await qc.invalidateQueries({ queryKey: ['findings', investigationId] });
    } catch (e) {
      toast({ tone: 'error', title: 'Update failed', description: (e as Error).message });
    }
  }
  async function addNote() {
    if (!note.trim()) return;
    try {
      await api.post(`/api/investigations/${investigationId}/notes`, { body: note, findingId });
      setNote('');
      await qc.invalidateQueries({ queryKey: ['finding', findingId] });
      await qc.invalidateQueries({ queryKey: ['notes', investigationId] });
    } catch (e) {
      toast({ tone: 'error', title: 'Note not saved', description: (e as Error).message });
    }
  }

  return (
    <Sheet open={Boolean(findingId)} onOpenChange={(o) => !o && onClose()} title={d?.title ?? 'Finding'} description={d ? `Finding ${d.id}` : undefined}>
      {q.isLoading ? <SkeletonRows rows={8} /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : d ? (
        <div className="space-y-6 text-sm" data-testid="finding-detail">
          <div className="flex flex-wrap items-center gap-1.5">
            {d.isSimulated ? <SimulatedBadge /> : null}
            <ClaimTypeBadge type={d.claimType} />
            <ConfidenceBadge level={d.confidence} rationale={d.confidenceRationale} score={d.confidenceScore} />
            <VerificationBadge status={d.verificationStatus} />
            <CategoryBadge category={d.category} />
            <Button size="sm" variant="ghost" onClick={() => void patch({ bookmarked: !d.bookmarked })} aria-pressed={d.bookmarked} className="ml-auto">
              {d.bookmarked ? <BookmarkCheck className="h-4 w-4 text-accent" /> : <Bookmark className="h-4 w-4" />} {d.bookmarked ? 'Bookmarked' : 'Bookmark'}
            </Button>
          </div>
          {d.description ? <p className="whitespace-pre-wrap text-fg">{d.description}</p> : null}
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted">Entity</dt>
              <dd className="mt-0.5 flex items-center gap-2">
                {d.entity ? (
                  <>
                    <EntityTypeLabel type={d.entity.type} /> <span className="break-all font-mono text-fg">{d.entity.display}</span>
                  </>
                ) : (
                  '—'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Collected by ATLAS</dt>
              <dd className="mt-0.5 text-fg">{formatDate(d.collectedAt, { time: true })}</dd>
            </div>
            <div>
              <dt className="text-muted">Source date</dt>
              <dd className="mt-0.5 text-fg">{formatPrecisionDate(d.publishedAt, d.publishedPrecision)}</dd>
            </div>
            <div>
              <dt className="text-muted">Corroboration</dt>
              <dd className="mt-0.5 text-fg">
                {d.providerCount} provider(s), {d.sourceCount} source(s)
              </dd>
            </div>
          </dl>
          {d.geo ? (
            <div className="rounded-lg border border-border px-3 py-2.5">
              <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-fg">
                <MapPin className="h-3.5 w-3.5" /> {d.geo.place ?? `${d.geo.lat?.toFixed(5)}, ${d.geo.lon?.toFixed(5)}`} <GeoPrecisionBadge precision={d.geo.precision} />
              </p>
              <p className="mt-1 text-xs text-muted">Basis: {d.geo.basis ?? 'not recorded'}</p>
            </div>
          ) : null}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Provenance ({d.observations.length})</h3>
            <ul className="space-y-2">
              {d.observations.map((o) => (
                <li key={o.id} className="rounded-lg border border-border px-3 py-2.5 text-xs">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{o.providerName}</span>
                    <Badge tone={o.sourceKind === 'simulated' ? 'simulated' : o.sourceKind === 'local' ? 'neutral' : 'accent'}>{o.sourceKind}</Badge>
                    <span className="text-muted">source: {o.sourceName}</span>
                    <span className="text-muted">reliability: {o.sourceReliability}</span>
                  </p>
                  {o.sourceUrl ? <p className="mt-1"><SafeLink href={o.sourceUrl}>{o.sourceUrl}</SafeLink></p> : null}
                  <p className="mt-1 text-muted">
                    Collected {formatDate(o.collectedAt, { time: true })} · source date {formatPrecisionDate(o.publishedAt, o.publishedPrecision)} · match {String(o.confidenceInputs.matchType ?? '—')}
                  </p>
                  {o.limitations.length ? <p className="mt-1 text-subtle">Limitations: {o.limitations.join(' ')}</p> : null}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Evidence ({d.evidence.length})</h3>
            <ul className="space-y-2">
              {d.evidence.map((e) => (
                <li key={e.id} className="rounded-lg border border-border">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-xs">
                      <Badge>{e.kind}</Badge>
                      <span className="font-medium text-fg">{e.title}</span>
                      <span className="ml-auto flex items-center gap-1 font-mono text-[10px] text-subtle" title="SHA-256 of stored content">
                        <Fingerprint className="h-3 w-3" />
                        {e.sha256.slice(0, 16)}…
                      </span>
                    </summary>
                    {/* Untrusted content is rendered as plain text only. */}
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all border-t border-border bg-surface-2/50 px-3 py-2 font-mono text-[11px] text-fg">{e.content}</pre>
                  </details>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Analyst review</h3>
            <ReviewForm key={d.verificationStatus} detail={d} investigationId={investigationId} />
            {d.reviews.length ? (
              <ol className="mt-3 space-y-1.5 text-xs">
                {d.reviews.map((r) => (
                  <li key={r.id} className="text-muted">
                    <span className="text-fg">{r.reviewer}</span> changed {VERIFICATION_LABELS[r.from_status as keyof typeof VERIFICATION_LABELS]} → <span className="text-fg">{VERIFICATION_LABELS[r.to_status as keyof typeof VERIFICATION_LABELS]}</span> on {formatDate(r.created_at, { time: true })}
                    {r.rationale ? <span className="block pl-3 italic">“{r.rationale}”</span> : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Tags</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {d.tags.map((t) => (
                <Badge key={t.id} tone="accent" className="gap-1">
                  <Tag className="h-3 w-3" />
                  {t.name}
                  <button type="button" aria-label={`Remove tag ${t.name}`} onClick={() => void patch({ removeTags: [t.name] })}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (tag.trim()) void patch({ addTags: [tag.trim()] }).then(() => setTag(''));
                }}
              >
                <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="Add tag" aria-label="Add tag" className="h-7 w-32 text-xs" maxLength={40} />
              </form>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Notes</h3>
            <div className="space-y-2">
              {d.notes.map((n) => (
                <div key={n.id} className="rounded-md border border-border px-3 py-2 text-xs">
                  <p className="whitespace-pre-wrap text-fg">{n.body}</p>
                  <p className="mt-1 text-subtle">
                    {n.author} · {formatDate(n.created_at, { time: true })}
                  </p>
                </div>
              ))}
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Add an analyst note to this finding" aria-label="New note" />
              <div className="flex justify-end">
                <Button size="sm" onClick={() => void addNote()} disabled={!note.trim()}>
                  Add note
                </Button>
              </div>
            </div>
          </section>

          {d.events.length ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Dated events</h3>
              <ul className="space-y-1 text-xs">
                {d.events.map((e) => (
                  <li key={e.id}>
                    <span className="tabular text-muted">{formatPrecisionDate(e.date, e.precision)}</span> — {e.label}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {d.related.length ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Related findings (same entity)</h3>
              <ul className="space-y-1 text-xs">
                {d.related.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <Link href={`/investigations/${investigationId}/findings?focus=${r.id}`} className="truncate text-accent hover:underline">
                      {r.title}
                    </Link>
                    <ConfidenceBadge level={r.confidence} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}
