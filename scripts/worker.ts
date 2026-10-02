/**
 * Standalone job worker: `npm run worker`
 * Use with ATLAS_INPROCESS_WORKER=false on the web process for a separate, horizontally scalable worker.
 */
import { closeDb, db } from '../src/server/db/client';
import { migrateToLatest } from '../src/server/db/migrate';
import { env } from '../src/server/config/env';
import { JobRunner, WORKER_ID } from '../src/server/engine/runner';

async function main() {
  await migrateToLatest(db());
  const runner = new JobRunner(db, env().ATLAS_WORKER_JOB_CONCURRENCY);
  runner.start();
  console.log(`[atlas] worker ${WORKER_ID} running (concurrency ${env().ATLAS_WORKER_JOB_CONCURRENCY})`);
  const shutdown = async () => {
    runner.stop();
    console.log('[atlas] worker stopping…');
    const deadline = Date.now() + 15_000;
    while (runner.active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[atlas] worker failed to start:', err);
  process.exit(1);
});
