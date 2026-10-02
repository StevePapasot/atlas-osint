import 'server-only';
import { randomUUID } from 'node:crypto';
import { sql, type SqlBool, type ExpressionBuilder } from 'kysely';
import { z } from 'zod';
import { db } from '../db/client';
import { bool, fromJson, nowIso, toJson } from '../db/json';
import type { Database } from '../db/schema';
import { ApiError, conflict, notFound } from '../api/errors';
import { recomputeFindingConfidence } from '../engine/persist';
import { getProvider } from '../providers/registry';
import { CONFIDENCE_LEVELS, VERIFICATION_STATUSES, ENTITY_TYPES, EVIDENCE_CATEGORIES, CLAIM_TYPES } from '@/shared/domain';

// ------------------------------------------------------------------------------------------------ findings

export const findingsQuerySchema = z.object({
  q: z.string().max(200).optional(),
  entityType: z.enum(ENTITY_TYPES).optional(),
  provider: z.string().max(80).optional(),
  source: z.string().max(200).optional(),
  confidence: z.enum(CONFIDENCE_LEVELS).optional(),
  verification: z.enum(VERIFICATION_STATUSES).optional(),
  category: z.enum(EVIDENCE_CATEGORIES).optional(),
  claimType: z.enum(CLAIM_TYPES).optional(),
  location: z.string().max(120).optional(),
  dateFrom: z.string().max(40).optional(),
  dateTo: z.string().max(40).optional(),
  dateField: z.enum(['collected', 'published']).default('collected'),
  bookmarked: z.enum(['true', 'false']).optional(),
  tag: z.string().max(80).optional(),
  entityId: z.string().uuid().optional(),
  hasGeo: z.enum(['true']).optional(),
  includeFalsePositives: z.enum(['true', 'false']).optional(),
  sort: z.enum(['collected_at', 'published_at', 'confidence', 'title', 'source_count', 'category']).default('collected_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
export type FindingsQuery = z.infer<typeof findingsQuerySchema>;

const like = (s: string) => `%${s.toLowerCase().replace(/[%_\\]/g, '')}%`;

export async function listFindings(investigationId: string, q: FindingsQuery) {
  const k = db();
  const filter = (eb: ExpressionBuilder<Database, 'findings'>) => {
    const conds = [eb('findings.investigation_id', '=', investigationId)];
    if (q.q) conds.push(eb.or([eb(eb.fn('lower', ['findings.title']), 'like', like(q.q)), eb(eb.fn('lower', ['findings.description']), 'like', like(q.q))]));
    if (q.confidence) conds.push(eb('findings.confidence', '=', q.confidence));
    if (q.verification) conds.push(eb('findings.verification_status', '=', q.verification));
    else if (q.includeFalsePositives !== 'true') conds.push(eb('findings.verification_status', '!=', 'false_positive'));
    if (q.category) conds.push(eb('findings.category', '=', q.category));
    if (q.claimType) conds.push(eb('findings.claim_type', '=', q.claimType));
    if (q.bookmarked) conds.push(eb('findings.bookmarked', '=', q.bookmarked === 'true' ? 1 : 0));
    if (q.entityId) conds.push(eb('findings.entity_id', '=', q.entityId));
    if (q.hasGeo) conds.push(eb('findings.geo_precision', 'is not', null));
    if (q.location) conds.push(eb.or([eb(eb.fn('lower', ['findings.geo_place']), 'like', like(q.location)), eb(eb.fn('lower', ['findings.geo_country']), 'like', like(q.location))]));
    const dateCol = q.dateField === 'published' ? 'findings.published_at' : 'findings.collected_at';
    if (q.dateFrom) conds.push(eb(dateCol, '>=', q.dateFrom));
    if (q.dateTo) conds.push(eb(dateCol, '<=', q.dateTo.length === 10 ? `${q.dateTo}T23:59:59.999Z` : q.dateTo));
    if (q.entityType) conds.push(eb.exists(eb.selectFrom('entities').select('entities.id').whereRef('entities.id', '=', 'findings.entity_id').where('entities.type', '=', q.entityType)));
    if (q.provider) {
      conds.push(
        eb.exists(
          eb.selectFrom('finding_observations as fo').innerJoin('observations as o', 'o.id', 'fo.observation_id').select('o.id').whereRef('fo.finding_id', '=', 'findings.id').where('o.provider_id', '=', q.provider),
        ),
      );
    }
    if (q.source) {
      conds.push(
        eb.exists(
          eb
            .selectFrom('finding_observations as fo')
            .innerJoin('observations as o', 'o.id', 'fo.observation_id')
            .innerJoin('sources as s', 's.id', 'o.source_id')
            .select('o.id')
            .whereRef('fo.finding_id', '=', 'findings.id')
            .where((e2) => e2.or([e2(e2.fn('lower', ['s.name']), 'like', like(q.source!)), e2(e2.fn('lower', ['o.source_url']), 'like', like(q.source!))])),
        ),
      );
    }
    if (q.tag) {
      conds.push(eb.exists(eb.selectFrom('finding_tags as ft').innerJoin('tags as t', 't.id', 'ft.tag_id').select('ft.tag_id').whereRef('ft.finding_id', '=', 'findings.id').where('t.name', '=', q.tag)));
    }
    return eb.and(conds) as unknown as ReturnType<typeof eb.and> & SqlBool;
  };
  const total = Number((await k.selectFrom('findings').select((eb) => eb.fn.countAll<number>().as('n')).where(filter).executeTakeFirst())?.n ?? 0);
  let query = k
    .selectFrom('findings')
    .leftJoin('entities', 'entities.id', 'findings.entity_id')
    .selectAll('findings')
    .select(['entities.type as entity_type', 'entities.display_value as entity_display', 'entities.value as entity_value'])
    .where(filter);
  if (q.sort === 'confidence') {
    const rank = sql<number>`CASE findings.confidence WHEN 'verified' THEN 5 WHEN 'high' THEN 4 WHEN 'moderate' THEN 3 WHEN 'low' THEN 2 ELSE 1 END`;
    query = query.orderBy(rank, q.order).orderBy('findings.confidence_score', q.order);
  } else {
    query = query.orderBy(`findings.${q.sort}`, q.order);
  }
  const rows = await query.orderBy('findings.id').limit(q.pageSize).offset((q.page - 1) * q.pageSize).execute();
  const ids = rows.map((r) => r.id);
  const tagRows = ids.length
    ? await k.selectFrom('finding_tags').innerJoin('tags', 'tags.id', 'finding_tags.tag_id').select(['finding_tags.finding_id', 'tags.name', 'tags.color']).where('finding_tags.finding_id', 'in', ids).execute()
    : [];
  const providerRows = ids.length
    ? await k
        .selectFrom('finding_observations as fo')
        .innerJoin('observations as o', 'o.id', 'fo.observation_id')
        .select(['fo.finding_id', 'o.provider_id'])
        .where('fo.finding_id', 'in', ids)
        .groupBy(['fo.finding_id', 'o.provider_id'])
        .execute()
    : [];
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    items: rows.map((r) => ({
      ...findingDto(r),
      entity: r.entity_id ? { id: r.entity_id, type: r.entity_type, display: r.entity_display, value: r.entity_value } : null,
      tags: tagRows.filter((t) => t.finding_id === r.id).map((t) => ({ name: t.name, color: t.color })),
      providers: [...new Set(providerRows.filter((p) => p.finding_id === r.id).map((p) => p.provider_id))],
    })),
  };
}

type FindingRow = Database['findings'] extends infer T ? { [K in keyof T]: T[K] extends { __select__: infer S } ? S : T[K] } : never;

export function findingDto(r: Record<string, unknown> & { id: string }) {
  const f = r as unknown as FindingRow & { id: string };
  return {
    id: f.id,
    entityId: f.entity_id as string | null,
    title: f.title as string,
    description: f.description as string | null,
    category: f.category as string,
    claimType: f.claim_type as string,
    confidence: f.confidence as string,
    confidenceScore: f.confidence_score as number,
    confidenceRationale: fromJson<string[]>(f.confidence_rationale, []),
    verificationStatus: f.verification_status as string,
    sourceCount: f.source_count as number,
    providerCount: f.provider_count as number,
    primarySourceUrl: f.primary_source_url as string | null,
    primaryProviderId: f.primary_provider_id as string,
    collectedAt: f.collected_at as string,
    publishedAt: f.published_at as string | null,
    publishedPrecision: f.published_precision as string | null,
    geo:
      f.geo_precision != null
        ? { lat: f.geo_lat as number | null, lon: f.geo_lon as number | null, precision: f.geo_precision as string, place: f.geo_place as string | null, country: f.geo_country as string | null, basis: f.geo_basis as string | null }
        : null,
    bookmarked: bool(f.bookmarked),
    isSimulated: bool(f.is_simulated),
    createdAt: f.created_at as string,
    updatedAt: f.updated_at as string,
  };
}

async function ownedFinding(investigationId: string, findingId: string) {
  const f = await db().selectFrom('findings').selectAll().where('id', '=', findingId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!f) throw notFound('Finding');
  return f;
}

export async function getFindingDetail(investigationId: string, findingId: string) {
  const k = db();
  const f = await ownedFinding(investigationId, findingId);
  const [entity, observations, evidence, reviews, notes, tags, events] = await Promise.all([
    f.entity_id ? k.selectFrom('entities').selectAll().where('id', '=', f.entity_id).executeTakeFirst() : Promise.resolve(undefined),
    k
      .selectFrom('finding_observations as fo')
      .innerJoin('observations as o', 'o.id', 'fo.observation_id')
      .innerJoin('sources as s', 's.id', 'o.source_id')
      .select(['o.id', 'o.provider_id', 'o.title', 'o.description', 'o.source_url', 'o.collected_at', 'o.published_at', 'o.published_precision', 'o.claim_type', 'o.confidence_inputs', 'o.limitations', 'o.metadata', 'o.is_simulated', 's.name as source_name', 's.reliability as source_reliability', 's.kind as source_kind'])
      .where('fo.finding_id', '=', findingId)
      .orderBy('o.collected_at')
      .execute(),
    k
      .selectFrom('finding_evidence as fe')
      .innerJoin('evidence as e', 'e.id', 'fe.evidence_id')
      .select(['e.id', 'e.kind', 'e.title', 'e.content', 'e.content_type', 'e.sha256', 'e.source_url', 'e.provider_id', 'e.collected_at', 'e.is_simulated'])
      .where('fe.finding_id', '=', findingId)
      .orderBy('e.collected_at')
      .execute(),
    k.selectFrom('finding_reviews').innerJoin('users', 'users.id', 'finding_reviews.user_id').select(['finding_reviews.id', 'from_status', 'to_status', 'rationale', 'finding_reviews.created_at', 'users.name as reviewer']).where('finding_id', '=', findingId).orderBy('finding_reviews.created_at', 'desc').execute(),
    k.selectFrom('analyst_notes').innerJoin('users', 'users.id', 'analyst_notes.author_id').select(['analyst_notes.id', 'body', 'analyst_notes.created_at', 'users.name as author']).where('finding_id', '=', findingId).orderBy('analyst_notes.created_at', 'desc').execute(),
    k.selectFrom('finding_tags').innerJoin('tags', 'tags.id', 'finding_tags.tag_id').select(['tags.id', 'tags.name', 'tags.color']).where('finding_id', '=', findingId).execute(),
    k.selectFrom('timeline_events').selectAll().where('finding_id', '=', findingId).orderBy('event_date').execute(),
  ]);
  const related = f.entity_id
    ? await k.selectFrom('findings').select(['id', 'title', 'confidence', 'category', 'claim_type']).where('investigation_id', '=', investigationId).where('entity_id', '=', f.entity_id).where('id', '!=', findingId).orderBy('collected_at', 'desc').limit(15).execute()
    : [];
  return {
    ...findingDto(f),
    entity: entity ? { id: entity.id, type: entity.type, value: entity.value, display: entity.display_value, isTarget: bool(entity.is_target) } : null,
    observations: observations.map((o) => ({
      id: o.id,
      providerId: o.provider_id,
      providerName: getProvider(o.provider_id)?.name ?? o.provider_id,
      sourceName: o.source_name,
      sourceReliability: o.source_reliability,
      sourceKind: o.source_kind,
      title: o.title,
      description: o.description,
      sourceUrl: o.source_url,
      collectedAt: o.collected_at,
      publishedAt: o.published_at,
      publishedPrecision: o.published_precision,
      claimType: o.claim_type,
      confidenceInputs: fromJson<Record<string, unknown>>(o.confidence_inputs, {}),
      limitations: fromJson<string[]>(o.limitations, []),
      metadata: fromJson<Record<string, unknown>>(o.metadata, {}),
      isSimulated: bool(o.is_simulated),
    })),
    evidence: evidence.map((e) => ({ ...e, content: e.content.slice(0, 20_000), isSimulated: bool(e.is_simulated) })),
    reviews,
    notes,
    tags,
    events: events.map((e) => ({ id: e.id, date: e.event_date, precision: e.date_precision, kind: e.date_kind, label: e.label })),
    related,
  };
}

export const reviewSchema = z.object({
  status: z.enum(VERIFICATION_STATUSES),
  rationale: z.string().trim().max(2000).optional(),
});

export async function reviewFinding(investigationId: string, findingId: string, userId: string, input: z.infer<typeof reviewSchema>) {
  const f = await ownedFinding(investigationId, findingId);
  if (input.status !== 'unreviewed' && (!input.rationale || input.rationale.length < 10)) {
    throw new ApiError(400, 'rationale_required', 'A rationale is required: explain the evidence behind this decision (at least 10 characters). Verification means the claim was checked against adequate evidence.');
  }
  if (f.verification_status === input.status) return { unchanged: true };
  await db().transaction().execute(async (tx) => {
    await tx
      .insertInto('finding_reviews')
      .values({ id: randomUUID(), finding_id: findingId, investigation_id: investigationId, user_id: userId, from_status: f.verification_status, to_status: input.status, rationale: input.rationale ?? null, created_at: nowIso() })
      .execute();
    await tx.updateTable('findings').set({ verification_status: input.status, updated_at: nowIso() }).where('id', '=', findingId).execute();
    await recomputeFindingConfidence(tx, findingId);
  });
  return { unchanged: false, from: f.verification_status, to: input.status };
}

export const findingPatchSchema = z.object({
  bookmarked: z.boolean().optional(),
  addTags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  removeTags: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});

const TAG_COLORS = ['sky', 'violet', 'amber', 'emerald', 'rose', 'slate', 'teal', 'orange'];

export async function ensureTag(investigationId: string, name: string): Promise<string> {
  const existing = await db().selectFrom('tags').select('id').where('investigation_id', '=', investigationId).where('name', '=', name).executeTakeFirst();
  if (existing) return existing.id;
  const id = randomUUID();
  const count = Number((await db().selectFrom('tags').select((eb) => eb.fn.countAll<number>().as('n')).where('investigation_id', '=', investigationId).executeTakeFirst())?.n ?? 0);
  await db().insertInto('tags').values({ id, investigation_id: investigationId, name, color: TAG_COLORS[count % TAG_COLORS.length]!, created_at: nowIso() }).onConflict((oc) => oc.doNothing()).execute();
  return (await db().selectFrom('tags').select('id').where('investigation_id', '=', investigationId).where('name', '=', name).executeTakeFirstOrThrow()).id;
}

export async function patchFinding(investigationId: string, findingId: string, patch: z.infer<typeof findingPatchSchema>) {
  await ownedFinding(investigationId, findingId);
  if (patch.bookmarked !== undefined) await db().updateTable('findings').set({ bookmarked: patch.bookmarked ? 1 : 0, updated_at: nowIso() }).where('id', '=', findingId).execute();
  for (const name of patch.addTags ?? []) {
    const tagId = await ensureTag(investigationId, name);
    await db().insertInto('finding_tags').values({ finding_id: findingId, tag_id: tagId }).onConflict((oc) => oc.doNothing()).execute();
  }
  for (const name of patch.removeTags ?? []) {
    const t = await db().selectFrom('tags').select('id').where('investigation_id', '=', investigationId).where('name', '=', name).executeTakeFirst();
    if (t) await db().deleteFrom('finding_tags').where('finding_id', '=', findingId).where('tag_id', '=', t.id).execute();
  }
}

export async function listTags(investigationId: string) {
  return db()
    .selectFrom('tags')
    .leftJoin('finding_tags', 'finding_tags.tag_id', 'tags.id')
    .select(['tags.id', 'tags.name', 'tags.color', (eb) => eb.fn.count<number>('finding_tags.finding_id').as('count')])
    .where('tags.investigation_id', '=', investigationId)
    .groupBy(['tags.id', 'tags.name', 'tags.color'])
    .orderBy('tags.name')
    .execute();
}

// ------------------------------------------------------------------------------------------------ evidence

export async function listEvidence(investigationId: string, opts: { kind?: string; provider?: string; q?: string; page: number; pageSize: number }) {
  const k = db();
  let base = k.selectFrom('evidence').where('investigation_id', '=', investigationId);
  if (opts.kind) base = base.where('kind', '=', opts.kind);
  if (opts.provider) base = base.where('provider_id', '=', opts.provider);
  if (opts.q) base = base.where((eb) => eb.or([eb(eb.fn('lower', ['title']), 'like', like(opts.q!)), eb(eb.fn('lower', ['content']), 'like', like(opts.q!))]));
  const total = Number((await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
  const rows = await base
    .select(['id', 'kind', 'title', 'content_type', 'sha256', 'source_url', 'provider_id', 'collected_at', 'is_simulated', 'observation_id', 'artifact_id', sql<string>`substr(content, 1, 400)`.as('preview')])
    .orderBy('collected_at', 'desc')
    .orderBy('id')
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize)
    .execute();
  const ids = rows.map((r) => r.id);
  const links = ids.length ? await k.selectFrom('finding_evidence').select(['evidence_id', 'finding_id']).where('evidence_id', 'in', ids).execute() : [];
  return {
    total,
    page: opts.page,
    pageSize: opts.pageSize,
    items: rows.map((r) => ({ ...r, providerName: r.provider_id ? getProvider(r.provider_id)?.name ?? r.provider_id : null, isSimulated: bool(r.is_simulated), findingIds: links.filter((l) => l.evidence_id === r.id).map((l) => l.finding_id) })),
  };
}

export async function getEvidence(investigationId: string, evidenceId: string) {
  const e = await db().selectFrom('evidence').selectAll().where('id', '=', evidenceId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!e) throw notFound('Evidence');
  const findings = await db().selectFrom('finding_evidence').innerJoin('findings', 'findings.id', 'finding_evidence.finding_id').select(['findings.id', 'findings.title', 'findings.confidence']).where('evidence_id', '=', evidenceId).execute();
  return { ...e, isSimulated: bool(e.is_simulated), findings };
}

// ------------------------------------------------------------------------------------------------ entities, relationships, graph

export async function listEntities(investigationId: string, opts: { type?: string; q?: string; limit?: number }) {
  const k = db();
  let q = k
    .selectFrom('entities')
    .select([
      'entities.id', 'entities.type', 'entities.value', 'entities.display_value', 'entities.attributes', 'entities.is_target', 'entities.is_simulated', 'entities.cluster_id', 'entities.first_seen_at', 'entities.last_seen_at',
      (eb) => eb.selectFrom('findings').select((e2) => e2.fn.countAll<number>().as('n')).whereRef('findings.entity_id', '=', 'entities.id').as('finding_count'),
      (eb) => eb.selectFrom('relationships').select((e2) => e2.fn.countAll<number>().as('n')).where((e2) => e2.or([e2('relationships.from_entity_id', '=', e2.ref('entities.id')), e2('relationships.to_entity_id', '=', e2.ref('entities.id'))])).where('relationships.status', '!=', 'rejected').as('relationship_count'),
    ])
    .where('entities.investigation_id', '=', investigationId);
  if (opts.type) q = q.where('entities.type', '=', opts.type);
  if (opts.q) q = q.where((eb) => eb.or([eb(eb.fn('lower', ['entities.value']), 'like', like(opts.q!)), eb(eb.fn('lower', ['entities.display_value']), 'like', like(opts.q!))]));
  const rows = await q.orderBy('entities.is_target', 'desc').orderBy('entities.type').orderBy('entities.value').limit(Math.min(opts.limit ?? 500, 2000)).execute();
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    value: r.value,
    display: r.display_value,
    attributes: fromJson<Record<string, unknown>>(r.attributes, {}),
    isTarget: bool(r.is_target),
    isSimulated: bool(r.is_simulated),
    clusterId: r.cluster_id,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    findingCount: Number(r.finding_count ?? 0),
    relationshipCount: Number(r.relationship_count ?? 0),
  }));
}

