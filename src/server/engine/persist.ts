/**
 * Persistence of normalized provider records into the evidence model:
 *   source → observation → evidence (hashed) → finding (deduplicated by fingerprint, provenance preserved)
 *   → entities → relationships (with supporting evidence) → timeline events.
 */
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../db/schema';
import { fromJson, nowIso, toJson } from '../db/json';
import { sha256Hex } from '../security/hash';
import { redactObject } from '../security/redact';
import type { ConfidenceInputs, NormalizedRecord, RecordEntity } from '../providers/types';
import { assessConfidence } from './confidence';
import { canonicalUrlKey } from '@/shared/targets';
import type { ConfidenceLevel, MatchType, SourceReliability, VerificationStatus } from '@/shared/domain';

type Tx = Transaction<Database> | Kysely<Database>;

const MAX_RAW_BYTES = 64 * 1024;
const MAX_TEXT = 20_000;

export function findingFingerprint(r: Pick<NormalizedRecord, 'fingerprintKey' | 'category' | 'entityType' | 'normalizedValue' | 'sourceUrl' | 'title'>): string {
  const key =
    r.fingerprintKey ??
    `${r.category}|${r.entityType}:${r.normalizedValue}|${r.sourceUrl ? canonicalUrlKey(r.sourceUrl) : r.title.toLowerCase().trim()}`;
  return sha256Hex(key);
}

function sourceKey(r: NormalizedRecord): { key: string; name: string; url: string | null } {
  if (r.sourceUrl) {
    try {
      const u = new URL(r.sourceUrl);
      return { key: `${r.providerId}|${u.hostname}`, name: r.sourceName, url: u.origin };
    } catch {
      /* fall through */
    }
  }
  return { key: `${r.providerId}|${r.sourceName}`, name: r.sourceName, url: null };
}

function snapshot(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  let text = JSON.stringify(redactObject(raw), null, 2);
  if (text.length > MAX_RAW_BYTES) text = text.slice(0, MAX_RAW_BYTES) + '\n…[truncated by ATLAS: snapshot size limit]';
  return text;
}

