import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { decideCandidate, candidateDecisionSchema } from '@/server/repositories/workspace';
import { recordAudit } from '@/server/audit';

export const POST = authed<{ id: string; candidateId: string }>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const input = await readJson(req, candidateDecisionSchema);
  await decideCandidate(params.id, params.candidateId, session.user.id, input);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: `entity_match.${input.decision}`, ip, targetType: 'candidate', targetId: params.candidateId });
  return jsonResponse({ ok: true });
});
