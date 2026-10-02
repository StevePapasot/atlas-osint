import 'server-only';
import { db } from './client';
import { migrateToLatest } from './migrate';
import { logger } from '../logging/logger';

const g = globalThis as unknown as { __atlasMigrated?: Promise<void> };

/**
 * Ensure migrations ran once per process. Local SQLite mode migrates automatically for a zero-config start;
 * PostgreSQL deployments may set ATLAS_AUTO_MIGRATE=false and run `npm run db:migrate` explicitly.
 */
export function ensureDatabase(): Promise<void> {
  if (process.env.ATLAS_AUTO_MIGRATE === 'false') return Promise.resolve();
  if (!g.__atlasMigrated) {
    g.__atlasMigrated = migrateToLatest(db())
      .then(({ applied }) => {
        if (applied.length) logger.info('database migrations applied', { applied });
      })
      .catch((err: unknown) => {
        g.__atlasMigrated = undefined;
        throw err;
      });
  }
  return g.__atlasMigrated;
}