export async function getEntityDetail(investigationId: string, entityId: string) {
  const k = db();
  const e = await k.selectFrom('entities').selectAll().where('id', '=', entityId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!e) throw notFound('Entity');
  const rels = await relationshipsFor(investigationId, { entityId });
  const findings = await k.selectFrom('findings').select(['id', 'title', 'confidence', 'claim_type', 'category', 'verification_status', 'collected_at']).where('entity_id', '=', entityId).orderBy('collected_at', 'desc').limit(50).execute();
  const candidates = await listCandidates(investigationId, { entityId });
  return {
    id: e.id,
    type: e.type,
    value: e.value,
    display: e.display_value,
    attributes: fromJson<Record<string, unknown>>(e.attributes, {}),
    isTarget: bool(e.is_target),
    isSimulated: bool(e.is_simulated),
    clusterId: e.cluster_id,
    firstSeenAt: e.first_seen_at,
    lastSeenAt: e.last_seen_at,
    relationships: rels,
    findings,
    candidates,
  };
}

export async function relationshipsFor(investigationId: string, opts: { entityId?: string; types?: string[]; includeRejected?: boolean }) {
  const k = db();
  let q = k
    .selectFrom('relationships as r')
    .innerJoin('entities as f', 'f.id', 'r.from_entity_id')
    .innerJoin('entities as t', 't.id', 'r.to_entity_id')
    .select([
      'r.id', 'r.type', 'r.status', 'r.confidence', 'r.rationale', 'r.first_seen_at', 'r.last_seen_at', 'r.is_simulated',
      'f.id as from_id', 'f.type as from_type', 'f.display_value as from_display',
      't.id as to_id', 't.type as to_type', 't.display_value as to_display',
      (eb) => eb.selectFrom('relationship_evidence as re').select((e2) => e2.fn.countAll<number>().as('n')).whereRef('re.relationship_id', '=', 'r.id').as('evidence_count'),
    ])
    .where('r.investigation_id', '=', investigationId);
  if (opts.entityId) q = q.where((eb) => eb.or([eb('r.from_entity_id', '=', opts.entityId!), eb('r.to_entity_id', '=', opts.entityId!)]));
  if (opts.types?.length) q = q.where('r.type', 'in', opts.types);
  if (!opts.includeRejected) q = q.where('r.status', '!=', 'rejected');
  const rows = await q.orderBy('r.first_seen_at').limit(5000).execute();
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    confidence: r.confidence,
    rationale: r.rationale,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    isSimulated: bool(r.is_simulated),
    evidenceCount: Number(r.evidence_count ?? 0),
    from: { id: r.from_id, type: r.from_type, display: r.from_display },
    to: { id: r.to_id, type: r.to_type, display: r.to_display },
  }));
}

