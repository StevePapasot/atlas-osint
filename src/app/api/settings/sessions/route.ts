import { z } from 'zod';
import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { listSessions, revokeOtherSessions, revokeSession } from '@/server/auth/session';
import { recordAudit } from '@/server/audit';

export const GET = authed(async ({ session }) => {
  const items = await listSessions(session.user.id);
  return jsonResponse({ items: items.map((s) => ({ ...s, current: s.id === session.sessionId })) });
});

const schema = z.object({ sessionId: z.string().uuid().optional(), allOthers: z.boolean().optional() });

export const DELETE = authed(async ({ req, session, ip }) => {
  const body = await readJson(req, schema);
  if (body.allOthers) await revokeOtherSessions(session.user.id, session.sessionId);
  else if (body.sessionId) await revokeSession(session.user.id, body.sessionId);
  await recordAudit({ userId: session.user.id, action: 'auth.sessions_revoked', ip, metadata: { allOthers: Boolean(body.allOthers) } });
  return jsonResponse({ ok: true });
});
