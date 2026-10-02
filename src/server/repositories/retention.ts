import 'server-only';
import { db } from '../db/client';
import { fromJson } from '../db/json';
import { deleteInvestigationFiles } from '../storage/files';
import { logger } from '../logging/logger';
import type { UserPreferences } from '@/shared/preferences';

/** Delete a user's investigations not updated within their retention window (0 = keep forever). */
export async function purgeExpired(userId: string, retentionDays: number, now = new Date()): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0;
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const expired = await db().selectFrom('investigations').select('id').where('owner_id', '=', userId).where('updated_at', '<', cutoff).where('status', 'not in', ['queued', 'running']).execute();
  for (const inv of expired) {
    const arts = await db().selectFrom('artifacts').select('id').where('investigation_id', '=', inv.id).execute();
    await db().deleteFrom('investigations').where('id', '=', inv.id).execute();
    await deleteInvestigationFiles(inv.id, arts.map((a) => a.id));
  }
  if (expired.length) logger.info('retention purge', { userId, resultCount: expired.length });
  return expired.length;
}

export async function purgeAllUsers(): Promise<number> {
  const users = await db().selectFrom('users').select(['id', 'preferences']).execute();
  let total = 0;
  for (const u of users) {
    const prefs = fromJson<Partial<UserPreferences>>(u.preferences, {});
    total += await purgeExpired(u.id, prefs.retentionDays ?? Number(process.env.ATLAS_DEFAULT_RETENTION_DAYS ?? 0));
  }
  return total;
}