export async function getRelationshipDetail(investigationId: string, relationshipId: string) {
  const rel = (await relationshipsFor(investigationId, { includeRejected: true })).find((r) => r.id === relationshipId);
  if (!rel) throw notFound('Relationship');
  const evidence = await db()
    .selectFrom('relationship_evidence as re')
    .innerJoin('evidence as e', 'e.id', 're.evidence_id')
    .select(['e.id', 'e.kind', 'e.title', sql<string>`substr(e.content, 1, 1200)`.as('content'), 'e.source_url', 'e.provider_id', 'e.collected_at', 'e.sha256'])
    .where('re.relationship_id', '=', relationshipId)
    .execute();
  return { ...rel, evidence };
}

export const relationshipPatchSchema = z.object({ status: z.enum(['confirmed', 'possible', 'rejected']), rationale: z.string().trim().min(10).max(1000) });

export async function updateRelationship(investigationId: string, relationshipId: string, patch: z.infer<typeof relationshipPatchSchema>) {
  const r = await db().selectFrom('relationships').select('id').where('id', '=', relationshipId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!r) throw notFound('Relationship');
  await db().updateTable('relationships').set({ status: patch.status, rationale: `Analyst: ${patch.rationale}`, last_seen_at: nowIso() }).where('id', '=', relationshipId).execute();
}

