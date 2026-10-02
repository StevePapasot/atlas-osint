import { authed, jsonResponse } from '@/server/api/handler';
import { cancelInvestigation } from '@/server/repositories/investigations';
import { recordAudit } from '@/server/audit';

export const POST = authed<{ id: string }>(async ({ params, session, ip }) => {
  const r = await cancelInvestigation(params.id, session.user.id);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'investigation.cancel_requested', ip });
  return jsonResponse(r, { status: 202 });
});
