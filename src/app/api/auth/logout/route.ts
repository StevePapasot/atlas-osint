import { cookies } from 'next/headers';
import { publicRoute, jsonResponse } from '@/server/api/handler';
import { destroySessionByToken, SESSION_COOKIE } from '@/server/auth/session';
import { recordAudit } from '@/server/audit';

export const POST = publicRoute(async ({ session, ip }) => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await destroySessionByToken(token);
  store.delete(SESSION_COOKIE);
  if (session) await recordAudit({ userId: session.user.id, action: 'auth.logout', ip });
  return jsonResponse({ ok: true });
});
