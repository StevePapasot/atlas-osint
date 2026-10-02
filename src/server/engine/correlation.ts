/**
 * Post-collection analysis:
 *  - Entity-resolution CANDIDATES between social accounts (never auto-merged; analysts accept/reject).
 *  - Shared-infrastructure correlation (targets resolving to the same IP / announced by the same ASN).
 *  - Contradiction detection across providers' attribute assertions.
 */
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../db/schema';
import { fromJson, nowIso, toJson } from '../db/json';
import type { NormalizedRecord, Provider } from '../providers/types';
import { persistRecords } from './persist';

export const correlationProvider: Provider = {
  id: 'atlas.correlation',
  name: 'ATLAS correlation engine',
  category: 'analysis',
  kind: 'local',
  reliability: 'reputable',
  description: 'Entity-resolution candidates, shared-infrastructure correlation and contradiction detection over collected evidence.',
  operations: [],
  config: [],
  limitations: ['Correlations are inferences; shared infrastructure (CDNs, shared hosting) is common and often coincidental.'],
  async run() {
    return { records: [] };
  },
};

export interface MatchSignal {
  signal: string;
  weight: 'strong' | 'moderate' | 'weak';
  detail: string;
}

interface AccountView {
  id: string;
  value: string;
  platform: string;
  username: string | null;
  displayName: string | null;
  website: string | null;
  bio: string | null;
  location: string | null;
  emails: string[];
  isSimulated: boolean;
}

