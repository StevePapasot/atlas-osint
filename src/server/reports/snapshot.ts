import 'server-only';
import { db } from '../db/client';
import { bool, fromJson } from '../db/json';
import { getProvider } from '../providers/registry';
import { detectContradictions, type Contradiction } from '../engine/correlation';
import { redactSensitiveText } from '../security/redact';
import { CATEGORY_LABELS, CLAIM_TYPE_LABELS, CONFIDENCE_LABELS, type ConfidenceLevel, type EvidenceCategory } from '@/shared/domain';

/**
 * A report snapshot is a frozen, self-contained JSON document built only from stored evidence.
 * All export formats are rendered from the snapshot, so a report can be regenerated identically later.
 */
export const REPORT_SCHEMA_VERSION = 1;

export interface ReportOptions {
  title?: string;
  redact: boolean;
  includeRawEvidence: boolean;
  includeAi: boolean;
  aiSummary?: AiSummaryBlock | null;
}

export interface AiSummaryBlock {
  provider: string;
  model: string;
  generatedAt: string;
  summary: Array<{ text: string; findingRefs: string[] }>;
  hypotheses: Array<{ text: string; findingRefs: string[] }>;
  followUps: string[];
  rejectedStatements: number;
}

export interface ReportFinding {
  ref: string;
  id: string;
  title: string;
  description: string | null;
  category: string;
  claimType: string;
  confidence: ConfidenceLevel;
  confidenceRationale: string[];
  verification: string;
  entity: { type: string; display: string } | null;
  providers: string[];
  sourceUrls: string[];
  collectedAt: string;
  publishedAt: string | null;
  publishedPrecision: string | null;
  geo: { lat: number | null; lon: number | null; precision: string; place: string | null; country: string | null; basis: string | null } | null;
  evidenceIds: string[];
  evidenceHashes: string[];
  isSimulated: boolean;
  tags: string[];
}

export interface ReportSnapshot {
  schemaVersion: number;
  title: string;
  generatedAt: string;
  generatedBy: string;
  options: Omit<ReportOptions, 'aiSummary'>;
  containsSimulatedData: boolean;
  investigation: { id: string; name: string; description: string | null; scope: string | null; depth: string; mode: string; status: string; createdAt: string; startedAt: string | null; completedAt: string | null; modules: string[] };
  targets: Array<{ type: string; value: string; label: string | null }>;
  methodology: {
    depth: string;
    mode: string;
    modules: string[];
    providers: Array<{ id: string; name: string; kind: string; succeeded: number; failed: number; skipped: number; cancelled: number; results: number; errors: string[]; limitations: string[] }>;
    jobs: Array<{ id: string; kind: string; status: string; startedAt: string | null; finishedAt: string | null; totalTasks: number; failedTasks: number }>;
    confidenceMethod: string;
  };
  stats: { findings: number; byConfidence: Record<string, number>; byClaimType: Record<string, number>; byCategory: Record<string, number>; verified: number; disputed: number; falsePositives: number; entities: number; relationships: number; evidence: number };
  executiveSummary: string[];
  keyFindings: ReportFinding[];
  sections: {
    onlinePresence: ReportFinding[];
    infrastructure: ReportFinding[];
    geographic: ReportFinding[];
    imageIntelligence: ReportFinding[];
    documents: ReportFinding[];
    other: ReportFinding[];
  };
  relationships: Array<{ from: string; fromType: string; type: string; to: string; toType: string; status: string; confidence: string; rationale: string | null }>;
  timeline: Array<{ date: string | null; precision: string; kind: string; label: string; entity: string | null; source: string | null; confidence: string | null; findingRef: string | null }>;
  contradictions: Array<Contradiction & { providerNames: string[][] }>;
  verification: Array<{ findingRef: string; from: string; to: string; rationale: string | null; reviewer: string; at: string }>;
  unverifiedLeads: ReportFinding[];
  entityMatches: Array<{ a: string; b: string; strength: string; status: string; signals: string[] }>;
  limitations: string[];
  sources: Array<{ ref: string; provider: string; sourceName: string; url: string | null; collectedAt: string; publishedAt: string | null; findingRefs: string[] }>;
  aiSummary: AiSummaryBlock | null;
}

