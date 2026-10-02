import 'server-only';
import { randomUUID } from 'node:crypto';
import { db } from '../db/client';
import { fromJson, nowIso, toJson } from '../db/json';
import type { Row } from '../db/schema';
import { hashPassword } from '../auth/password';
import { DEFAULT_PREFERENCES, type UserPreferences } from '@/shared/preferences';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: 'analyst' | 'admin';
  preferences: UserPreferences;
  createdAt: string;
  lastLoginAt: string | null;
}

export function toPublicUser(row: Row<'users'>): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    preferences: { ...DEFAULT_PREFERENCES, ...fromJson<Partial<UserPreferences>>(row.preferences, {}) },
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function findUserByEmail(email: string) {
  return db().selectFrom('users').selectAll().where('email', '=', email.trim().toLowerCase()).executeTakeFirst();
}

export async function findUserById(id: string) {
  return db().selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function createUser(input: { email: string; name: string; password: string; role?: 'analyst' | 'admin' }) {
  const now = nowIso();
  const row = {
    id: randomUUID(),
    email: input.email.trim().toLowerCase(),
    name: input.name.trim(),
    password_hash: await hashPassword(input.password),
    role: input.role ?? 'analyst',
    preferences: toJson(DEFAULT_PREFERENCES),
    created_at: now,
    updated_at: now,
    last_login_at: null,
  } as const;
  await db().insertInto('users').values(row).execute();
  return (await findUserById(row.id))!;
}

export async function updateUserPreferences(userId: string, prefs: Partial<UserPreferences>) {
  const user = await findUserById(userId);
  if (!user) return null;
  const merged = { ...DEFAULT_PREFERENCES, ...fromJson<Partial<UserPreferences>>(user.preferences, {}), ...prefs };
  await db()
    .updateTable('users')
    .set({ preferences: toJson(merged), updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();
  return merged;
}

export async function updateUserProfile(userId: string, patch: { name?: string }) {
  await db()
    .updateTable('users')
    .set({ ...(patch.name ? { name: patch.name.trim() } : {}), updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();
}

export async function setUserPassword(userId: string, password: string) {
  await db()
    .updateTable('users')
    .set({ password_hash: await hashPassword(password), updated_at: nowIso() })
    .where('id', '=', userId)
    .execute();
}

export async function countUsers(): Promise<number> {
  const r = await db().selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
  return Number(r?.n ?? 0);
}
