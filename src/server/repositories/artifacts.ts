import 'server-only';
import { randomUUID, createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import { db } from '../db/client';
import { fromJson, nowIso, toJson } from '../db/json';
import { env } from '../config/env';
import { ApiError, notFound } from '../api/errors';
import { saveArtifactFile } from '../storage/files';
import { enqueueJob } from '../engine/runner';
import { ALLOWED_IMAGE_TYPES } from '../analysis/image';
import { detectDocumentKind, DOCUMENT_MIME } from '../analysis/documents';

export interface UploadInput {
  investigationId: string;
  userId: string;
  kind: 'image' | 'document';
  filename: string;
  data: Buffer;
}

function safeName(name: string): string {
  return name.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').slice(0, 180) || 'upload';
}

/** Validate by content (magic bytes), never by the client-supplied MIME type or extension alone. */
export async function storeArtifact(input: UploadInput) {
  const maxBytes = env().ATLAS_MAX_UPLOAD_MB * 1024 * 1024;
  if (input.data.length === 0) throw new ApiError(400, 'empty_file', 'The uploaded file is empty.');
  if (input.data.length > maxBytes) throw new ApiError(413, 'file_too_large', `Files are limited to ${env().ATLAS_MAX_UPLOAD_MB} MB.`);
  let mime: string;
  let ext: string;
  if (input.kind === 'image') {
    const ft = await fileTypeFromBuffer(input.data);
    if (!ft || !ALLOWED_IMAGE_TYPES[ft.mime]) {
      throw new ApiError(415, 'unsupported_image', 'Unsupported image format. Allowed: JPEG, PNG, WebP, GIF, TIFF, AVIF.');
    }
    mime = ft.mime;
    ext = ALLOWED_IMAGE_TYPES[ft.mime]!;
  } else {
    const kind = detectDocumentKind(input.data, input.filename);
    if (!kind) throw new ApiError(415, 'unsupported_document', 'Unsupported document. Allowed: PDF, DOCX, TXT, HTML, CSV.');
    mime = DOCUMENT_MIME[kind];
    ext = kind;
  }
  const sha256 = createHash('sha256').update(input.data).digest('hex');
  const duplicate = await db().selectFrom('artifacts').select(['id']).where('investigation_id', '=', input.investigationId).where('sha256', '=', sha256).executeTakeFirst();
  if (duplicate) throw new ApiError(409, 'duplicate_file', 'This exact file is already part of the investigation.');
  const storedPath = await saveArtifactFile(input.investigationId, input.data, ext);
  const id = randomUUID();
  await db()
    .insertInto('artifacts')
    .values({
      id,
      investigation_id: input.investigationId,
      uploaded_by: input.userId,
      kind: input.kind,
      original_name: safeName(input.filename),
      stored_path: storedPath,
      mime_type: mime,
      size_bytes: input.data.length,
      sha256,
      phash: null,
      width: null,
      height: null,
      status: 'queued',
      analysis: toJson({}),
      error: null,
      created_at: nowIso(),
    })
    .execute();
  // The artifact is also an entity so it can participate in the relationship graph.
  await db()
    .insertInto('entities')
    .values({ id: randomUUID(), investigation_id: input.investigationId, type: input.kind, value: `artifact:${id}`, display_value: safeName(input.filename), attributes: toJson({ artifactId: id, sha256, uploaded: true }), cluster_id: null, is_target: 1, is_simulated: 0, first_seen_at: nowIso(), last_seen_at: nowIso() })
    .onConflict((oc) => oc.doNothing())
    .execute();
  const jobId = await enqueueJob(db(), input.investigationId, 'artifact', { artifactId: id });
  return { id, jobId, mime, sha256 };
}

export async function listArtifacts(investigationId: string, kind?: 'image' | 'document') {
  let q = db().selectFrom('artifacts').selectAll().where('investigation_id', '=', investigationId);
  if (kind) q = q.where('kind', '=', kind);
  const rows = await q.orderBy('created_at', 'desc').execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    originalName: r.original_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
    phash: r.phash,
    width: r.width,
    height: r.height,
    status: r.status,
    error: r.error,
    analysis: fromJson<Record<string, unknown>>(r.analysis, {}),
    createdAt: r.created_at,
  }));
}

export async function getArtifact(investigationId: string, artifactId: string) {
  const r = await db().selectFrom('artifacts').selectAll().where('id', '=', artifactId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!r) throw notFound('Artifact');
  return r;
}
