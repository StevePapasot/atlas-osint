import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { reviewFinding, reviewSchema, getFindingDetail } from '@/server/repositories/workspace';
import { recordAudit } from '@/server/audit';

export const POST = authed<{ id: string; findingId: string }>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const input = await readJson(req, reviewSchema);
  const r = await reviewFinding(params.id, params.findingId, session.user.id, input);
  if (!r.unchanged) await recordAudit({ userId: session.user.id, investigationId: params.id, action: `finding.${input.status}`, ip, targetType: 'finding', targetId: params.findingId, metadata: { from: r.from, to: r.to } });
  return jsonResponse(await getFindingDetail(params.id, params.findingId));
});