function tokens(text: string | null): Set<string> {
  return new Set((text ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 3));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Pure scoring of two accounts — exported for unit tests. */
export function compareAccounts(a: AccountView, b: AccountView): { signals: MatchSignal[]; strength: 'strong' | 'moderate' | 'weak' } | null {
  if (a.platform.toLowerCase() === b.platform.toLowerCase()) return null;
  const signals: MatchSignal[] = [];
  if (a.username && b.username && a.username.toLowerCase() === b.username.toLowerCase()) {
    signals.push({ signal: 'same_username', weight: 'weak', detail: `Both use the username "${a.username}". Usernames are frequently reused by unrelated people.` });
  }
  const ha = hostOf(a.website);
  const hb = hostOf(b.website);
  if (ha && hb && ha === hb) signals.push({ signal: 'shared_website', weight: 'strong', detail: `Both profiles link to ${ha}.` });
  const sharedEmail = a.emails.find((e) => b.emails.includes(e));
  if (sharedEmail) signals.push({ signal: 'shared_email', weight: 'strong', detail: `Both profiles list ${sharedEmail}.` });
  if (a.displayName && b.displayName && a.displayName.trim().toLowerCase() === b.displayName.trim().toLowerCase() && a.displayName.trim().length >= 4) {
    signals.push({ signal: 'same_display_name', weight: 'moderate', detail: `Same display name "${a.displayName}".` });
  }
  const sim = jaccard(tokens(a.bio), tokens(b.bio));
  if (sim >= 0.35) signals.push({ signal: 'similar_bio', weight: 'moderate', detail: `Biography token overlap ${(sim * 100).toFixed(0)}%.` });
  if (a.location && b.location && a.location.toLowerCase() === b.location.toLowerCase()) {
    signals.push({ signal: 'same_location', weight: 'weak', detail: `Same self-reported location "${a.location}".` });
  }
  if (!signals.length) return null;
  const strong = signals.filter((s) => s.weight === 'strong').length;
  const moderate = signals.filter((s) => s.weight === 'moderate').length;
  const strength = strong >= 1 ? 'strong' : moderate >= 1 ? 'moderate' : 'weak';
  return { signals, strength };
}

async function loadAccounts(k: Kysely<Database>, investigationId: string): Promise<AccountView[]> {
  const rows = await k.selectFrom('entities').select(['id', 'value', 'attributes', 'is_simulated']).where('investigation_id', '=', investigationId).where('type', '=', 'social_account').execute();
  const emailLinks = await k
    .selectFrom('relationships')
    .innerJoin('entities as e', 'e.id', 'relationships.to_entity_id')
    .select(['relationships.from_entity_id as from', 'e.value as email'])
    .where('relationships.investigation_id', '=', investigationId)
    .where('e.type', '=', 'email')
    .where('relationships.status', '!=', 'rejected')
    .execute();
  return rows.map((r) => {
    const a = fromJson<Record<string, unknown>>(r.attributes, {});
    const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
    return {
      id: r.id,
      value: r.value,
      platform: s(a.platform) ?? r.value.split(':')[0] ?? 'unknown',
      username: s(a.username) ?? r.value.split(':').slice(1).join(':'),
      displayName: s(a.displayName),
      website: s(a.website),
      bio: s(a.bio),
      location: s(a.location),
      emails: emailLinks.filter((l) => l.from === r.id).map((l) => l.email),
      isSimulated: r.is_simulated === 1,
    };
  });
}

export async function generateEntityCandidates(k: Kysely<Database>, investigationId: string): Promise<number> {
  const accounts = (await loadAccounts(k, investigationId)).slice(0, 300);
  let created = 0;
  for (let i = 0; i < accounts.length; i++) {
    for (let j = i + 1; j < accounts.length; j++) {
      const [a, b] = [accounts[i]!, accounts[j]!].sort((x, y) => x.id.localeCompare(y.id)) as [AccountView, AccountView];
      const cmp = compareAccounts(a, b);
      if (!cmp) continue;
      const existing = await k
        .selectFrom('entity_match_candidates')
        .select(['id', 'status'])
        .where('investigation_id', '=', investigationId)
        .where('entity_a_id', '=', a.id)
        .where('entity_b_id', '=', b.id)
        .executeTakeFirst();
      if (existing) {
        if (existing.status === 'pending') {
          await k.updateTable('entity_match_candidates').set({ signals: toJson(cmp.signals), strength: cmp.strength }).where('id', '=', existing.id).execute();
        }
        continue;
      }
      await k
        .insertInto('entity_match_candidates')
        .values({
          id: randomUUID(),
          investigation_id: investigationId,
          entity_a_id: a.id,
          entity_b_id: b.id,
          signals: toJson(cmp.signals),
          strength: cmp.strength,
          status: 'pending',
          decided_by: null,
          decided_at: null,
          created_at: nowIso(),
        })
        .execute();
      created++;
    }
  }
  return created;
}

/** Targets (or their derived domains) that share hosting IPs or origin ASNs. */
export async function correlateInfrastructure(k: Kysely<Database>, investigationId: string): Promise<NormalizedRecord[]> {
  const edges = await k
    .selectFrom('relationships as r')
    .innerJoin('entities as f', 'f.id', 'r.from_entity_id')
    .innerJoin('entities as t', 't.id', 'r.to_entity_id')
    .select(['f.id as fromId', 'f.value as fromValue', 'f.type as fromType', 't.id as toId', 't.value as toValue', 't.type as toType', 'r.type as relType', 'f.is_simulated as sim'])
    .where('r.investigation_id', '=', investigationId)
    .where('r.status', '=', 'confirmed')
    .where('r.type', 'in', ['RESOLVES_TO', 'HOSTED_ON'])
    .execute();
  const targets = await k.selectFrom('targets').select(['normalized_value', 'type', 'metadata']).where('investigation_id', '=', investigationId).execute();
  const targetDomains = new Set<string>();
  for (const t of targets) {
    if (t.type === 'domain') targetDomains.add(t.normalized_value);
    const md = fromJson<Record<string, unknown>>(t.metadata, {});
    if (typeof md.host === 'string') targetDomains.add(md.host);
    if (typeof md.domain === 'string') targetDomains.add(md.domain);
  }
  const byIp = new Map<string, { ipId: string; domains: Set<string>; sim: boolean }>();
  for (const e of edges) {
    if (e.relType === 'RESOLVES_TO' && e.fromType === 'domain' && e.toType === 'ip' && targetDomains.has(e.fromValue)) {
      const cur = byIp.get(e.toValue) ?? { ipId: e.toId, domains: new Set<string>(), sim: e.sim === 1 };
      cur.domains.add(e.fromValue);
      byIp.set(e.toValue, cur);
    }
  }
  const now = new Date().toISOString();
  const records: NormalizedRecord[] = [];
  for (const [ip, v] of byIp) {
    if (v.domains.size < 2) continue;
    const domains = [...v.domains].sort();
    records.push({
      providerId: correlationProvider.id,
      sourceName: 'ATLAS correlation engine',
      sourceUrl: null,
      title: `${domains.join(' and ')} share hosting address ${ip}`,
      description: 'Multiple investigated domains resolve to the same IP address. Shared hosting and CDNs make this common; treat as a lead for related ownership, not proof.',
      excerpt: domains.map((d) => `${d} → ${ip}`).join('\n'),
      entityType: 'ip',
      normalizedValue: ip,
      collectedAt: now,
      category: 'correlation',
      claimType: 'INFERENCE',
      confidenceInputs: { sourceReliability: 'reputable', matchType: 'exact', signals: ['shared_ip'] },
      entities: [{ ref: 'ip', type: 'ip', value: ip }, ...domains.map((d, i) => ({ ref: `d${i}`, type: 'domain' as const, value: d }))],
      subjectRef: 'ip',
      relationships: domains.slice(1).map((_, i) => ({ from: 'd0', to: `d${i + 1}`, type: 'ASSOCIATED_WITH' as const, status: 'possible' as const, rationale: `Both resolve to ${ip}.` })),
      metadata: { sharedIp: ip, domains },
      fingerprintKey: `corr:shared-ip:${ip}:${domains.join(',')}`,
      isSimulated: v.sim,
      limitations: correlationProvider.limitations,
    });
  }
  return records;
}

export async function runCorrelation(k: Kysely<Database>, investigationId: string, taskId: string | null): Promise<{ candidates: number; correlations: number }> {
  const records = await correlateInfrastructure(k, investigationId);
  if (records.length) await persistRecords(k, { investigationId, taskId, targetId: null, providerKind: 'local' }, records);
  const candidates = await generateEntityCandidates(k, investigationId);
  return { candidates, correlations: records.length };
}

export interface Contradiction {
  entityType: string;
  entityValue: string;
  attribute: string;
  values: Array<{ value: string; providers: string[]; observationIds: string[] }>;
}

/** Attributes where providers disagree (e.g. different countries for one IP, different registrars). */
export async function detectContradictions(k: Kysely<Database>, investigationId: string): Promise<Contradiction[]> {
  const rows = await k
    .selectFrom('observations')
    .innerJoin('finding_observations as fo', 'fo.observation_id', 'observations.id')
    .innerJoin('findings as f', 'f.id', 'fo.finding_id')
    .select(['observations.id', 'observations.provider_id', 'observations.metadata'])
    .where('observations.investigation_id', '=', investigationId)
    .where('f.verification_status', '!=', 'false_positive')
    .execute();
  const groups = new Map<string, Contradiction>();
  for (const r of rows) {
    const md = fromJson<{ assertions?: Array<{ entityType: string; entityValue: string; attribute: string; value: string }> }>(r.metadata, {});
    for (const a of md.assertions ?? []) {
      if (!a?.attribute || !a.value) continue;
      const key = `${a.entityType}|${a.entityValue}|${a.attribute}`;
      const g = groups.get(key) ?? { entityType: a.entityType, entityValue: a.entityValue, attribute: a.attribute, values: [] };
      const norm = a.value.trim();
      let v = g.values.find((x) => x.value.toLowerCase() === norm.toLowerCase());
      if (!v) {
        v = { value: norm, providers: [], observationIds: [] };
        g.values.push(v);
      }
      if (!v.providers.includes(r.provider_id)) v.providers.push(r.provider_id);
      v.observationIds.push(r.id);
      groups.set(key, g);
    }
  }
  return [...groups.values()].filter((g) => g.values.length > 1);
}