export async function buildGraph(investigationId: string, opts: { relTypes?: string[]; entityTypes?: string[]; includePossible?: boolean; limit?: number }) {
  const rels = (await relationshipsFor(investigationId, { types: opts.relTypes })).filter((r) => opts.includePossible !== false || r.status === 'confirmed');
  const entities = await listEntities(investigationId, { limit: 2000 });
  const allowedTypes = opts.entityTypes?.length ? new Set(opts.entityTypes) : null;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const edges = rels.filter((r) => {
    const a = byId.get(r.from.id);
    const b = byId.get(r.to.id);
    return a && b && (!allowedTypes || (allowedTypes.has(a.type) && allowedTypes.has(b.type)));
  });
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from.id, (degree.get(e.from.id) ?? 0) + 1);
    degree.set(e.to.id, (degree.get(e.to.id) ?? 0) + 1);
  }
  const limit = Math.min(opts.limit ?? 400, 1500);
  const nodeIds = new Set<string>();
  for (const e of entities) if (e.isTarget && (!allowedTypes || allowedTypes.has(e.type))) nodeIds.add(e.id);
  for (const [id] of [...degree.entries()].sort((a, b) => b[1] - a[1])) {
    if (nodeIds.size >= limit) break;
    nodeIds.add(id);
  }
  const keptEdges = edges.filter((e) => nodeIds.has(e.from.id) && nodeIds.has(e.to.id));
  return {
    truncated: nodeIds.size < new Set([...degree.keys()]).size,
    nodes: [...nodeIds].map((id) => {
      const e = byId.get(id)!;
      return { id, type: e.type, label: e.display, value: e.value, isTarget: e.isTarget, isSimulated: e.isSimulated, clusterId: e.clusterId, degree: degree.get(id) ?? 0, findingCount: e.findingCount };
    }),
    edges: keptEdges.map((e) => ({ id: e.id, source: e.from.id, target: e.to.id, type: e.type, status: e.status, confidence: e.confidence, rationale: e.rationale, evidenceCount: e.evidenceCount, isSimulated: e.isSimulated })),
  };
}

