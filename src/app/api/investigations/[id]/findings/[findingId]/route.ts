import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getFindingDetail, patchFinding, findingPatchSchema } from '@/server/repositories/workspace';
import { recordAudit } from '@/server/audit';

type P = { id: string; findingId: string };

export const GET = authed<P>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse(await getFindingDetail(params.id, params.findingId));
});

export const PATCH = authed<P>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const patch = await readJson(req, findingPatchSchema);
  await patchFinding(params.id, params.findingId, patch);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'finding.updated', ip, targetType: 'finding', targetId: params.findingId, metadata: patch });
  return jsonResponse(await getFindingDetail(params.id, params.findingId));
});
