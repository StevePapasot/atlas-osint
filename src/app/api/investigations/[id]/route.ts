import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { getInvestigationDetail, updateInvestigation, updateInvestigationSchema, deleteInvestigation } from '@/server/repositories/investigations';
import { recordAudit } from '@/server/audit';

type P = { id: string };

export const GET = authed<P>(async ({ params, session }) => jsonResponse(await getInvestigationDetail(params.id, session.user.id)));

export const PATCH = authed<P>(async ({ req, params, session, ip }) => {
  const patch = await readJson(req, updateInvestigationSchema);
  await updateInvestigation(params.id, session.user.id, patch);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'investigation.updated', ip, metadata: { fields: Object.keys(patch) } });
  return jsonResponse(await getInvestigationDetail(params.id, session.user.id));
});

export const DELETE = authed<P>(async ({ params, session, ip }) => {
  await deleteInvestigation(params.id, session.user.id);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'investigation.deleted', ip });
  return jsonResponse({ ok: true });
});