// ------------------------------------------------------------------------------------------------ candidates (entity resolution)

export async function listCandidates(investigationId: string, opts: { status?: string; entityId?: string } = {}) {
  let q = db()
    .selectFrom('entity_match_candidates as c')
    .innerJoin('entities as a', 'a.id', 'c.entity_a_id')
    .innerJoin('entities as b', 'b.id', 'c.entity_b_id')
    .leftJoin('users as u', 'u.id', 'c.decided_by')
    .select(['c.id', 'c.signals', 'c.strength', 'c.status', 'c.decided_at', 'c.created_at', 'u.name as decided_by_name', 'a.id as a_id', 'a.display_value as a_display', 'a.type as a_type', 'a.attributes as a_attributes', 'b.id as b_id', 'b.display_value as b_display', 'b.type as b_type', 'b.attributes as b_attributes'])
    .where('c.investigation_id', '=', investigationId);
  if (opts.status) q = q.where('c.status', '=', opts.status as 'pending' | 'accepted' | 'rejected' | 'separated');
  if (opts.entityId) q = q.where((eb) => eb.or([eb('c.entity_a_id', '=', opts.entityId!), eb('c.entity_b_id', '=', opts.entityId!)]));
  const rows = await q.orderBy(sql`CASE c.strength WHEN 'strong' THEN 0 WHEN 'moderate' THEN 1 ELSE 2 END`).orderBy('c.created_at').execute();
  return rows.map((r) => ({
    id: r.id,
    strength: r.strength,
    status: r.status,
    signals: fromJson<Array<{ signal: string; weight: string; detail: string }>>(r.signals, []),
    decidedAt: r.decided_at,
    decidedBy: r.decided_by_name,
    createdAt: r.created_at,
    a: { id: r.a_id, display: r.a_display, type: r.a_type, attributes: fromJson<Record<string, unknown>>(r.a_attributes, {}) },
    b: { id: r.b_id, display: r.b_display, type: r.b_type, attributes: fromJson<Record<string, unknown>>(r.b_attributes, {}) },
  }));
}

