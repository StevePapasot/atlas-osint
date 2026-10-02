import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { listEvidence } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const u = req.nextUrl.searchParams;
  return jsonResponse(
    await listEvidence(params.id, {
      kind: u.get('kind') ?? undefined,
      provider: u.get('provider') ?? undefined,
      q: u.get('q')?.slice(0, 200) ?? undefined,
      page: Math.max(1, Number(u.get('page') ?? 1) || 1),
      pageSize: Math.min(100, Math.max(1, Number(u.get('pageSize') ?? 25) || 25)),
    }),
  );
});
