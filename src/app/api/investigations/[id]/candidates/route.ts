import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { listCandidates } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse({ items: await listCandidates(params.id, { status: req.nextUrl.searchParams.get('status') ?? undefined }) });
});
