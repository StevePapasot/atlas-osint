import { z } from 'zod';
import { authed, readJson, jsonResponse } from '@/server/api/handler';
import { ApiError } from '@/server/api/errors';
import { findUserById, setUserPassword } from '@/server/repositories/users';
import { passwordProblems, verifyPassword } from '@/server/auth/password';
import { revokeOtherSessions } from '@/server/auth/session';
import { recordAudit } from '@/server/audit';

const schema = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) });

export const POST = authed(
  async ({ req, session, ip }) => {
    const body = await readJson(req, schema);
    const user = await findUserById(session.user.id);
    if (!user || !(await verifyPassword(body.currentPassword, user.password_hash))) throw new ApiError(400, 'invalid_password', 'Current password is incorrect.');
    const problem = passwordProblems(body.newPassword);
    if (problem) throw new ApiError(400, 'weak_password', problem);
    await setUserPassword(user.id, body.newPassword);
    await revokeOtherSessions(user.id, session.sessionId);
    await recordAudit({ userId: user.id, action: 'auth.password_changed', ip });
    return jsonResponse({ ok: true, otherSessionsRevoked: true });
  },
  { rateLimit: { bucket: 'password', limit: 10, windowMs: 3600_000 } },
);
