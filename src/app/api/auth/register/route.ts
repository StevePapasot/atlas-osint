import { z } from 'zod';
import { cookies } from 'next/headers';
import { publicRoute, readJson, jsonResponse } from '@/server/api/handler';
import { ApiError } from '@/server/api/errors';
import { registrationAllowed } from '@/server/config/env';
import { createUser, findUserByEmail, countUsers } from '@/server/repositories/users';
import { passwordProblems } from '@/server/auth/password';
import { createSession, sessionCookieOptions, SESSION_COOKIE } from '@/server/auth/session';
import { recordAudit } from '@/server/audit';
import { ACCEPTABLE_USE_VERSION } from '@/shared/acceptable-use';

const schema = z.object({
  email: z.string().trim().email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(200),
  acceptUse: z.boolean().optional(),
});

export const POST = publicRoute(
  async ({ req, ip }) => {
    if (!registrationAllowed() && (await countUsers()) > 0) throw new ApiError(403, 'registration_closed', 'Registration is disabled on this server.');
    const body = await readJson(req, schema);
    if (body.acceptUse !== true) {
      throw new ApiError(400, 'acceptable_use_required', 'To create an account, agree to use ATLAS only for lawful, authorised research (acceptable-use policy).');
    }
    const problem = passwordProblems(body.password);
    if (problem) throw new ApiError(400, 'weak_password', problem);
    if (await findUserByEmail(body.email)) throw new ApiError(409, 'email_taken', 'An account with this email already exists.');
    const first = (await countUsers()) === 0;
    const user = await createUser({ email: body.email, name: body.name, password: body.password, role: first ? 'admin' : 'analyst' });
    const { token, expires } = await createSession(user.id, { userAgent: req.headers.get('user-agent'), ip });
    (await cookies()).set(SESSION_COOKIE, token, sessionCookieOptions(expires));
    await recordAudit({ userId: user.id, action: 'auth.register', ip, metadata: { acceptableUseVersion: ACCEPTABLE_USE_VERSION } });
    return jsonResponse({ user: { id: user.id, email: user.email, name: user.name } }, { status: 201 });
  },
  { rateLimit: { bucket: 'register', limit: 10, windowMs: 3600_000 } },
);
