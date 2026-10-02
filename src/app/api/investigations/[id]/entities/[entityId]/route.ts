import { authed, jsonResponse } from '@/server/api/handler';
import { getOwnedInvestigation } from '@/server/repositories/investigations';
import { getEntityDetail } from '@/server/repositories/workspace';

export const GET = authed<{ id: string; entityId: string }>(async ({ params, session }) => {
  await getOwnedInvestigation(params.id, session.user.id);
  return jsonResponse(await getEntityDetail(params.id, params.entityId));
});