export const candidateDecisionSchema = z.object({ decision: z.enum(['accept', 'reject', 'separate']), rationale: z.string().trim().min(10).max(1000) });

export async function decideCandidate(investigationId: string, candidateId: string, userId: string, input: z.infer<typeof candidateDecisionSchema>) {
  const k = db();
  const c = await k.selectFrom('entity_match_candidates').selectAll().where('id', '=', candidateId).where('investigation_id', '=', investigationId).executeTakeFirst();
  if (!c) throw notFound('Candidate');
  const now = nowIso();
  if (input.decision === 'separate' && c.status !== 'accepted') throw conflict('Only accepted matches can be separated.');
  if (input.decision !== 'separate' && c.status !== 'pending') throw conflict(`Candidate already ${c.status}.`);
  await k.transaction().execute(async (tx) => {
    if (input.decision === 'accept') {
      const [a, b] = await Promise.all([
        tx.selectFrom('entities').select(['id', 'cluster_id']).where('id', '=', c.entity_a_id).executeTakeFirstOrThrow(),
        tx.selectFrom('entities').select(['id', 'cluster_id']).where('id', '=', c.entity_b_id).executeTakeFirstOrThrow(),
      ]);
      const cluster = a.cluster_id ?? b.cluster_id ?? randomUUID();
      await tx.updateTable('entities').set({ cluster_id: cluster }).where('id', 'in', [a.id, b.id]).execute();
      if (a.cluster_id && b.cluster_id && a.cluster_id !== b.cluster_id) {
        await tx.updateTable('entities').set({ cluster_id: cluster }).where('cluster_id', '=', b.cluster_id).execute();
      }
      await tx
        .insertInto('relationships')
        .values({ id: randomUUID(), investigation_id: investigationId, from_entity_id: c.entity_a_id, to_entity_id: c.entity_b_id, type: 'SIMILAR_TO', status: 'confirmed', confidence: 'high', rationale: `Analyst-confirmed identity match: ${input.rationale}`, is_simulated: 0, first_seen_at: now, last_seen_at: now })
        .onConflict((oc) => oc.columns(['investigation_id', 'from_entity_id', 'to_entity_id', 'type']).doUpdateSet({ status: 'confirmed', confidence: 'high', rationale: `Analyst-confirmed identity match: ${input.rationale}`, last_seen_at: now }))
        .execute();
      await tx.updateTable('entity_match_candidates').set({ status: 'accepted', decided_by: userId, decided_at: now }).where('id', '=', candidateId).execute();
    } else if (input.decision === 'reject') {
      await tx.updateTable('entity_match_candidates').set({ status: 'rejected', decided_by: userId, decided_at: now }).where('id', '=', candidateId).execute();
    } else {
      await tx.updateTable('entities').set({ cluster_id: null }).where('id', '=', c.entity_b_id).execute();
      const remaining = await tx.selectFrom('entities').select('id').where('cluster_id', '=', (await tx.selectFrom('entities').select('cluster_id').where('id', '=', c.entity_a_id).executeTakeFirst())?.cluster_id ?? '').execute();
      if (remaining.length <= 1) await tx.updateTable('entities').set({ cluster_id: null }).where('id', '=', c.entity_a_id).execute();
      await tx
        .updateTable('relationships')
        .set({ status: 'rejected', rationale: `Analyst separated entities: ${input.rationale}`, last_seen_at: now })
        .where('investigation_id', '=', investigationId)
        .where('from_entity_id', '=', c.entity_a_id)
        .where('to_entity_id', '=', c.entity_b_id)
        .where('type', '=', 'SIMILAR_TO')
        .execute();
      await tx.updateTable('entity_match_candidates').set({ status: 'separated', decided_by: userId, decided_at: now }).where('id', '=', candidateId).execute();
    }
    await tx.insertInto('analyst_notes').values({ id: randomUUID(), investigation_id: investigationId, author_id: userId, finding_id: null, entity_id: c.entity_a_id, body: `Entity match ${input.decision}ed: ${input.rationale}`, created_at: now, updated_at: now }).execute();
  });
}

