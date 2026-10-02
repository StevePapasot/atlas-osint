import { randomUUID } from 'node:crypto';
import { db } from '@/server/db/client';
import { migrateToLatest } from '@/server/db/migrate';
import { createUser } from '@/server/repositories/users';
import { createSession, SESSION_COOKIE } from '@/server/auth/session';

export async function setupDb() {
  await migrateToLatest(db());
  return db();
}

export async function makeUser(name = 'Analyst') {
  const user = await createUser({ email: `${name.toLowerCase().replace(/\W/g, '')}-${randomUUID().slice(0, 8)}@atlas.test`, name, password: 'correct horse battery staple' });
  const { token } = await createSession(user.id, { userAgent: 'vitest', ip: '127.0.0.1' });
  return { user, token, cookie: `${SESSION_COOKIE}=${token}` };
}
