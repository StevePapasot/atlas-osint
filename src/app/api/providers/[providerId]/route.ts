import { z } from 'zod';
import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { setProviderEnabled } from '@/server/repositories/providers';
import { recordAudit } from '@/server/audit';

const schema = z.object({ enabled: z.boolean() });

export const PATCH = authed<{ providerId: string }>(async ({ req, params, session, ip }) => {
  const { enabled } = await readJson(req, schema);
  await setProviderEnabled(session.user.id, params.providerId, enabled);
  await recordAudit({ userId: session.user.id, action: enabled ? 'provider.enabled' : 'provider.disabled', ip, targetType: 'provider', targetId: params.providerId });
  return jsonResponse({ ok: true });
});
