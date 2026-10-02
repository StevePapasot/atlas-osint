import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getEvidence } from '@/server/repositories/workspace';

export const GET = authed<{ id: string; evidenceId: string }>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse(await getEvidence(params.id, params.evidenceId));
});
