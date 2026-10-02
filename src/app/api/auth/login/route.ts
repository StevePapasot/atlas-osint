import { z } from 'zod';
import { cookies } from 'next/headers';
import { publicRoute, readJson, jsonResponse } from '@/server/api/handler';
import { ApiError } from '@/server/api/errors';
import { findUserByEmail } from '@/server/repositories/users';
import { verifyPassword, hashPassword } from '@/server/auth/password';
import { createSession, sessionCookieOptions, SESSION_COOKIE } from '@/server/auth/session';
import { recordAudit } from '@/server/audit';
import { rateLimit } from '@/server/security/rate-limit';

const schema = z.object({ email: z.string().trim().max(254), password: z.string().max(200) });

// Equalise timing between unknown users and wrong passwords.
let dummyHash: Promise<string> | null = null;

export const POST = publicRoute(
  async ({ req, ip }) => {
    const body = await readJson(req, schema);
    const perAccount = await rateLimit(`login-account:${body.email.toLowerCase()}`, 10, 15 * 60_000);
    if (!perAccount.allowed) throw new ApiError(429, 'rate_limited', 'Too many sign-in attempts for this account. Try again later.');
    const user = await findUserByEmail(body.email);
    dummyHash ??= hashPassword('atlas-timing-equaliser');
    const ok = user ? await verifyPassword(body.password, user.password_hash) : (await verifyPassword(body.password, await dummyHash), false);
    if (!user || !ok) {
      await recordAudit({ userId: user?.id ?? null, action: 'auth.login_failed', ip, metadata: { reason: 'invalid_credentials' } });
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    const { token, expires } = await createSession(user.id, { userAgent: req.headers.get('user-agent'), ip });
    (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(expires));
    await recordAudit({ userId: user.id, action: 'auth.login', ip });
    return jsonResponse({ user: { id: user.id, email: user.email, name: user.name } });
  },
  { rateLimit: { bucket: 'login', limit: 20, windowMs: 60_000 } },
);