const CONF_ORDER: ConfidenceLevel[] = ['verified', 'high', 'moderate', 'low', 'unverified'];

export async function buildReportSnapshot(investigationId: string, user: { name: string }, options: ReportOptions): Promise<ReportSnapshot> {
  const k = db();
  const inv = await k.selectFrom('investigations').selectAll().where('id', '=', investigationId).executeTakeFirstOrThrow();
  const R = (s: string | null | undefined): string | null => (s == null ? null : options.redact ? redactSensitiveText(s) : s);
  const [targets, findings, obsLinks, evLinks, tagLinks, tasks, jobs, relationships, timeline, reviews, candidates, entityCount, evidenceCount] = await Promise.all([
    k.selectFrom('targets').select(['type', 'raw_value', 'label']).where('investigation_id', '=', investigationId).orderBy('created_at').execute(),
    k.selectFrom('findings').leftJoin('entities', 'entities.id', 'findings.entity_id').selectAll('findings').select(['entities.type as entity_type', 'entities.display_value as entity_display']).where('findings.investigation_id', '=', investigationId).execute(),
    k.selectFrom('finding_observations as fo').innerJoin('observations as o', 'o.id', 'fo.observation_id').innerJoin('sources as s', 's.id', 'o.source_id').select(['fo.finding_id', 'o.id as observation_id', 'o.provider_id', 'o.source_url', 'o.collected_at', 'o.published_at', 's.name as source_name', 'o.limitations']).where('o.investigation_id', '=', investigationId).execute(),
    k.selectFrom('finding_evidence as fe').innerJoin('evidence as e', 'e.id', 'fe.evidence_id').select(['fe.finding_id', 'e.id', 'e.sha256']).where('e.investigation_id', '=', investigationId).execute(),
    k.selectFrom('finding_tags').innerJoin('tags', 'tags.id', 'finding_tags.tag_id').select(['finding_tags.finding_id', 'tags.name']).where('tags.investigation_id', '=', investigationId).execute(),
    k.selectFrom('job_tasks').select(['provider_id', 'status', 'result_count', 'error_category', 'error_message']).where('investigation_id', '=', investigationId).execute(),
    k.selectFrom('investigation_jobs').selectAll().where('investigation_id', '=', investigationId).orderBy('created_at').execute(),
    k.selectFrom('relationships as r').innerJoin('entities as f', 'f.id', 'r.from_entity_id').innerJoin('entities as t', 't.id', 'r.to_entity_id').select(['r.type', 'r.status', 'r.confidence', 'r.rationale', 'f.display_value as from_display', 'f.type as from_type', 't.display_value as to_display', 't.type as to_type']).where('r.investigation_id', '=', investigationId).where('r.status', '!=', 'rejected').execute(),
    k.selectFrom('timeline_events as t').leftJoin('entities as e', 'e.id', 't.entity_id').leftJoin('findings as f', 'f.id', 't.finding_id').select(['t.event_date', 't.date_precision', 't.date_kind', 't.label', 't.source_url', 't.finding_id', 'e.display_value as entity_display', 'f.confidence', 'f.verification_status']).where('t.investigation_id', '=', investigationId).orderBy('t.event_date').execute(),
    k.selectFrom('finding_reviews as r').innerJoin('users as u', 'u.id', 'r.user_id').select(['r.finding_id', 'r.from_status', 'r.to_status', 'r.rationale', 'r.created_at', 'u.name']).where('r.investigation_id', '=', investigationId).orderBy('r.created_at').execute(),
    k.selectFrom('entity_match_candidates as c').innerJoin('entities as a', 'a.id', 'c.entity_a_id').innerJoin('entities as b', 'b.id', 'c.entity_b_id').select(['a.display_value as a', 'b.display_value as b', 'c.strength', 'c.status', 'c.signals']).where('c.investigation_id', '=', investigationId).execute(),
    k.selectFrom('entities').select((eb) => eb.fn.countAll<number>().as('n')).where('investigation_id', '=', investigationId).executeTakeFirst(),
    k.selectFrom('evidence').select((eb) => eb.fn.countAll<number>().as('n')).where('investigation_id', '=', investigationId).executeTakeFirst(),
  ]);

  // Stable ordering → stable references (F-001 …) for reproducibility.
  const sorted = [...findings].sort(
    (a, b) => CONF_ORDER.indexOf(a.confidence as ConfidenceLevel) - CONF_ORDER.indexOf(b.confidence as ConfidenceLevel) || a.collected_at.localeCompare(b.collected_at) || a.id.localeCompare(b.id),
  );
  const refOf = new Map(sorted.map((f, i) => [f.id, `F-${String(i + 1).padStart(3, '0')}`]));
  const toReport = (f: (typeof findings)[number]): ReportFinding => {
    const obs = obsLinks.filter((o) => o.finding_id === f.id);
    return {
      ref: refOf.get(f.id)!,
      id: f.id,
      title: R(f.title)!,
      description: R(f.description),
      category: f.category,
      claimType: f.claim_type,
      confidence: f.confidence as ConfidenceLevel,
      confidenceRationale: fromJson<string[]>(f.confidence_rationale, []),
      verification: f.verification_status,
      entity: f.entity_id ? { type: f.entity_type ?? 'unknown', display: R(f.entity_display ?? '') ?? '' } : null,
      providers: [...new Set(obs.map((o) => getProvider(o.provider_id)?.name ?? o.provider_id))],
      sourceUrls: [...new Set(obs.map((o) => o.source_url).filter((u): u is string => Boolean(u)))].map((u) => R(u)!),
      collectedAt: f.collected_at,
      publishedAt: f.published_at,
      publishedPrecision: f.published_precision,
      geo: f.geo_precision ? { lat: f.geo_lat, lon: f.geo_lon, precision: f.geo_precision, place: f.geo_place, country: f.geo_country, basis: f.geo_basis } : null,
      evidenceIds: evLinks.filter((e) => e.finding_id === f.id).map((e) => e.id),
      evidenceHashes: evLinks.filter((e) => e.finding_id === f.id).map((e) => e.sha256),
      isSimulated: bool(f.is_simulated),
      tags: tagLinks.filter((t) => t.finding_id === f.id).map((t) => t.name),
    };
  };
  const active = sorted.filter((f) => f.verification_status !== 'false_positive').map(toReport);
  const byCat = (cats: EvidenceCategory[]) => active.filter((f) => cats.includes(f.category as EvidenceCategory));

  // Methodology: what was actually queried, what failed, what was unavailable.
  const providerIds = [...new Set(tasks.map((t) => t.provider_id))].sort();
  const providers = providerIds.map((id) => {
    const ts = tasks.filter((t) => t.provider_id === id);
    const p = getProvider(id);
    return {
      id,
      name: p?.name ?? id,
      kind: p?.kind ?? 'local',
      succeeded: ts.filter((t) => t.status === 'succeeded').length,
      failed: ts.filter((t) => t.status === 'failed').length,
      skipped: ts.filter((t) => t.status === 'skipped').length,
      cancelled: ts.filter((t) => t.status === 'cancelled').length,
      results: ts.reduce((s, t) => s + (t.result_count ?? 0), 0),
      errors: [...new Set(ts.filter((t) => t.error_message && t.status !== 'succeeded').map((t) => `${t.error_category}: ${t.error_message}`))].slice(0, 5),
      limitations: p?.limitations ?? [],
    };
  });

  const count = <T extends string>(arr: T[]) => arr.reduce<Record<string, number>>((m, v) => ((m[v] = (m[v] ?? 0) + 1), m), {});
  const stats = {
    findings: active.length,
    byConfidence: count(active.map((f) => f.confidence)),
    byClaimType: count(active.map((f) => f.claimType)),
    byCategory: count(active.map((f) => f.category)),
    verified: findings.filter((f) => f.verification_status === 'verified').length,
    disputed: findings.filter((f) => f.verification_status === 'disputed').length,
    falsePositives: findings.filter((f) => f.verification_status === 'false_positive').length,
    entities: Number(entityCount?.n ?? 0),
    relationships: relationships.length,
    evidence: Number(evidenceCount?.n ?? 0),
  };

  const keyFindings = active.filter((f) => ['verified', 'high', 'moderate'].includes(f.confidence) && f.claimType !== 'UNVERIFIED_LEAD').slice(0, 15);
  const containsSimulatedData = inv.mode === 'demo' || active.some((f) => f.isSimulated);
  const succeeded = providers.filter((p) => p.succeeded > 0);
  const failedTasks = tasks.filter((t) => t.status === 'failed').length;
  const unavailable = providers.filter((p) => p.skipped > 0 && p.succeeded === 0 && p.failed === 0);
  const execSummary = [
    ...(containsSimulatedData ? ['THIS REPORT CONTAINS SIMULATED DEMO DATA. It must not be treated as intelligence about real people or organisations.'] : []),
    `This investigation examined ${targets.length} target identifier(s) at ${inv.depth} depth. ATLAS recorded ${stats.findings} finding(s) from ${succeeded.length} provider(s) that returned data, linked to ${stats.entities} entities and ${stats.relationships} relationships, supported by ${stats.evidence} stored evidence items.`,
    `Confidence distribution: ${CONF_ORDER.map((c) => `${stats.byConfidence[c] ?? 0} ${CONFIDENCE_LABELS[c].toLowerCase()}`).join(', ')}. ${stats.verified} finding(s) were verified by an analyst; ${stats.disputed} disputed; ${stats.falsePositives} marked false positive and excluded.`,
    keyFindings.length
      ? `Most supported findings: ${keyFindings.slice(0, 3).map((f) => `${f.title} [${f.ref}]`).join('; ')}.`
      : 'No findings reached moderate confidence or higher; results consist of leads that require verification.',
    `${failedTasks} provider task(s) failed and ${unavailable.length} provider(s) were unavailable (not configured or disabled). Coverage is limited to the sources listed in Methodology; absence of a finding is not evidence of absence.`,
  ];

  const limitations = [
    'ATLAS only queries the sources listed under Methodology. Search coverage depends on provider indexing, quotas and access permissions; it is not comprehensive internet coverage.',
    'Collection timestamps record when ATLAS observed data; source publication dates are shown only when the source states them.',
    'IP-derived locations are approximate network estimates, never the physical location of a person or device.',
    'Username matches across platforms do not establish common identity; analyst-accepted matches are labelled as such.',
    'Embedded file metadata (EXIF, document properties) can be edited or forged and is reported as a source claim.',
    'Confidence levels are ordinal rule-based assessments, not probabilities.',
    ...providers.filter((p) => p.failed > 0).map((p) => `${p.name}: ${p.failed} task(s) failed (${p.errors[0] ?? 'see task log'}).`),
    ...unavailable.map((p) => `${p.name} was not queried: ${p.errors[0] ?? 'not configured'}.`),
    ...[...new Set(obsLinks.flatMap((o) => fromJson<string[]>(o.limitations, [])))].slice(0, 15),
  ];

  const sourceMap = new Map<string, ReportSnapshot['sources'][number]>();
  for (const o of obsLinks) {
    const key = `${o.provider_id}|${o.source_url ?? o.source_name}`;
    const ref = refOf.get(o.finding_id);
    const existing = sourceMap.get(key);
    if (existing) {
      if (ref && !existing.findingRefs.includes(ref)) existing.findingRefs.push(ref);
      continue;
    }
    sourceMap.set(key, { ref: '', provider: getProvider(o.provider_id)?.name ?? o.provider_id, sourceName: o.source_name, url: R(o.source_url), collectedAt: o.collected_at, publishedAt: o.published_at, findingRefs: ref ? [ref] : [] });
  }
  const sources = [...sourceMap.values()].sort((a, b) => a.provider.localeCompare(b.provider) || (a.url ?? '').localeCompare(b.url ?? '')).map((s, i) => ({ ...s, ref: `S-${String(i + 1).padStart(3, '0')}`, findingRefs: s.findingRefs.sort() }));

  const contradictions = await detectContradictions(k, investigationId);
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    title: options.title?.trim() || `${inv.name} — Intelligence Report`,
    generatedAt: new Date().toISOString(),
    generatedBy: user.name,
    options: { title: options.title, redact: options.redact, includeRawEvidence: options.includeRawEvidence, includeAi: options.includeAi },
    containsSimulatedData,
    investigation: { id: inv.id, name: inv.name, description: R(inv.description), scope: R(inv.scope_statement), depth: inv.depth, mode: inv.mode, status: inv.status, createdAt: inv.created_at, startedAt: inv.started_at, completedAt: inv.completed_at, modules: fromJson<string[]>(inv.modules, []) },
    targets: targets.map((t) => ({ type: t.type, value: R(t.raw_value)!, label: t.label })),
    methodology: {
      depth: inv.depth,
      mode: inv.mode,
      modules: fromJson<string[]>(inv.modules, []),
      providers,
      jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, startedAt: j.started_at, finishedAt: j.finished_at, totalTasks: j.total_tasks, failedTasks: j.failed_tasks })),
      confidenceMethod:
        'Ordinal rule points: best source reliability (authoritative 3, reputable 2, unknown 1, low 0) + identifier match (exact/normalized +1, partial 0, fuzzy -1, none -2) + corroboration (+1 per additional provider, max +2) + claim type (fact +1, inference -1). ≥5 high, 3–4 moderate, 1–2 low, ≤0 unverified. Single-source unverified leads are capped at low; analyst verification overrides. Not a probability.',
    },
    stats,
    executiveSummary: execSummary,
    keyFindings,
    sections: {
      onlinePresence: byCat(['profile', 'web_mention']),
      infrastructure: byCat(['dns', 'registration', 'certificate', 'network', 'reputation', 'correlation']),
      geographic: active.filter((f) => f.geo),
      imageIntelligence: byCat(['image', 'metadata']),
      documents: byCat(['document']),
      other: byCat(['breach', 'darkweb', 'phone', 'crypto', 'geolocation']),
    },
    relationships: relationships.map((r) => ({ from: R(r.from_display)!, fromType: r.from_type, type: r.type, to: R(r.to_display)!, toType: r.to_type, status: r.status, confidence: r.confidence, rationale: r.rationale })),
    timeline: timeline
      .filter((t) => t.verification_status !== 'false_positive')
      .map((t) => ({ date: t.event_date, precision: t.date_precision, kind: t.date_kind, label: R(t.label)!, entity: R(t.entity_display), source: R(t.source_url), confidence: t.confidence, findingRef: t.finding_id ? refOf.get(t.finding_id) ?? null : null })),
    contradictions: contradictions.map((c) => ({ ...c, entityValue: R(c.entityValue)!, values: c.values.map((v) => ({ ...v, value: R(v.value)! })), providerNames: c.values.map((v) => v.providers.map((p) => getProvider(p)?.name ?? p)) })),
    verification: reviews.map((r) => ({ findingRef: refOf.get(r.finding_id) ?? r.finding_id, from: r.from_status, to: r.to_status, rationale: R(r.rationale), reviewer: r.name, at: r.created_at })),
    unverifiedLeads: active.filter((f) => f.claimType === 'UNVERIFIED_LEAD' && f.verification !== 'verified'),
    entityMatches: candidates.map((c) => ({ a: R(c.a)!, b: R(c.b)!, strength: c.strength, status: c.status, signals: fromJson<Array<{ detail: string }>>(c.signals, []).map((s) => s.detail) })),
    limitations,
    sources,
    aiSummary: options.includeAi ? options.aiSummary ?? null : null,
  };
}

export const CATEGORY_TITLES = CATEGORY_LABELS;
export const CLAIM_TITLES = CLAIM_TYPE_LABELS;
