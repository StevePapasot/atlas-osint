import { authed, jsonResponse } from '@/server/api/handler';
import { ApiError } from '@/server/api/errors';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { listArtifacts, storeArtifact } from '@/server/repositories/artifacts';
import { env } from '@/server/config/env';
import { recordAudit } from '@/server/audit';

type P = { id: string };

export const GET = authed<P>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const kind = req.nextUrl.searchParams.get('kind');
  return jsonResponse({ items: await listArtifacts(params.id, kind === 'image' || kind === 'document' ? kind : undefined) });
});

export const POST = authed<P>(
  async ({ req, params, session, ip }) => {
    await getOwnedInvestigation(params.id, session.user.id);
    const max = env().ATLAS_MAX_UPLOAD_MB * 1024 * 1024;
    const len = Number(req.headers.get('content-length') ?? '0');
    if (len > max + 1024 * 1024) throw new ApiError(413, 'file_too_large', `Files are limited to ${env().ATLAS_MAX_UPLOAD_MB} MB.`);
    if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) throw new ApiError(415, 'unsupported_media_type', 'Use multipart/form-data.');
    const form = await req.formData();
    const kind = form.get('kind');
    const file = form.get('file');
    if (kind !== 'image' && kind !== 'document') throw new ApiError(400, 'invalid_kind', 'kind must be "image" or "document".');
    if (!(file instanceof File)) throw new ApiError(400, 'missing_file', 'Attach a file in the "file" field.');
    if (file.size > max) throw new ApiError(413, 'file_too_large', `Files are limited to ${env().ATLAS_MAX_UPLOAD_MB} MB.`);
    const data = Buffer.from(await file.arrayBuffer());
    const r = await storeArtifact({ investigationId: params.id, userId: session.user.id, kind, filename: file.name, data });
    await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'artifact.uploaded', ip, targetType: 'artifact', targetId: r.id, metadata: { kind, mime: r.mime, size: data.length } });
    return jsonResponse(r, { status: 201 });
  },
  { rateLimit: { bucket: 'upload', limit: 60, windowMs: 3600_000 } },
);
