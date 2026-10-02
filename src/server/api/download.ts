import { slug } from '../providers/util';

export function downloadResponse(rendered: { body: Buffer | string; contentType: string; extension: string }, name: string, suffix: string): Response {
  const filename = `atlas-${slug(name) || 'investigation'}-${suffix}.${rendered.extension}`;
  const body = typeof rendered.body === 'string' ? rendered.body : new Uint8Array(rendered.body);
  return new Response(body, {
    headers: {
      'Content-Type': rendered.contentType,
      'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
