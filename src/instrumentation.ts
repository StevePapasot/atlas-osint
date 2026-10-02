/**
 * Runs once when the Next.js server boots. Starts the in-process job runner immediately (instead of on the first
 * request) so jobs queued before a restart resume without waiting for traffic. Skipped on the Edge runtime and when
 * ATLAS_INPROCESS_WORKER=false (a separate `npm run worker` process handles jobs).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureWorkerStarted } = await import('./server/engine/bootstrap');
  ensureWorkerStarted();
}
