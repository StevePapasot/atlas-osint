import { db } from '../db/client';
import { nowIso } from '../db/json';

/** Expired-session cleanup, usable from the worker (no request context required). */
export async function purgeExpiredSessions(): Promise<void> {
  await db().deleteFrom('sessions').where('expires_at', '<=', nowIso()).execute();
}
