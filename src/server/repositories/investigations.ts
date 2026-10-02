import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/client';
import { fromJson, nowIso, toJson } from '../db/json';
import type { Row } from '../db/schema';
import { ApiError, conflict, notFound } from '../api/errors';
import { enqueueJob } from '../engine/runner';
import { effectiveModules } from '../engine/planner';
import { normalizeTarget } from '@/shared/targets';
import { DEPTHS, MODULES, TARGET_TYPES, TERMINAL_STATUSES, type Depth, type InvestigationStatus, type ModuleId, type TargetType, type EntityType } from '@/shared/domain';
import { deleteInvestigationFiles } from '../storage/files';
import { getProvider } from '../providers/registry';

export const targetInputSchema = z.object({
  type: z.enum(TARGET_TYPES),
  value: z.string().min(1).max(2048),
  label: z.string().max(200).optional(),
});

export const createInvestigationSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters.').max(160),
  description: z.string().trim().max(4000).optional(),
  scopeStatement: z.string().trim().max(4000).optional(),
  depth: z.enum(DEPTHS).default('standard'),
  mode: z.enum(['live', 'demo']).default('live'),
  modules: z.array(z.enum(MODULES)).max(MODULES.length).default([]),
  providers: z.array(z.string().max(80)).max(100).default([]),
  targets: z.array(targetInputSchema).max(50).default([]),
  defaultCountry: z.string().regex(/^[A-Z]{2}$/).optional(),
  start: z.boolean().default(false),
});

export const updateInvestigationSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  scopeStatement: z.string().trim().max(4000).nullable().optional(),
  depth: z.enum(DEPTHS).optional(),
  mode: z.enum(['live', 'demo']).optional(),
  modules: z.array(z.enum(MODULES)).max(MODULES.length).optional(),
  providers: z.array(z.string().max(80)).max(100).optional(),
});

const TARGET_ENTITY: Record<TargetType, EntityType> = {
  person: 'person',
  organization: 'organization',
  username: 'username',
  email: 'email',
  ip: 'ip',
  domain: 'domain',
  url: 'url',
  phone: 'phone',
  crypto: 'crypto_address',
  image: 'image',
  document: 'document',
  keyword: 'keyword',
};

export interface InvestigationSummary {
  id: string;
  name: string;
  description: string | null;
  scopeStatement: string | null;
  depth: Depth;
  mode: 'live' | 'demo';
  modules: ModuleId[];
  effectiveModules: ModuleId[];
  providers: string[];
  status: InvestigationStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  counts?: { targets: number; findings: number; entities: number; evidence: number };
}

