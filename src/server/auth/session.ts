import 'server-only';
import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db } from '../db/client';
import { nowIso } from '../db/json';
import { cookieSecure, env } from '../config/env';
import { hashIp, randomToken, sha256Hex } from '../security/hash';
import { ensureDatabase } from '../db/ensure';
import { toPublicUser, type PublicUser } from '../repositories/users';

export const SESSION_COOKIE = 'atlas_session';

function ttlMs(): number {
  return env().ATLAS_SESSION_TTL_HOURS * 3600 * 1000;
}

export async function createSession(userId: string, meta: { userAgent?: string | null; ip?: string | null }) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs());
  await db()
    .insertInto('sessions')
    .values({
      id: randomUUID(),
      user_id: userId,
      token_hash: sha256Hex(token),
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
      last_seen_at: now.toISOString(),
      user_agent: meta.userAgent?.slice(0, 300) ?? null,
      ip_hash: hashIp(meta.ip),
    })
    .execute();
  await db().updateTable('users').set({ last_login_at: now.toISOString() }).where('id', '=', userId).execute();
  return { token, expires };
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: '/',
    expires,
  };
}

export interface SessionContext {
  user: PublicUser;
  sessionId: string;
}

/** Resolve a raw session token to its user; slides expiry at most once per hour. */
export async function resolveSession(token: string | undefined | null): Promise<SessionContext | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  await ensureDatabase();
  const row = await db()
    .selectFrom('sessions')
    .innerJoin('users', 'users.id', 'sessions.user_id')
    .selectAll('users')
    .select(['sessions.id as session_id', 'sessions.expires_at as session_expires_at', 'sessions.last_seen_at as session_last_seen'])
    .where('sessions.token_hash', '=', sha256Hex(token))
    .executeTakeFirst();
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.session_expires_at).getTime() <= now) {
    await db().deleteFrom('sessions').where('id', '=', row.session_id).execute();
    return null;
  }
  if (now - new Date(row.session_last_seen).getTime() > 3600_000) {
    await db()
      .updateTable('sessions')
      .set({ last_seen_at: new Date(now).toISOString(), expires_at: new Date(now + ttlMs()).toISOString() })
      .where('id', '=', row.session_id)
      .execute();
  }
  const { session_id, session_expires_at: _e, session_last_seen: _l, ...user } = row;
  return { user: toPublicUser(user), sessionId: session_id };
}

export async function destroySessionByToken(token: string): Promise<void> {
  await db().deleteFrom('sessions').where('token_hash', '=', sha256Hex(token)).execute();
}

export async function listSessions(userId: string) {
  return db()
    .selectFrom('sessions')
    .select(['id', 'created_at', 'last_seen_at', 'expires_at', 'user_agent'])
    .where('user_id', '=', userId)
    .where('expires_at', '>', nowIso())
    .orderBy('last_seen_at', 'desc')
    .execute();
}

export async function revokeSession(userId: string, sessionId: string) {
  await db().deleteFrom('sessions').where('user_id', '=', userId).where('id', '=', sessionId).execute();
}

export async function revokeOtherSessions(userId: string, keepSessionId: string) {
  await db().deleteFrom('sessions').where('user_id', '=', userId).where('id', '!=', keepSessionId).execute();
}

export async function purgeExpiredSessions() {
  await db().deleteFrom('sessions').where('expires_at', '<=', nowIso()).execute();
}

/** For server components / layouts. */
export async function getCurrentSession(): Promise<SessionContext | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<SessionContext> {
  const s = await getCurrentSession();
  if (!s) redirect('/login');
  return s;
}
