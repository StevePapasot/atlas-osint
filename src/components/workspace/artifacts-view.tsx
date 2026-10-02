'use client';
import { useQuery } from '@tanstack/react-query';
import { FileText, ImageIcon, MapPin } from 'lucide-react';
import { Card, CardBody } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SkeletonRows } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/domain/badges';
import { api } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import { UploadZone } from './upload';
import { FindingsTable } from './findings-table';

interface Artifact {
  id: string;
  kind: 'image' | 'document';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  phash: string | null;
  width: number | null;
  height: number | null;
  status: string;
  error: string | null;
  analysis: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  createdAt: string;
}

function useArtifacts(investigationId: string, kind: 'image' | 'document') {
  return useQuery({
    queryKey: ['artifacts', investigationId, kind],
    queryFn: () => api.get<{ items: Artifact[] }>(`/api/investigations/${investigationId}/artifacts?kind=${kind}`),
    refetchInterval: (q) => (q.state.data?.items.some((a) => a.status === 'queued' || a.status === 'processing') ? 2000 : false),
  });
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div className="flex gap-2 text-xs">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-fg">{value}</dd>
    </div>
  );
}

export function ImagesView({ investigationId }: { investigationId: string }) {
  const q = useArtifacts(investigationId, 'image');
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-6">
      <UploadZone
        investigationId={investigationId}
        kind="image"
        accept="image/jpeg,image/png,image/webp,image/gif,image/tiff,image/avif"
        hint="JPEG, PNG, WebP, GIF, TIFF or AVIF. Files are validated by content, decoded safely, hashed, scanned for EXIF/GPS and OCR’d offline. Previews have metadata stripped."
      />
      <p className="text-xs text-muted">
        Reverse-image search is only possible for images at public URLs via a configured provider (SerpApi Google Lens). Uploaded files are never sent to third parties. Similarity between uploads uses local perceptual hashing; resemblance never establishes identity.
      </p>
      {q.isLoading ? <SkeletonRows /> : !items.length ? (
        <EmptyState icon={<ImageIcon />} title="No images uploaded" description="Upload photos or screenshots to extract metadata, coordinates and text." />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3" data-testid="image-artifacts">
          {items.map((a) => (
            <li key={a.id}>
              <Card className="overflow-hidden">
                <div className="flex aspect-video items-center justify-center bg-surface-2">
                  {a.status === 'processed' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/investigations/${investigationId}/artifacts/${a.id}/thumbnail`} alt={`Preview of ${a.originalName} (metadata stripped)`} className="max-h-full max-w-full object-contain" loading="lazy" />
                  ) : (
                    <ImageIcon className="h-8 w-8 text-subtle" />
                  )}
                </div>
                <CardBody className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="break-all text-sm font-medium">{a.originalName}</p>
                    <StatusBadge status={a.status} />
                  </div>
                  {a.error ? <p className="text-xs text-danger">{a.error}</p> : null}
                  <dl className="space-y-1">
                    <Meta label="Dimensions" value={a.width ? `${a.width} × ${a.height} px` : null} />
                    <Meta label="Format / size" value={`${a.mimeType} · ${formatBytes(a.sizeBytes)}`} />
                    <Meta label="Camera" value={[a.analysis.camera?.make, a.analysis.camera?.model].filter(Boolean).join(' ') || null} />
                    <Meta label="Software" value={a.analysis.camera?.software} />
                    <Meta label="Captured (EXIF)" value={a.analysis.dates?.original ? `${formatDate(a.analysis.dates.original, { time: true })} — camera clock` : null} />
                    <Meta
                      label="GPS (EXIF)"
                      value={
                        a.analysis.gps ? (
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-danger" /> {a.analysis.gps.latitude.toFixed(5)}, {a.analysis.gps.longitude.toFixed(5)} <Badge tone="warning">unverified metadata</Badge>
                          </span>
                        ) : a.status === 'processed' ? (
                          'none embedded'
                        ) : null
                      }
                    />
                    <Meta label="EXIF present" value={a.status === 'processed' ? (a.analysis.exifPresent ? 'yes' : 'no (stripped or never written)') : null} />
                    <Meta label="Perceptual hash" value={a.phash ? <span className="font-mono">{a.phash}</span> : null} />
                    <Meta label="SHA-256" value={<span className="font-mono">{a.sha256.slice(0, 24)}…</span>} />
                  </dl>
                  {a.analysis.ocr?.text ? (
                    <details className="rounded-md border border-border">
                      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium">OCR text ({a.analysis.ocr.confidence}% confidence)</summary>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap border-t border-border px-2.5 py-2 font-mono text-[11px]">{a.analysis.ocr.text}</pre>
                    </details>
                  ) : a.analysis.ocrError ? (
                    <p className="text-xs text-warning">OCR unavailable: {a.analysis.ocrError}</p>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <FindingsTable investigationId={investigationId} preset={{ entityType: 'image' }} title="Image-derived findings" />
    </div>
  );
}

export function DocumentsView({ investigationId }: { investigationId: string }) {
  const q = useArtifacts(investigationId, 'document');
  const items = q.data?.items ?? [];
  return (
    <div className="space-y-6">
      <UploadZone
        investigationId={investigationId}
        kind="document"
        accept=".pdf,.docx,.txt,.html,.htm,.csv,application/pdf,text/plain,text/html,text/csv"
        hint="PDF, DOCX, TXT, HTML or CSV that you are authorised to analyse. Content is parsed as untrusted data — never executed or rendered — and archives are checked for zip bombs."
      />
      {q.isLoading ? <SkeletonRows /> : !items.length ? (
        <EmptyState icon={<FileText />} title="No documents uploaded" description="Upload public documents to extract metadata, authors, dates, links, emails, names, organisations and places." />
      ) : (
        <ul className="space-y-3" data-testid="document-artifacts">
          {items.map((a) => (
            <li key={a.id}>
              <Card>
                <CardBody className="space-y-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="flex items-center gap-2 break-all text-sm font-medium">
                      <FileText className="h-4 w-4 text-subtle" /> {a.originalName}
                    </p>
                    <StatusBadge status={a.status} />
                  </div>
                  {a.error ? <p className="text-xs text-danger">{a.error}</p> : null}
                  {a.status === 'processed' ? (
                    <div className="grid gap-4 lg:grid-cols-2">
                      <dl className="space-y-1">
                        <Meta label="Type / size" value={`${String(a.analysis.kind ?? '').toUpperCase()} · ${formatBytes(a.sizeBytes)}${a.analysis.pages ? ` · ${a.analysis.pages} pages` : ''}`} />
                        <Meta label="Title (metadata)" value={a.analysis.title} />
                        <Meta label="Author (metadata)" value={a.analysis.author} />
                        <Meta label="Organisation" value={a.analysis.organization} />
                        <Meta label="Created with" value={a.analysis.creatorTool} />
                        <Meta label="Created" value={a.analysis.created ? formatDate(a.analysis.created, { time: true }) : null} />
                        <Meta label="Modified" value={a.analysis.modified ? formatDate(a.analysis.modified, { time: true }) : null} />
                        <Meta label="SHA-256" value={<span className="font-mono">{a.sha256.slice(0, 24)}…</span>} />
                      </dl>
                      <div className="space-y-1.5 text-xs">
                        {(
                          [
                            ['Emails', a.analysis.extracted?.emails],
                            ['URLs', a.analysis.extracted?.urls],
                            ['People (NER)', a.analysis.extracted?.people],
                            ['Organisations (NER)', a.analysis.extracted?.organizations],
                            ['Places', a.analysis.extracted?.places],
                            ['Dates', a.analysis.extracted?.dates],
                            ['Phones', a.analysis.extracted?.phones],
                          ] as Array<[string, string[] | undefined]>
                        ).map(([label, list]) =>
                          list?.length ? (
                            <div key={label}>
                              <span className="text-muted">{label}: </span>
                              <span className="break-all text-fg">{list.slice(0, 12).join(', ')}{list.length > 12 ? ` (+${list.length - 12})` : ''}</span>
                            </div>
                          ) : null,
                        )}
                      </div>
                    </div>
                  ) : null}
                  {a.analysis.textPreview ? (
                    <details className="rounded-md border border-border">
                      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium">Extracted text preview{a.analysis.textTruncated ? ' (truncated)' : ''}</summary>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-t border-border px-2.5 py-2 font-mono text-[11px]">{a.analysis.textPreview}</pre>
                    </details>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      <FindingsTable investigationId={investigationId} preset={{ category: 'document' }} title="Document findings (uploads and discovered documents)" />
    </div>
  );
}
