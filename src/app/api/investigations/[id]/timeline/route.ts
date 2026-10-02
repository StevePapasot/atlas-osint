import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getTimeline } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const u = req.nextUrl.searchParams;
  return jsonResponse({ items: await getTimeline(params.id, { entityId: u.get('entityId') ?? undefined, kind: u.get('kind') ?? undefined }) });
});
