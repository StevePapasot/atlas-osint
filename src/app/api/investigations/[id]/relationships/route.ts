import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { relationshipsFor } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const u = req.nextUrl.searchParams;
  return jsonResponse({
    items: await relationshipsFor(params.id, { entityId: u.get('entityId') ?? undefined, types: u.get('types')?.split(',').filter(Boolean), includeRejected: u.get('includeRejected') === 'true' }),
  });
});