export function toSummary(row: Row<'investigations'>): InvestigationSummary {
  const modules = fromJson<ModuleId[]>(row.modules, []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scopeStatement: row.scope_statement,
    depth: row.depth,
    mode: row.mode,
    modules,
    effectiveModules: effectiveModules(row.depth, modules),
    providers: fromJson<string[]>(row.providers, []),
    status: row.status as InvestigationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** Ownership-checked fetch. Returns 404 (not 403) for other users' investigations to avoid ID probing. */
export async function getOwnedInvestigation(id: string, userId: string): Promise<Row<'investigations'>> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Investigation');
  const row = await db().selectFrom('investigations').selectAll().where('id', '=', id).where('owner_id', '=', userId).executeTakeFirst();
  if (!row) throw notFound('Investigation');
  return row;
}

async function ensureTargetEntity(investigationId: string, type: TargetType, value: string, display: string) {
  const now = nowIso();
  await db()
    .insertInto('entities')
    .values({
      id: randomUUID(),
      investigation_id: investigationId,
      type: TARGET_ENTITY[type],
      value,
      display_value: display.slice(0, 500),
      attributes: toJson({ target: true }),
      cluster_id: null,
      is_target: 1,
      is_simulated: 0,
      first_seen_at: now,
      last_seen_at: now,
    })
    .onConflict((oc) => oc.columns(['investigation_id', 'type', 'value']).doUpdateSet({ is_target: 1 }))
    .execute();
}

export async function addTarget(investigationId: string, input: z.infer<typeof targetInputSchema>, opts: { defaultCountry?: string; metadata?: Record<string, unknown> } = {}) {
  const n = normalizeTarget(input.type, input.value, { defaultCountry: opts.defaultCountry });
  if (!n.ok) throw new ApiError(400, 'invalid_target', `${input.value.slice(0, 80)}: ${n.error}`);
  const existing = await db()
    .selectFrom('targets')
    .select('id')
    .where('investigation_id', '=', investigationId)
    .where('type', '=', input.type)
    .where('normalized_value', '=', n.normalized)
    .executeTakeFirst();
  if (existing) return { id: existing.id, duplicate: true };
  const id = randomUUID();
  await db()
    .insertInto('targets')
    .values({
      id,
      investigation_id: investigationId,
      type: input.type,
      raw_value: n.display,
      normalized_value: n.normalized,
      label: input.label ?? null,
      metadata: toJson({ ...n.metadata, ...opts.metadata }),
      created_at: nowIso(),
    })
    .execute();
  await ensureTargetEntity(investigationId, input.type, n.normalized, n.display);
  return { id, duplicate: false };
}

export async function createInvestigation(userId: string, input: z.infer<typeof createInvestigationSchema>) {
  // Validate every target before writing anything, so the analyst gets all errors at once.
  const problems = input.targets
    .map((t, i) => ({ i, t, r: normalizeTarget(t.type, t.value, { defaultCountry: input.defaultCountry }) }))
    .filter((x) => !x.r.ok)
    .map((x) => ({ index: x.i, value: x.t.value.slice(0, 80), error: (x.r as { error: string }).error }));
  if (problems.length) throw new ApiError(400, 'invalid_targets', 'One or more targets are invalid.', problems);
  if (input.depth === 'custom' && !input.modules.length) throw new ApiError(400, 'modules_required', 'Custom depth requires at least one module.');
  const id = randomUUID();
  const now = nowIso();
  await db()
    .insertInto('investigations')
    .values({
      id,
      owner_id: userId,
      name: input.name,
      description: input.description || null,
      scope_statement: input.scopeStatement || null,
      depth: input.depth,
      mode: input.mode,
      modules: toJson(input.depth === 'custom' ? input.modules : []),
      providers: toJson(input.depth === 'custom' ? input.providers : []),
      status: 'draft',
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      retention_until: null,
    })
    .execute();
  for (const t of input.targets) await addTarget(id, t, { defaultCountry: input.defaultCountry });
  return id;
}

export async function listInvestigations(userId: string, opts: { status?: string; q?: string; limit?: number; offset?: number } = {}) {
  let q = db().selectFrom('investigations').selectAll().where('owner_id', '=', userId);
  if (opts.status) q = q.where('status', '=', opts.status);
  if (opts.q) q = q.where((eb) => eb(eb.fn('lower', ['name']), 'like', `%${opts.q!.toLowerCase().replace(/[%_]/g, '')}%`));
  const rows = await q.orderBy('updated_at', 'desc').limit(Math.min(opts.limit ?? 50, 200)).offset(opts.offset ?? 0).execute();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const count = async (table: 'targets' | 'findings' | 'entities' | 'evidence') =>
    Object.fromEntries(
      (await db().selectFrom(table).select(['investigation_id', (eb) => eb.fn.countAll<number>().as('n')]).where('investigation_id', 'in', ids).groupBy('investigation_id').execute()).map((r) => [r.investigation_id, Number(r.n)]),
    ) as Record<string, number>;
  const [targets, findings, entities, evidence] = await Promise.all([count('targets'), count('findings'), count('entities'), count('evidence')]);
  return rows.map((r) => ({ ...toSummary(r), counts: { targets: targets[r.id] ?? 0, findings: findings[r.id] ?? 0, entities: entities[r.id] ?? 0, evidence: evidence[r.id] ?? 0 } }));
}

export async function getInvestigationDetail(id: string, userId: string) {
  const row = await getOwnedInvestigation(id, userId);
  const [targets, job, counts] = await Promise.all([
    db().selectFrom('targets').selectAll().where('investigation_id', '=', id).orderBy('created_at').execute(),
    db().selectFrom('investigation_jobs').selectAll().where('investigation_id', '=', id).where('kind', '=', 'investigation').orderBy('created_at', 'desc').executeTakeFirst(),
    investigationCounts(id),
  ]);
  return {
    ...toSummary(row),
    counts,
    targets: targets.map((t) => ({ id: t.id, type: t.type as TargetType, value: t.raw_value, normalizedValue: t.normalized_value, label: t.label, metadata: fromJson<Record<string, unknown>>(t.metadata, {}), createdAt: t.created_at })),
    latestJob: job ? jobSummary(job) : null,
  };
}

export function jobSummary(job: Row<'investigation_jobs'>) {
  const done = job.completed_tasks;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    totalTasks: job.total_tasks,
    completedTasks: done,
    failedTasks: job.failed_tasks,
    skippedTasks: job.skipped_tasks,
    progress: job.total_tasks ? done / job.total_tasks : job.status === 'queued' ? 0 : 1,
    cancelRequested: job.cancel_requested === 1,
    error: job.error,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

export async function investigationCounts(id: string) {
  const c = async (table: 'targets' | 'findings' | 'entities' | 'evidence' | 'relationships' | 'timeline_events' | 'artifacts' | 'reports' | 'analyst_notes') =>
    Number((await db().selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).where('investigation_id', '=', id).executeTakeFirst())?.n ?? 0);
  const [targets, findings, entities, evidence, relationships, timeline, artifacts, reports, notes] = await Promise.all([
    c('targets'), c('findings'), c('entities'), c('evidence'), c('relationships'), c('timeline_events'), c('artifacts'), c('reports'), c('analyst_notes'),
  ]);
  const pendingCandidates = Number(
    (await db().selectFrom('entity_match_candidates').select((eb) => eb.fn.countAll<number>().as('n')).where('investigation_id', '=', id).where('status', '=', 'pending').executeTakeFirst())?.n ?? 0,
  );
  return { targets, findings, entities, evidence, relationships, timeline, artifacts, reports, notes, pendingCandidates };
}

export async function updateInvestigation(id: string, userId: string, patch: z.infer<typeof updateInvestigationSchema>) {
  const row = await getOwnedInvestigation(id, userId);
  if (row.status === 'running' || row.status === 'queued') {
    if (patch.depth || patch.mode || patch.modules || patch.providers) throw conflict('Collection settings cannot change while the investigation is running.');
  }
  await db()
    .updateTable('investigations')
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.scopeStatement !== undefined ? { scope_statement: patch.scopeStatement } : {}),
      ...(patch.depth !== undefined ? { depth: patch.depth } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      ...(patch.modules !== undefined ? { modules: toJson(patch.modules) } : {}),
      ...(patch.providers !== undefined ? { providers: toJson(patch.providers) } : {}),
      updated_at: nowIso(),
    })
    .where('id', '=', id)
    .execute();
}

