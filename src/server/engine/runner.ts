/**
 * Durable, database-backed job runner.
 *
 * - Jobs are rows in `investigation_jobs`; work items are rows in `job_tasks`. Both survive restarts.
 * - Claiming is atomic (UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING; SKIP LOCKED on PostgreSQL).
 * - Running jobs heartbeat; stale jobs (crashed worker) are re-queued and their unfinished tasks reset.
 * - Cancellation is cooperative: the API sets cancel_requested, the heartbeat aborts in-flight provider calls.
 * - Each provider call has a timeout, bounded retries with backoff, per-provider concurrency/pacing, and error
 *   classification. A failing provider never fails the whole investigation.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { sql, type Kysely } from 'kysely';
import type { Database, Row } from '../db/schema';
import { db, isPostgres } from '../db/client';
import { fromJson, nowIso, toJson } from '../db/json';
import { env } from '../config/env';
import { logger } from '../logging/logger';
import { getProvider } from '../providers/registry';
import { ProviderError, type ProviderContext, type ProviderInput, type ProviderResult } from '../providers/types';
import { createHttpClient } from '../providers/http';
import { createDnsClient } from '../providers/dns';
import { persistRecords } from './persist';
import { planCollection, planPivots, effectiveModules, type PlannedTask, type PlanSubject } from './planner';
import { providerGate, mapWithConcurrency } from './limiter';
import { runCorrelation } from './correlation';
import type { ArtifactPatch, ArtifactParams } from '../providers/artifacts';
import type { Depth, ErrorCategory, JobStatus, ModuleId, TargetType } from '@/shared/domain';
import { purgeAllUsers } from '../repositories/retention';
import { purgeExpiredSessions } from '../auth/session-maintenance';

const HEARTBEAT_MS = 2000;
const STALE_AFTER_MS = 60_000;
const MAX_JOB_ATTEMPTS = 3;

export const WORKER_ID = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

// ------------------------------------------------------------------------------------------------ enqueue

export async function enqueueJob(
  k: Kysely<Database>,
  investigationId: string,
  kind: 'investigation' | 'artifact',
  payload: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await k
    .insertInto('investigation_jobs')
    .values({
      id,
      investigation_id: investigationId,
      kind,
      status: 'queued',
      attempt: 0,
      locked_by: null,
      locked_at: null,
      heartbeat_at: null,
      cancel_requested: 0,
      total_tasks: 0,
      completed_tasks: 0,
      failed_tasks: 0,
      skipped_tasks: 0,
      stage: 'queued',
      error: null,
      payload: toJson(payload),
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
    })
    .execute();
  return id;
}

// ------------------------------------------------------------------------------------------------ claiming & recovery

export async function claimNextJob(k: Kysely<Database>, workerId = WORKER_ID): Promise<Row<'investigation_jobs'> | null> {
  const now = nowIso();
  const pg = isPostgres(k);
  const result = await sql<Row<'investigation_jobs'>>`
    UPDATE investigation_jobs
       SET status = 'running', locked_by = ${workerId}, locked_at = ${now}, heartbeat_at = ${now},
           started_at = COALESCE(started_at, ${now}), attempt = attempt + 1, stage = 'starting'
     WHERE id = (
        SELECT id FROM investigation_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1
        ${pg ? sql`FOR UPDATE SKIP LOCKED` : sql``}
     ) AND status = 'queued'
     RETURNING *`.execute(k);
  return result.rows[0] ?? null;
}

/** Re-queue jobs whose worker stopped heartbeating (crash/restart). */
export async function recoverStaleJobs(k: Kysely<Database>): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
  const stale = await k.selectFrom('investigation_jobs').selectAll().where('status', '=', 'running').where('heartbeat_at', '<', cutoff).execute();
  for (const job of stale) {
    const exhausted = job.attempt >= MAX_JOB_ATTEMPTS;
    await k
      .updateTable('job_tasks')
      .set(exhausted ? { status: 'cancelled', error_category: 'internal', error_message: 'Worker lost; job abandoned.', finished_at: nowIso() } : { status: 'queued' })
      .where('job_id', '=', job.id)
      .where('status', '=', 'running')
      .execute();
    await k
      .updateTable('investigation_jobs')
      .set(exhausted ? { status: 'failed', error: 'Worker stopped responding repeatedly.', finished_at: nowIso(), locked_by: null } : { status: 'queued', locked_by: null, stage: 'requeued' })
      .where('id', '=', job.id)
      .execute();
    if (exhausted) await setInvestigationStatus(k, job.investigation_id, 'failed');
    logger.warn('recovered stale job', { jobId: job.id, investigationId: job.investigation_id, status: exhausted ? 'failed' : 'requeued' });
  }
  return stale.length;
}

