/**
 * Apply database migrations: `npm run db:migrate`
 * Uses DATABASE_URL (default: file:./data/atlas.db). Works for SQLite and PostgreSQL.
 */
import './load-env';
import { closeDb, db, dialect } from '../src/server/db/client';
import { migrateToLatest } from '../src/server/db/migrate';

async function main() {
  const { applied } = await migrateToLatest(db());
  console.log(`[atlas] ${dialect()} migrations ${applied.length ? `applied: ${applied.join(', ')}` : 'already up to date'}`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('[atlas] migration failed:', err instanceof Error ? err.message : err);
  await closeDb();
  process.exit(1);
});