// ------------------------------------------------------------------------------------------------ timeline & geo

export async function getTimeline(investigationId: string, opts: { entityId?: string; kind?: string } = {}) {
  let q = db()
    .selectFrom('timeline_events as t')
    .leftJoin('entities as e', 'e.id', 't.entity_id')
    .leftJoin('findings as f', 'f.id', 't.finding_id')
    .select(['t.id', 't.event_date', 't.date_precision', 't.date_kind', 't.label', 't.description', 't.source_url', 't.provider_id', 't.is_simulated', 'e.id as entity_id', 'e.display_value as entity_display', 'e.type as entity_type', 'f.id as finding_id', 'f.confidence', 'f.verification_status', 'f.title as finding_title'])
    .where('t.investigation_id', '=', investigationId);
  if (opts.entityId) q = q.where('t.entity_id', '=', opts.entityId);
  if (opts.kind) q = q.where('t.date_kind', '=', opts.kind);
  const rows = await q.orderBy('t.event_date').limit(2000).execute();
  return rows
    .filter((r) => r.verification_status !== 'false_positive')
    .map((r) => ({
      id: r.id,
      date: r.event_date,
      precision: r.date_precision,
      kind: r.date_kind,
      label: r.label,
      description: r.description,
      sourceUrl: r.source_url,
      providerId: r.provider_id,
      providerName: r.provider_id ? getProvider(r.provider_id)?.name ?? r.provider_id : null,
      isSimulated: bool(r.is_simulated),
      entity: r.entity_id ? { id: r.entity_id, display: r.entity_display, type: r.entity_type } : null,
      finding: r.finding_id ? { id: r.finding_id, confidence: r.confidence, title: r.finding_title } : null,
    }));
}

