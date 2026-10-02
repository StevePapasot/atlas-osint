import { authed } from '@/server/api/handler';
import { notFound } from '@/server/api/errors';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getArtifact } from '@/server/repositories/artifacts';
import { readThumbnail } from '@/server/storage/files';

/** Metadata-stripped thumbnail (EXIF/GPS removed during generation). */
export const GET = authed<{ id: string; artifactId: string }>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  await getArtifact(params.id, params.artifactId);
  const buf = await readThumbnail(params.artifactId);
  if (!buf) throw notFound('Thumbnail');
  return new Response(new Uint8Array(buf), {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline', 'X-Content-Type-Options': 'nosniff' },
  });
});