/** Start (or restart) collection. Idempotent: returns the active job if one is already queued/running. */
export async function startInvestigation(id: string, userId: string) {
  const row = await getOwnedInvestigation(id, userId);
  const active = await db()
    .selectFrom('investigation_jobs')
    .selectAll()
    .where('investigation_id', '=', id)
    .where('kind', '=', 'investigation')
    .where('status', 'in', ['queued', 'running'])
    .executeTakeFirst();
  if (active) return { jobId: active.id, alreadyRunning: true };
  const targetCount = Number((await db().selectFrom('targets').select((eb) => eb.fn.countAll<number>().as('n')).where('investigation_id', '=', id).executeTakeFirst())?.n ?? 0);
  if (!targetCount) throw new ApiError(400, 'no_targets', 'Add at least one target before starting.');
  if (row.status !== 'draft' && !TERMINAL_STATUSES.includes(row.status as InvestigationStatus)) throw conflict(`Cannot start from status ${row.status}.`);
  const jobId = await enqueueJob(db(), id, 'investigation');
  await db().updateTable('investigations').set({ status: 'queued', updated_at: nowIso(), completed_at: null }).where('id', '=', id).execute();
  return { jobId, alreadyRunning: false };
}

export async function cancelInvestigation(id: string, userId: string) {
  await getOwnedInvestigation(id, userId);
  const jobs = await db().selectFrom('investigation_jobs').selectAll().where('investigation_id', '=', id).where('status', 'in', ['queued', 'running']).execute();
  if (!jobs.length) throw conflict('Nothing is running.');
  for (const job of jobs) {
    if (job.status === 'queued') {
      // Not yet claimed: cancel immediately (guarded against a concurrent claim).
      const res = await db().updateTable('investigation_jobs').set({ status: 'cancelled', cancel_requested: 1, finished_at: nowIso(), stage: 'finished' }).where('id', '=', job.id).where('status', '=', 'queued').executeTakeFirst();
      if (Number(res.numUpdatedRows) === 0) await db().updateTable('investigation_jobs').set({ cancel_requested: 1 }).where('id', '=', job.id).execute();
      else if (job.kind === 'investigation') await db().updateTable('investigations').set({ status: 'cancelled', updated_at: nowIso(), completed_at: nowIso() }).where('id', '=', id).execute();
    } else {
      await db().updateTable('investigation_jobs').set({ cancel_requested: 1 }).where('id', '=', job.id).execute();
    }
  }
  return { cancelled: jobs.length };
}

