import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { listEntities } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const u = req.nextUrl.searchParams;
  return jsonResponse({ items: await listEntities(params.id, { type: u.get('type') ?? undefined, q: u.get('q')?.slice(0, 200) ?? undefined, limit: Number(u.get('limit') ?? 500) }) });
});
