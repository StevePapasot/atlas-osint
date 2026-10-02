import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { findingsQuerySchema, listFindings } from '@/server/repositories/workspace';

export const GET = authed<{ id: string }>(async ({ req, params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const q = findingsQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  return jsonResponse(await listFindings(params.id, q));
});
