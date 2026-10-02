import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getRelationshipDetail, updateRelationship, relationshipPatchSchema } from '@/server/repositories/workspace';
import { recordAudit } from '@/server/audit';

type P = { id: string; relId: string };

export const GET = authed<P>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse(await getRelationshipDetail(params.id, params.relId));
});

export const PATCH = authed<P>(async ({ req, params, session, ip }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  const patch = await readJson(req, relationshipPatchSchema);
  await updateRelationship(params.id, params.relId, patch);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: `relationship.${patch.status}`, ip, targetType: 'relationship', targetId: params.relId });
  return jsonResponse(await getRelationshipDetail(params.id, params.relId));
});
