import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { buildGraph } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const u = req.nextUrl.searchParams;
  return jsonResponse(
    await buildGraph(params.id, {
      relTypes: u.get('relTypes')?.split(',').filter(Boolean),
      entityTypes: u.get('entityTypes')?.split(',').filter(Boolean),
      includePossible: u.get('includePossible') !== 'false',
      limit: Number(u.get('limit') ?? 400),
    }),
  );
});