async function setInvestigationStatus(k: Kysely<Database>, investigationId: string, status: string, extra: { started?: boolean; completed?: boolean } = {}) {
  const now = nowIso();
  await k
    .updateTable('investigations')
    .set({
      status,
      updated_at: now,
      ...(extra.started ? { started_at: now, completed_at: null } : {}),
      ...(extra.completed ? { completed_at: now } : {}),
    })
    .where('id', '=', investigationId)
    .execute();
}

// ------------------------------------------------------------------------------------------------ task bookkeeping

async function insertTasks(k: Kysely<Database>, job: Row<'investigation_jobs'>, tasks: PlannedTask[]): Promise<void> {
  const now = nowIso();
  const rows = tasks.map((t) => ({
    id: randomUUID(),
    job_id: job.id,
    investigation_id: job.investigation_id,
    provider_id: t.providerId,
    target_id: t.subject.targetId,
    entity_id: t.subject.entityId,
    operation: t.operation,
    stage: t.stage,
    input: toJson({ subject: t.subject, params: t.params }),
    status: t.status,
    attempts: 0,
    started_at: null,
    finished_at: t.status === 'skipped' ? now : null,
    duration_ms: null,
    result_count: 0,
    error_category: t.errorCategory ?? null,
    error_message: t.errorMessage ?? null,
    notes: toJson([]),
    created_at: now,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await k.insertInto('job_tasks').values(rows.slice(i, i + 200)).execute();
  }
  await refreshJobCounters(k, job.id);
}

export async function refreshJobCounters(k: Kysely<Database>, jobId: string): Promise<void> {
  const counts = await k
    .selectFrom('job_tasks')
    .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
    .where('job_id', '=', jobId)
    .groupBy('status')
    .execute();
  const by = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) as Record<string, number>;
  const total = Object.values(by).reduce((s, n) => s + n, 0);
  await k
    .updateTable('investigation_jobs')
    .set({
      total_tasks: total,
      completed_tasks: (by.succeeded ?? 0) + (by.failed ?? 0) + (by.skipped ?? 0) + (by.cancelled ?? 0),
      failed_tasks: by.failed ?? 0,
      skipped_tasks: by.skipped ?? 0,
    })
    .where('id', '=', jobId)
    .execute();
}

// ------------------------------------------------------------------------------------------------ task execution

export async function recordProviderHealth(k: Kysely<Database>, providerId: string, status: string, message: string, latencyMs: number | null): Promise<void> {
  const row = { status, message: message.slice(0, 500), latency_ms: latencyMs, checked_at: nowIso() };
  await k
    .insertInto('provider_health')
    .values({ provider_id: providerId, ...row })
    .onConflict((oc) => oc.column('provider_id').doUpdateSet(row))
    .execute();
}

interface JobContext {
  k: Kysely<Database>;
  job: Row<'investigation_jobs'>;
  investigation: Row<'investigations'>;
  related: Array<{ type: TargetType; value: string; display: string }>;
  signal: AbortSignal;
}

function classify(err: unknown): { category: ErrorCategory; message: string; retryable: boolean; retryAfterMs?: number } {
  if (err instanceof ProviderError) return { category: err.category, message: err.message, retryable: err.retryable, retryAfterMs: err.retryAfterMs };
  const msg = err instanceof Error ? err.message : String(err);
  return { category: 'internal', message: `Unexpected provider error: ${msg.slice(0, 300)}`, retryable: false };
}

async function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError('timeout', `Provider exceeded ${ms} ms.`, true)), ms + 250);
        signal.addEventListener('abort', () => reject(new ProviderError('cancelled', 'Cancelled.')), { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function executeTask(jc: JobContext, task: Row<'job_tasks'>): Promise<void> {
  const { k } = jc;
  const provider = getProvider(task.provider_id);
  const log = logger.child({ investigationId: task.investigation_id, jobId: task.job_id, taskId: task.id, provider: task.provider_id, operation: task.operation });
  const started = Date.now();
  if (!provider) {
    await k.updateTable('job_tasks').set({ status: 'failed', error_category: 'internal', error_message: 'Unknown provider.', finished_at: nowIso() }).where('id', '=', task.id).execute();
    return;
  }
  const e = env();
  const input = fromJson<{ subject: PlanSubject; params: Record<string, unknown> }>(task.input, { subject: null as unknown as PlanSubject, params: {} });
  const maxRetries = provider.maxRetries ?? 1;
  const timeoutMs = provider.timeoutMs ?? e.ATLAS_PROVIDER_TIMEOUT_MS;
  let attempt = 0;
  let lastErr: ReturnType<typeof classify> | null = null;
  await k.updateTable('job_tasks').set({ status: 'running', started_at: nowIso() }).where('id', '=', task.id).execute();

  while (attempt <= maxRetries) {
    attempt++;
    if (jc.signal.aborted) break;
    const attemptSignal = AbortSignal.any([jc.signal, AbortSignal.timeout(timeoutMs)]);
    const ctx: ProviderContext = {
      signal: attemptSignal,
      env: e,
      timeoutMs,
      http: createHttpClient({ signal: attemptSignal, userAgent: e.ATLAS_HTTP_USER_AGENT, defaultTimeoutMs: Math.min(timeoutMs, 30_000) }),
      dns: createDnsClient({ servers: e.ATLAS_DNS_SERVERS?.split(',').map((s) => s.trim()).filter(Boolean), timeoutMs: 4000, signal: attemptSignal }),
      now: () => new Date(),
      log: (msg, fields) => log.debug(msg, fields),
    };
    const pinput: ProviderInput = {
      subject: input.subject,
      operation: task.operation,
      params: input.params,
      depth: jc.investigation.depth as Depth,
      investigation: { id: jc.investigation.id, name: jc.investigation.name, scopeStatement: jc.investigation.scope_statement, mode: jc.investigation.mode },
      relatedTargets: jc.related,
    };
    let release: (() => void) | null = null;
    try {
      release = await providerGate(provider.id, provider.concurrency ?? 4, provider.minIntervalMs ?? 0).acquire(jc.signal);
      const result = (await withTimeout(provider.run(pinput, ctx), timeoutMs, jc.signal)) as ProviderResult & { artifactPatch?: ArtifactPatch };
      release();
      release = null;
      const records = result.records.map((r) => ({ ...r, providerId: r.providerId || provider.id }));
      const persisted = records.length
        ? await persistRecords(k, { investigationId: task.investigation_id, taskId: task.id, targetId: task.target_id, providerKind: provider.kind }, records)
        : { created: 0, merged: 0 };
      if (result.artifactPatch && typeof input.params.artifactId === 'string') {
        const patch = result.artifactPatch;
        await k
          .updateTable('artifacts')
          .set({
            ...(patch.status ? { status: patch.status } : {}),
            ...(patch.phash !== undefined ? { phash: patch.phash } : {}),
            ...(patch.width !== undefined ? { width: patch.width } : {}),
            ...(patch.height !== undefined ? { height: patch.height } : {}),
            ...(patch.analysis ? { analysis: toJson(patch.analysis) } : {}),
            ...(patch.error !== undefined ? { error: patch.error } : {}),
          })
          .where('id', '=', input.params.artifactId)
          .execute();
      }
      const durationMs = Date.now() - started;
      await k
        .updateTable('job_tasks')
        .set({
          status: 'succeeded',
          attempts: attempt,
          finished_at: nowIso(),
          duration_ms: durationMs,
          result_count: records.length,
          error_category: null,
          error_message: null,
          notes: toJson([...(result.notes ?? []), ...(persisted.merged ? [`${persisted.merged} result(s) merged into existing findings (deduplicated).`] : [])]),
        })
        .where('id', '=', task.id)
        .execute();
      if (provider.kind === 'live') await recordProviderHealth(k, provider.id, 'healthy', 'Last task succeeded.', durationMs);
      log.info('provider task succeeded', { status: 'succeeded', durationMs, resultCount: records.length });
      return;
    } catch (err) {
      if (release) release();
      lastErr = classify(err);
      if (jc.signal.aborted) lastErr = { category: 'cancelled', message: 'Cancelled by analyst.', retryable: false };
      else if (lastErr.category === 'cancelled') lastErr = { category: 'timeout', message: `Provider did not finish within ${timeoutMs} ms.`, retryable: true };
      log.warn('provider task attempt failed', { status: 'failed', errorCategory: lastErr.category, attempt, error: lastErr.message, durationMs: Date.now() - started });
      if (!lastErr.retryable || attempt > maxRetries) break;
      const backoff = Math.min(8000, lastErr.retryAfterMs ?? 500 * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  const cancelled = jc.signal.aborted;
  if (provider.kind === 'live' && lastErr && !cancelled && lastErr.category !== 'not_applicable') {
    await recordProviderHealth(k, provider.id, lastErr.category === 'auth' || lastErr.category === 'network' ? 'unavailable' : 'degraded', `${lastErr.category}: ${lastErr.message}`, Date.now() - started);
  }
  const notApplicable = lastErr?.category === 'not_applicable';
  await k
    .updateTable('job_tasks')
    .set({
      status: cancelled ? 'cancelled' : notApplicable ? 'skipped' : 'failed',
      attempts: attempt,
      finished_at: nowIso(),
      duration_ms: Date.now() - started,
      error_category: lastErr?.category ?? 'internal',
      error_message: lastErr?.message?.slice(0, 1000) ?? 'Unknown error.',
    })
    .where('id', '=', task.id)
    .execute();
}

async function runQueuedTasks(jc: JobContext, stage: string): Promise<void> {
  const tasks = await jc.k.selectFrom('job_tasks').selectAll().where('job_id', '=', jc.job.id).where('stage', '=', stage).where('status', '=', 'queued').orderBy('created_at').execute();
  await jc.k.updateTable('investigation_jobs').set({ stage }).where('id', '=', jc.job.id).execute();
  await mapWithConcurrency(tasks, env().ATLAS_TASK_CONCURRENCY, async (t) => {
    if (jc.signal.aborted) return;
    await executeTask(jc, t);
    await refreshJobCounters(jc.k, jc.job.id);
  });
}

async function runAnalysisTask(jc: JobContext): Promise<void> {
  const existing = await jc.k.selectFrom('job_tasks').select(['id', 'status']).where('job_id', '=', jc.job.id).where('stage', '=', 'analysis').executeTakeFirst();
  if (existing && existing.status !== 'queued') return;
  const id = existing?.id ?? randomUUID();
  const now = nowIso();
  if (!existing) {
    await jc.k
      .insertInto('job_tasks')
      .values({ id, job_id: jc.job.id, investigation_id: jc.job.investigation_id, provider_id: 'atlas.correlation', target_id: null, entity_id: null, operation: 'correlate', stage: 'analysis', input: toJson({}), status: 'running', attempts: 1, started_at: now, finished_at: null, duration_ms: null, result_count: 0, error_category: null, error_message: null, notes: toJson([]), created_at: now })
      .execute();
  }
  await jc.k.updateTable('investigation_jobs').set({ stage: 'analysis' }).where('id', '=', jc.job.id).execute();
  await refreshJobCounters(jc.k, jc.job.id);
  const started = Date.now();
  try {
    const r = await runCorrelation(jc.k, jc.job.investigation_id, id);
    await jc.k
      .updateTable('job_tasks')
      .set({ status: 'succeeded', finished_at: nowIso(), duration_ms: Date.now() - started, result_count: r.correlations + r.candidates, notes: toJson([`${r.candidates} new entity-match candidate(s) for analyst review.`, `${r.correlations} infrastructure correlation(s).`]) })
      .where('id', '=', id)
      .execute();
  } catch (err) {
    logger.error('correlation failed', { investigationId: jc.job.investigation_id, error: (err as Error).message });
    await jc.k.updateTable('job_tasks').set({ status: 'failed', finished_at: nowIso(), error_category: 'internal', error_message: (err as Error).message.slice(0, 500) }).where('id', '=', id).execute();
  }
  await refreshJobCounters(jc.k, jc.job.id);
}

// ------------------------------------------------------------------------------------------------ job execution

async function finalStatus(k: Kysely<Database>, jobId: string, cancelled: boolean): Promise<{ status: JobStatus; error: string | null }> {
  if (cancelled) return { status: 'cancelled', error: null };
  const counts = await k.selectFrom('job_tasks').select(['status', (eb) => eb.fn.countAll<number>().as('n')]).where('job_id', '=', jobId).where('stage', '!=', 'analysis').groupBy('status').execute();
  const by = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) as Record<string, number>;
  const ok = by.succeeded ?? 0;
  const failed = by.failed ?? 0;
  if (ok === 0 && failed === 0) return { status: 'failed', error: 'No usable providers for these targets and modules. Configure providers or use demo mode.' };
  if (ok === 0) return { status: 'failed', error: 'All provider tasks failed. See the task list for details.' };
  if (failed > 0) return { status: 'partially_completed', error: null };
  return { status: 'completed', error: null };
}

export async function runJob(k: Kysely<Database>, job: Row<'investigation_jobs'>): Promise<JobStatus> {
  const investigation = await k.selectFrom('investigations').selectAll().where('id', '=', job.investigation_id).executeTakeFirst();
  if (!investigation) {
    await k.updateTable('investigation_jobs').set({ status: 'failed', error: 'Investigation deleted.', finished_at: nowIso() }).where('id', '=', job.id).execute();
    return 'failed';
  }
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const row = await k.selectFrom('investigation_jobs').select(['cancel_requested']).where('id', '=', job.id).executeTakeFirst();
        if (!row || row.cancel_requested === 1) controller.abort(new ProviderError('cancelled', 'Cancelled by analyst.'));
        await k.updateTable('investigation_jobs').set({ heartbeat_at: nowIso() }).where('id', '=', job.id).execute();
      } catch (err) {
        logger.warn('heartbeat failed', { jobId: job.id, error: (err as Error).message });
      }
    })();
  }, HEARTBEAT_MS);
  const log = logger.child({ investigationId: job.investigation_id, jobId: job.id });
  const isArtifactJob = job.kind === 'artifact';
  if (!isArtifactJob) await setInvestigationStatus(k, job.investigation_id, 'running', { started: job.attempt <= 1 });
  log.info('job started', { status: 'running', kind: job.kind });

  try {
    const targets = await k.selectFrom('targets').selectAll().where('investigation_id', '=', investigation.id).execute();
    const related = targets.map((t) => ({ type: t.type as TargetType, value: t.normalized_value, display: t.raw_value }));
    const jc: JobContext = { k, job, investigation, related, signal: controller.signal };
    const prefs = await k.selectFrom('provider_configurations').select(['provider_id', 'enabled']).where('user_id', '=', investigation.owner_id).execute();
    const userDisabled = new Set(prefs.filter((p) => p.enabled === 0).map((p) => p.provider_id));
    const modules = fromJson<ModuleId[]>(investigation.modules, []);
    const planInput = {
      depth: investigation.depth as Depth,
      mode: investigation.mode,
      modules,
      providerAllowList: fromJson<string[]>(investigation.providers, []),
      userDisabled,
      env: env(),
      related,
      scope: investigation.scope_statement,
    };
    const existingTasks = await k.selectFrom('job_tasks').select(['id']).where('job_id', '=', job.id).limit(1).execute();

    if (isArtifactJob) {
      const payload = fromJson<{ artifactId?: string }>(job.payload, {});
      const art = payload.artifactId ? await k.selectFrom('artifacts').selectAll().where('id', '=', payload.artifactId).executeTakeFirst() : undefined;
      if (!art) throw new Error('Artifact not found.');
      if (!existingTasks.length) {
        const others = art.kind === 'image'
          ? await k.selectFrom('artifacts').select(['id', 'original_name', 'phash', 'sha256']).where('investigation_id', '=', investigation.id).where('kind', '=', 'image').where('id', '!=', art.id).where('status', '=', 'processed').execute()
          : [];
        const params: ArtifactParams = {
          artifactId: art.id,
          storedPath: art.stored_path,
          originalName: art.original_name,
          mimeType: art.mime_type,
          kind: art.kind,
          otherImages: others.map((o) => ({ artifactId: o.id, name: o.original_name, phash: o.phash, sha256: o.sha256 })),
          targetValues: targets.map((t) => t.normalized_value),
        };
        await k.updateTable('artifacts').set({ status: 'processing' }).where('id', '=', art.id).execute();
        const subject: PlanSubject = { type: art.kind, value: `artifact:${art.id}`, display: art.original_name, metadata: { artifactId: art.id }, targetId: null, entityId: null };
        await insertTasks(k, job, [{ providerId: art.kind === 'image' ? 'local.image' : 'local.document', operation: art.kind === 'image' ? 'analyze_image' : 'analyze_document', subject, params: params as unknown as Record<string, unknown>, stage: 'artifact', status: 'queued' }]);
      }
      await runQueuedTasks(jc, 'artifact');
      const t = await k.selectFrom('job_tasks').select(['status', 'error_message']).where('job_id', '=', job.id).where('stage', '=', 'artifact').executeTakeFirst();
      if (t?.status === 'failed' && payload.artifactId) {
        await k.updateTable('artifacts').set({ status: 'failed', error: t.error_message }).where('id', '=', payload.artifactId).execute();
      }
      if (!controller.signal.aborted && t?.status === 'succeeded') await runAnalysisTask(jc);
    } else {
      if (!existingTasks.length) {
        const subjects: PlanSubject[] = targets
          .filter((t) => !(t.type === 'image' || t.type === 'document') || !fromJson<Record<string, unknown>>(t.metadata, {}).artifactId)
          .map((t) => ({ type: t.type as TargetType, value: t.normalized_value, display: t.raw_value, metadata: fromJson<Record<string, unknown>>(t.metadata, {}), targetId: t.id, entityId: null }));
        await insertTasks(k, job, planCollection(subjects, planInput));
      }
      await runQueuedTasks(jc, 'collection');
      // Deep mode: one hop of infrastructure pivots on newly discovered domains/IPs linked to targets.
      if (!controller.signal.aborted && effectiveModules(investigation.depth as Depth, modules).includes('infrastructure')) {
        const hasPivots = await k.selectFrom('job_tasks').select('id').where('job_id', '=', job.id).where('stage', '=', 'pivot').limit(1).execute();
        if (!hasPivots.length) {
          const targetValues = new Set(targets.map((t) => t.normalized_value));
          // Only entities directly linked to a target are pivot candidates: results of earlier pivots are never
          // pivoted again, so re-running an investigation stays a single bounded hop (and is idempotent).
          const targetEntityIds = k.selectFrom('entities').select('id').where('investigation_id', '=', investigation.id).where('is_target', '=', 1);
          const discovered = await k
            .selectFrom('entities')
            .select(['id', 'type', 'value', 'display_value'])
            .where('investigation_id', '=', investigation.id)
            .where('type', 'in', ['domain', 'ip'])
            .where('is_target', '=', 0)
            .where((eb) =>
              eb.exists(
                eb
                  .selectFrom('relationships as r')
                  .select('r.id')
                  .where('r.investigation_id', '=', investigation.id)
                  .where('r.status', '!=', 'rejected')
                  .where((w) =>
                    w.or([
                      w.and([w('r.from_entity_id', '=', w.ref('entities.id')), w('r.to_entity_id', 'in', targetEntityIds)]),
                      w.and([w('r.to_entity_id', '=', w.ref('entities.id')), w('r.from_entity_id', 'in', targetEntityIds)]),
                    ]),
                  ),
              ),
            )
            .orderBy('first_seen_at')
            .orderBy('value')
            .execute();
          const pivots = planPivots(discovered.filter((d) => !targetValues.has(d.value)).map((d) => ({ id: d.id, type: d.type, value: d.value, display: d.display_value })), planInput);
          if (pivots.length) await insertTasks(k, job, pivots);
        }
        await runQueuedTasks(jc, 'pivot');
      }
      if (!controller.signal.aborted && effectiveModules(investigation.depth as Depth, modules).includes('correlation')) await runAnalysisTask(jc);
    }

    if (controller.signal.aborted) {
      await k.updateTable('job_tasks').set({ status: 'cancelled', finished_at: nowIso(), error_category: 'cancelled', error_message: 'Cancelled before execution.' }).where('job_id', '=', job.id).where('status', 'in', ['queued', 'running']).execute();
    }
    await refreshJobCounters(k, job.id);
    const final = isArtifactJob
      ? { status: (controller.signal.aborted ? 'cancelled' : 'completed') as JobStatus, error: null }
      : await finalStatus(k, job.id, controller.signal.aborted);
    await k.updateTable('investigation_jobs').set({ status: final.status, error: final.error, finished_at: nowIso(), stage: 'finished', locked_by: null }).where('id', '=', job.id).execute();
    if (!isArtifactJob) await setInvestigationStatus(k, job.investigation_id, final.status, { completed: true });
    else await k.updateTable('investigations').set({ updated_at: nowIso() }).where('id', '=', job.investigation_id).execute();
    log.info('job finished', { status: final.status });
    return final.status;
  } catch (err) {
    log.error('job crashed', { error: (err as Error).message });
    await k.updateTable('investigation_jobs').set({ status: 'failed', error: (err as Error).message.slice(0, 500), finished_at: nowIso(), stage: 'finished', locked_by: null }).where('id', '=', job.id).execute();
    if (!isArtifactJob) await setInvestigationStatus(k, job.investigation_id, 'failed', { completed: true });
    else {
      const payload = fromJson<{ artifactId?: string }>(job.payload, {});
      if (payload.artifactId) await k.updateTable('artifacts').set({ status: 'failed', error: (err as Error).message.slice(0, 500) }).where('id', '=', payload.artifactId).execute();
    }
    return 'failed';
  } finally {
    clearInterval(heartbeat);
  }
}

