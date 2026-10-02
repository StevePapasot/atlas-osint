import 'server-only';
import { db } from '../db/client';
import { ensureDatabase } from '../db/ensure';
import { env, inProcessWorkerEnabled } from '../config/env';
import { logger } from '../logging/logger';
import { JobRunner } from './runner';

const g = globalThis as unknown as { __atlasRunner?: JobRunner };

/**
 * Starts the in-process job runner once per server process (local / single-instance deployments).
 * Set ATLAS_INPROCESS_WORKER=false and run `npm run worker` to execute jobs in a separate process instead.
 */
export function ensureWorkerStarted(): void {
  if (g.__atlasRunner) return;
  if (!inProcessWorkerEnabled()) return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  if (process.env.NODE_ENV === 'test' && process.env.ATLAS_TEST_WORKER !== 'true') return;
  g.__atlasRunner = new JobRunner(db, env().ATLAS_WORKER_JOB_CONCURRENCY);
  ensureDatabase()
    .then(() => g.__atlasRunner?.start())
    .catch((err: unknown) => {
      logger.error('failed to start in-process worker', { error: err instanceof Error ? err.message : String(err) });
      g.__atlasRunner = undefined;
    });
}

export function workerStatus(): { mode: 'in-process' | 'external'; active: number } {
  return { mode: g.__atlasRunner ? 'in-process' : 'external', active: g.__atlasRunner?.active ?? 0 };
}
