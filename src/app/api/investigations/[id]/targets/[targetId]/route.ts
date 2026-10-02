import { authed, jsonResponse } from '@/server/api/handler';
import { removeTarget } from '@/server/repositories/investigations';
import { recordAudit } from '@/server/audit';

export const DELETE = authed<{ id: string; targetId: string }>(async ({ params, session, ip }) => {
  await removeTarget(params.id, session.user.id, params.targetId);
  await recordAudit({ userId: session.user.id, investigationId: params.id, action: 'targets.removed', ip, targetType: 'target', targetId: params.targetId });
  return jsonResponse({ ok: true });
});