async function upsertEntity(
  tx: Tx,
  investigationId: string,
  e: { type: string; value: string; display?: string; attributes?: Record<string, unknown> },
  isSimulated: boolean,
  now: string,
): Promise<string> {
  const value = e.value.trim().slice(0, 1000);
  const existing = await tx
    .selectFrom('entities')
    .select(['id', 'attributes'])
    .where('investigation_id', '=', investigationId)
    .where('type', '=', e.type)
    .where('value', '=', value)
    .executeTakeFirst();
  if (existing) {
    const merged = e.attributes && Object.keys(e.attributes).length
      ? { ...fromJson<Record<string, unknown>>(existing.attributes, {}), ...Object.fromEntries(Object.entries(e.attributes).filter(([, v]) => v !== null && v !== undefined)) }
      : null;
    await tx
      .updateTable('entities')
      .set({ last_seen_at: now, ...(merged ? { attributes: toJson(merged) } : {}) })
      .where('id', '=', existing.id)
      .execute();
    return existing.id;
  }
  const id = randomUUID();
  await tx
    .insertInto('entities')
    .values({
      id,
      investigation_id: investigationId,
      type: e.type,
      value,
      display_value: (e.display ?? e.value).slice(0, 500),
      attributes: toJson(e.attributes ?? {}),
      cluster_id: null,
      is_target: 0,
      is_simulated: isSimulated ? 1 : 0,
      first_seen_at: now,
      last_seen_at: now,
    })
    .onConflict((oc) => oc.columns(['investigation_id', 'type', 'value']).doUpdateSet({ last_seen_at: now }))
    .execute();
  const row = await tx
    .selectFrom('entities')
    .select('id')
    .where('investigation_id', '=', investigationId)
    .where('type', '=', e.type)
    .where('value', '=', value)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Recompute a finding's confidence from all linked observations and its verification status. */
export async function recomputeFindingConfidence(tx: Tx, findingId: string): Promise<{ level: ConfidenceLevel; score: number }> {
  const finding = await tx.selectFrom('findings').select(['claim_type', 'verification_status', 'is_simulated']).where('id', '=', findingId).executeTakeFirstOrThrow();
  const obs = await tx
    .selectFrom('finding_observations')
    .innerJoin('observations', 'observations.id', 'finding_observations.observation_id')
    .select(['observations.provider_id', 'observations.confidence_inputs', 'observations.source_id'])
    .where('finding_observations.finding_id', '=', findingId)
    .execute();
  const inputs = obs.map((o) => fromJson<ConfidenceInputs>(o.confidence_inputs, { sourceReliability: 'unknown', matchType: 'none' }));
  const providers = new Set(obs.map((o) => o.provider_id));
  const sources = new Set(obs.map((o) => o.source_id));
  const a = assessConfidence({
    claimType: finding.claim_type as NormalizedRecord['claimType'],
    reliabilities: inputs.map((i) => i.sourceReliability as SourceReliability),
    matchTypes: inputs.map((i) => i.matchType as MatchType),
    providerCount: providers.size,
    verificationStatus: finding.verification_status as VerificationStatus,
    isSimulated: finding.is_simulated === 1,
  });
  await tx
    .updateTable('findings')
    .set({
      confidence: a.level,
      confidence_score: a.score,
      confidence_rationale: toJson(a.rationale),
      provider_count: Math.max(1, providers.size),
      source_count: Math.max(1, sources.size),
      updated_at: nowIso(),
    })
    .where('id', '=', findingId)
    .execute();
  return { level: a.level, score: a.score };
}

const LEVEL_ORDER: ConfidenceLevel[] = ['unverified', 'low', 'moderate', 'high', 'verified'];

export interface PersistContext {
  investigationId: string;
  taskId: string | null;
  targetId: string | null;
  providerKind: 'live' | 'local' | 'simulated';
}

export async function persistRecord(tx: Tx, ctx: PersistContext, r: NormalizedRecord): Promise<{ findingId: string; created: boolean }> {
  const now = nowIso();
  const simulated = Boolean(r.isSimulated);
  // 1. Source
  const sk = sourceKey(r);
  await tx
    .insertInto('sources')
    .values({
      id: randomUUID(),
      investigation_id: ctx.investigationId,
      provider_id: r.providerId,
      source_key: sk.key.slice(0, 500),
      name: sk.name.slice(0, 300),
      url: sk.url,
      reliability: r.confidenceInputs.sourceReliability,
      kind: simulated ? 'simulated' : ctx.providerKind,
      first_seen_at: now,
    })
    .onConflict((oc) => oc.columns(['investigation_id', 'source_key']).doNothing())
    .execute();
  const source = await tx.selectFrom('sources').select('id').where('investigation_id', '=', ctx.investigationId).where('source_key', '=', sk.key.slice(0, 500)).executeTakeFirstOrThrow();

  // 2. Entities
  const refToId = new Map<string, string>();
  const entityList: RecordEntity[] = [...(r.entities ?? [])];
  for (const e of entityList) {
    if (!e.value) continue;
    refToId.set(e.ref, await upsertEntity(tx, ctx.investigationId, e, simulated, now));
  }
  let subjectEntityId = r.subjectRef ? refToId.get(r.subjectRef) ?? null : null;
  if (!subjectEntityId) {
    const match = entityList.find((e) => e.type === r.entityType && e.value === r.normalizedValue);
    subjectEntityId = match ? refToId.get(match.ref)! : await upsertEntity(tx, ctx.investigationId, { type: r.entityType, value: r.normalizedValue }, simulated, now);
  }

  // Resolve attribute assertions to concrete entities so contradictions can be detected across providers.
  const resolvedAssertions = (r.assertions ?? []).map((a) => {
    const ent = entityList.find((e) => e.ref === a.subjectRef);
    return { entityType: ent?.type ?? r.entityType, entityValue: ent?.value ?? r.normalizedValue, attribute: a.attribute, value: a.value };
  });

  // 3. Observation
  const fingerprint = findingFingerprint(r);
  const observationId = randomUUID();
  await tx
    .insertInto('observations')
    .values({
      id: observationId,
      investigation_id: ctx.investigationId,
      task_id: ctx.taskId,
      provider_id: r.providerId,
      source_id: source.id,
      target_id: ctx.targetId,
      entity_type: r.entityType,
      normalized_value: r.normalizedValue.slice(0, 1000),
      title: r.title.slice(0, 500),
      description: r.description?.slice(0, 4000) ?? null,
      excerpt: r.excerpt?.slice(0, MAX_TEXT) ?? null,
      source_url: r.sourceUrl,
      published_at: r.publishedAt ?? null,
      published_precision: r.publishedPrecision ?? null,
      collected_at: r.collectedAt,
      category: r.category,
      claim_type: r.claimType,
      metadata: toJson(redactObject({ ...(r.metadata ?? {}), assertions: resolvedAssertions })),
      confidence_inputs: toJson(r.confidenceInputs),
      limitations: toJson(r.limitations ?? []),
      is_simulated: simulated ? 1 : 0,
      fingerprint,
    })
    .execute();

  // 4. Evidence (content-hashed for integrity)
  const evidenceIds: string[] = [];
  const addEvidence = async (kind: string, title: string, content: string, contentType: string) => {
    const id = randomUUID();
    await tx
      .insertInto('evidence')
      .values({
        id,
        investigation_id: ctx.investigationId,
        observation_id: observationId,
        artifact_id: typeof r.metadata?.artifactId === 'string' ? (r.metadata.artifactId as string) : null,
        kind,
        title: title.slice(0, 300),
        content,
        content_type: contentType,
        sha256: sha256Hex(content),
        source_url: r.sourceUrl,
        provider_id: r.providerId,
        collected_at: r.collectedAt,
        is_simulated: simulated ? 1 : 0,
        redacted: 0,
      })
      .execute();
    evidenceIds.push(id);
  };
  if (r.excerpt) await addEvidence('excerpt', `Excerpt — ${r.sourceName}`, r.excerpt.slice(0, MAX_TEXT), 'text/plain');
  const snap = snapshot(r.raw);
  if (snap) await addEvidence('api_response', `Provider response — ${r.sourceName}`, snap, 'application/json');
  if (!evidenceIds.length) await addEvidence('metadata', `Observation — ${r.sourceName}`, `${r.title}\n${r.description ?? ''}`.trim(), 'text/plain');

  // 5. Finding (dedupe by fingerprint; preserve every observation as provenance)
  const existing = await tx.selectFrom('findings').select(['id']).where('investigation_id', '=', ctx.investigationId).where('fingerprint', '=', fingerprint).executeTakeFirst();
  let findingId: string;
  let created = false;
  if (existing) {
    findingId = existing.id;
    await tx
      .updateTable('findings')
      .set({
        updated_at: now,
        ...(r.publishedAt ? { published_at: r.publishedAt, published_precision: r.publishedPrecision ?? null } : {}),
      })
      .where('id', '=', findingId)
      .execute();
  } else {
    findingId = randomUUID();
    created = true;
    await tx
      .insertInto('findings')
      .values({
        id: findingId,
        investigation_id: ctx.investigationId,
        entity_id: subjectEntityId,
        fingerprint,
        title: r.title.slice(0, 500),
        description: r.description?.slice(0, 4000) ?? null,
        category: r.category,
        claim_type: r.claimType,
        confidence: 'unverified',
        confidence_score: 0,
        confidence_rationale: toJson([]),
        verification_status: 'unreviewed',
        source_count: 1,
        provider_count: 1,
        primary_source_url: r.sourceUrl,
        primary_provider_id: r.providerId,
        collected_at: r.collectedAt,
        published_at: r.publishedAt ?? null,
        published_precision: r.publishedPrecision ?? null,
        geo_lat: r.geo?.lat ?? null,
        geo_lon: r.geo?.lon ?? null,
        geo_precision: r.geo?.precision ?? null,
        geo_place: r.geo ? (r.geo.place ?? null) : null,
        geo_country: r.geo?.countryCode ?? null,
        geo_basis: r.geo?.basis?.slice(0, 1000) ?? null,
        bookmarked: 0,
        is_simulated: simulated ? 1 : 0,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  await tx.insertInto('finding_observations').values({ finding_id: findingId, observation_id: observationId }).onConflict((oc) => oc.doNothing()).execute();
  for (const evId of evidenceIds) {
    await tx.insertInto('finding_evidence').values({ finding_id: findingId, evidence_id: evId }).onConflict((oc) => oc.doNothing()).execute();
  }
  const conf = await recomputeFindingConfidence(tx, findingId);

  // 6. Relationships
  for (const rel of r.relationships ?? []) {
    const from = refToId.get(rel.from);
    const to = refToId.get(rel.to);
    if (!from || !to || from === to) continue;
    const relConfidence: ConfidenceLevel = rel.status === 'possible' ? (LEVEL_ORDER.indexOf(conf.level) > LEVEL_ORDER.indexOf('low') ? 'low' : conf.level) : conf.level === 'verified' ? 'high' : conf.level;
    const prior = await tx
      .selectFrom('relationships')
      .select(['id', 'status', 'confidence'])
      .where('investigation_id', '=', ctx.investigationId)
      .where('from_entity_id', '=', from)
      .where('to_entity_id', '=', to)
      .where('type', '=', rel.type)
      .executeTakeFirst();
    let relId: string;
    if (prior) {
      relId = prior.id;
      const upgrade = prior.status === 'possible' && rel.status === 'confirmed';
      const better = LEVEL_ORDER.indexOf(relConfidence) > LEVEL_ORDER.indexOf(prior.confidence as ConfidenceLevel);
      await tx
        .updateTable('relationships')
        .set({
          last_seen_at: now,
          ...(upgrade ? { status: 'confirmed', rationale: rel.rationale.slice(0, 1000) } : {}),
          ...(better && prior.status !== 'rejected' ? { confidence: relConfidence } : {}),
        })
        .where('id', '=', relId)
        .execute();
    } else {
      relId = randomUUID();
      await tx
        .insertInto('relationships')
        .values({
          id: relId,
          investigation_id: ctx.investigationId,
          from_entity_id: from,
          to_entity_id: to,
          type: rel.type,
          status: rel.status,
          confidence: relConfidence,
          rationale: rel.rationale.slice(0, 1000),
          is_simulated: simulated ? 1 : 0,
          first_seen_at: now,
          last_seen_at: now,
        })
        .onConflict((oc) => oc.columns(['investigation_id', 'from_entity_id', 'to_entity_id', 'type']).doNothing())
        .execute();
    }
    for (const evId of evidenceIds.slice(0, 1)) {
      await tx.insertInto('relationship_evidence').values({ relationship_id: relId, evidence_id: evId }).onConflict((oc) => oc.doNothing()).execute();
    }
  }

  // 7. Timeline (only dates stated by sources/metadata — collection time is never presented as an event date)
  const events = [...(r.events ?? [])];
  for (const ev of events) {
    const entityId = ev.entityRef ? refToId.get(ev.entityRef) ?? subjectEntityId : subjectEntityId;
    const fp = sha256Hex(`${ev.kind}|${ev.date}|${ev.label}|${entityId}`);
    await tx
      .insertInto('timeline_events')
      .values({
        id: randomUUID(),
        investigation_id: ctx.investigationId,
        entity_id: entityId,
        finding_id: findingId,
        event_date: ev.date,
        date_precision: ev.precision,
        date_kind: ev.kind,
        label: ev.label.slice(0, 300),
        description: ev.description?.slice(0, 1000) ?? null,
        source_url: r.sourceUrl,
        provider_id: r.providerId,
        is_simulated: simulated ? 1 : 0,
        fingerprint: fp,
        created_at: now,
      })
      .onConflict((oc) => oc.columns(['investigation_id', 'fingerprint']).doNothing())
      .execute();
  }
  return { findingId, created };
}

export async function persistRecords(k: Kysely<Database>, ctx: PersistContext, records: NormalizedRecord[]): Promise<{ created: number; merged: number }> {
  let created = 0;
  let merged = 0;
  await k.transaction().execute(async (tx) => {
    for (const r of records) {
      const res = await persistRecord(tx, ctx, r);
      if (res.created) created++;
      else merged++;
    }
  });
  return { created, merged };
}