/** Claim and run one job. Returns the job's final status or null when the queue was empty. */
export async function processNextJob(k: Kysely<Database> = db()): Promise<JobStatus | null> {
  const job = await claimNextJob(k);
  if (!job) return null;
  return runJob(k, job);
}

// ------------------------------------------------------------------------------------------------ worker loop

export class JobRunner {
  private running = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private lastRecovery = 0;
  private lastMaintenance = 0;

  constructor(
    private readonly k: () => Kysely<Database>,
    private readonly concurrency: number,
    private readonly pollMs = 1000,
  ) {}

  start(): void {
    this.stopped = false;
    const loop = async () => {
      if (this.stopped) return;
      try {
        if (Date.now() - this.lastRecovery > 15_000) {
          this.lastRecovery = Date.now();
          await recoverStaleJobs(this.k());
        }
        if (Date.now() - this.lastMaintenance > 3600_000) {
          this.lastMaintenance = Date.now();
          await purgeAllUsers();
          await purgeExpiredSessions();
        }
        while (this.running < this.concurrency) {
          const job = await claimNextJob(this.k());
          if (!job) break;
          this.running++;
          void runJob(this.k(), job).finally(() => {
            this.running--;
          });
        }
      } catch (err) {
        logger.error('worker loop error', { error: (err as Error).message });
      }
      this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
    logger.info('job runner started', { workerId: WORKER_ID, concurrency: this.concurrency });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  get active(): number {
    return this.running;
  }
}
