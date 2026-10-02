import { authed, jsonResponse } from '@/server/api/handler';
import { ApiError } from '@/server/api/errors';
import { purgeExpired } from '@/server/repositories/retention';
import { recordAudit } from '@/server/audit';

export const POST = authed(async ({ session, ip }) => {
  const days = session.user.preferences.retentionDays;
  if (!days) throw new ApiError(400, 'retention_disabled', 'Set a retention period (days) before purging.');
  const deleted = await purgeExpired(session.user.id, days);
  await recordAudit({ userId: session.user.id, action: 'retention.purged', ip, metadata: { deleted, days } });
  return jsonResponse({ deleted });
});