export async function deleteInvestigation(id: string, userId: string) {
  await getOwnedInvestigation(id, userId);
  const artifacts = await db().selectFrom('artifacts').select('id').where('investigation_id', '=', id).execute();
  await db().updateTable('investigation_jobs').set({ cancel_requested: 1 }).where('investigation_id', '=', id).execute();
  await db().deleteFrom('investigations').where('id', '=', id).where('owner_id', '=', userId).execute();
  await deleteInvestigationFiles(id, artifacts.map((a) => a.id));
}

export async function removeTarget(investigationId: string, userId: string, targetId: string) {
  const inv = await getOwnedInvestigation(investigationId, userId);
  if (inv.status === 'running' || inv.status === 'queued') throw conflict('Targets cannot be removed while collection is running.');
  const t = await db().selectFrom('targets').selectAll().where('id', '=', targetId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!t) throw notFound('Target');
  await db().deleteFrom('targets').where('id', '=', targetId).execute();
  await db().updateTable('entities').set({ is_target: 0 }).where('investigation_id', '=', investigationId).where('type', '=', TARGET_ENTITY[t.type as TargetType]).where('value', '=', t.normalized_value).execute();
}

export async function jobProgress(investigationId: string, userId: string) {
  await getOwnedInvestigation(investigationId, userId);
  const jobs = await db().selectFrom('investigation_jobs').selectAll().where('investigation_id', '=', investigationId).orderBy('created_at', 'desc').limit(20).execute();
  const latest = jobs.find((j) => j.kind === 'investigation') ?? null;
  const tasks = await db()
    .selectFrom('job_tasks')
    .select(['id', 'job_id', 'provider_id', 'operation', 'stage', 'status', 'attempts', 'started_at', 'finished_at', 'duration_ms', 'result_count', 'error_category', 'error_message', 'notes', 'input', 'target_id'])
    .where('investigation_id', '=', investigationId)
    .where('job_id', 'in', jobs.length ? jobs.map((j) => j.id) : ['00000000-0000-0000-0000-000000000000'])
    .orderBy('created_at')
    .execute();
  const inv = await db().selectFrom('investigations').select(['status']).where('id', '=', investigationId).executeTakeFirstOrThrow();
  return {
    status: inv.status,
    latestJob: latest ? jobSummary(latest) : null,
    jobs: jobs.map(jobSummary),
    tasks: tasks.map((t) => {
      const input = fromJson<{ subject?: { type: string; display: string; derived?: string }; params?: Record<string, unknown> }>(t.input, {});
      return {
        id: t.id,
        jobId: t.job_id,
        providerId: t.provider_id,
        providerName: getProvider(t.provider_id)?.name ?? t.provider_id,
        operation: t.operation,
        stage: t.stage,
        status: t.status,
        attempts: t.attempts,
        startedAt: t.started_at,
        finishedAt: t.finished_at,
        durationMs: t.duration_ms,
        resultCount: t.result_count,
        errorCategory: t.error_category,
        errorMessage: t.error_message,
        notes: fromJson<string[]>(t.notes, []),
        subject: input.subject ? { type: input.subject.type, display: input.subject.display, derived: input.subject.derived ?? null } : null,
        query: typeof input.params?.query === 'string' ? input.params.query : null,
      };
    }),
  };
}