export async function getGeoFindings(investigationId: string) {
  const res = await listFindings(investigationId, findingsQuerySchema.parse({ hasGeo: 'true', pageSize: 200, sort: 'confidence' }));
  return res.items;
}

// ------------------------------------------------------------------------------------------------ notes

export const noteSchema = z.object({ body: z.string().trim().min(1).max(10_000), findingId: z.string().uuid().optional(), entityId: z.string().uuid().optional() });

export async function listNotes(investigationId: string) {
  return db()
    .selectFrom('analyst_notes as n')
    .innerJoin('users as u', 'u.id', 'n.author_id')
    .leftJoin('findings as f', 'f.id', 'n.finding_id')
    .leftJoin('entities as e', 'e.id', 'n.entity_id')
    .select(['n.id', 'n.body', 'n.created_at', 'n.updated_at', 'u.name as author', 'n.author_id', 'f.id as finding_id', 'f.title as finding_title', 'e.id as entity_id', 'e.display_value as entity_display'])
    .where('n.investigation_id', '=', investigationId)
    .orderBy('n.created_at', 'desc')
    .execute();
}

export async function addNote(investigationId: string, userId: string, input: z.infer<typeof noteSchema>) {
  if (input.findingId) await ownedFinding(investigationId, input.findingId);
  if (input.entityId) {
    const e = await db().selectFrom('entities').select('id').where('id', '=', input.entityId).where('investigation_id', '=', investigationId).executeTakeFirst();
    if (!e) throw notFound('Entity');
  }
  const id = randomUUID();
  const now = nowIso();
  await db().insertInto('analyst_notes').values({ id, investigation_id: investigationId, author_id: userId, finding_id: input.findingId ?? null, entity_id: input.entityId ?? null, body: input.body, created_at: now, updated_at: now }).execute();
  return id;
}

export async function deleteNote(investigationId: string, userId: string, noteId: string) {
  const res = await db().deleteFrom('analyst_notes').where('id', '=', noteId).where('investigation_id', '=', investigationId).where('author_id', '=', userId).executeTakeFirst();
  if (Number(res.numDeletedRows) === 0) throw notFound('Note');
}

// ------------------------------------------------------------------------------------------------ sources & activity

export async function listSources(investigationId: string) {
  const rows = await db()
    .selectFrom('sources as s')
    .select(['s.id', 's.provider_id', 's.name', 's.url', 's.reliability', 's.kind', 's.first_seen_at', (eb) => eb.selectFrom('observations').select((e2) => e2.fn.countAll<number>().as('n')).whereRef('observations.source_id', '=', 's.id').as('observation_count')])
    .where('s.investigation_id', '=', investigationId)
    .orderBy('s.first_seen_at')
    .execute();
  return rows.map((r) => ({ ...r, providerName: getProvider(r.provider_id)?.name ?? r.provider_id, observationCount: Number(r.observation_count ?? 0) }));
}

export async function listActivity(investigationId: string, limit = 100) {
  return db()
    .selectFrom('audit_events as a')
    .leftJoin('users as u', 'u.id', 'a.user_id')
    .select(['a.id', 'a.action', 'a.target_type', 'a.target_id', 'a.metadata', 'a.created_at', 'u.name as user_name'])
    .where('a.investigation_id', '=', investigationId)
    .orderBy('a.created_at', 'desc')
    .limit(limit)
    .execute()
    .then((rows) => rows.map((r) => ({ ...r, metadata: fromJson<Record<string, unknown>>(r.metadata, {}) })));
}

export { toJson };
