/**
 * Investigation planner: decides which provider operations run for which subjects, given depth, modules,
 * mode (live/demo), provider configuration and the analyst's provider preferences.
 * Unavailable providers are recorded as skipped tasks so coverage gaps are visible, never silent.
 */
import type { AppEnv } from '../config/env';
import type { Provider, ProviderOperation } from '../providers/types';
import { ALL_PROVIDERS, isProviderUsable, providerAllowedInMode, providerConfigStatus } from '../providers/registry';
import { planQueries } from './query-planner';
import { DEPTH_MODULES, type Depth, type ModuleId, type TargetType } from '@/shared/domain';

const DEPTH_RANK: Record<Exclude<Depth, 'custom'>, number> = { quick: 0, standard: 1, deep: 2 };

export interface PlanSubject {
  type: TargetType;
  value: string;
  display: string;
  metadata: Record<string, unknown>;
  targetId: string | null;
  entityId: string | null;
  derived?: string;
}

export interface PlannedTask {
  providerId: string;
  operation: string;
  subject: PlanSubject;
  params: Record<string, unknown>;
  stage: 'collection' | 'pivot' | 'artifact' | 'analysis';
  status: 'queued' | 'skipped';
  errorCategory?: string;
  errorMessage?: string;
}

export interface PlanInput {
  depth: Depth;
  mode: 'live' | 'demo';
  modules: ModuleId[];
  /** Explicit provider allow-list (custom depth). Empty = all eligible providers. */
  providerAllowList: string[];
  /** Providers the analyst disabled in settings. */
  userDisabled: Set<string>;
  env: AppEnv;
  related: Array<{ type: TargetType; value: string; display: string }>;
  scope: string | null;
  providers?: Provider[];
}

export function effectiveModules(depth: Depth, modules: ModuleId[]): ModuleId[] {
  if (depth === 'custom') return modules;
  return DEPTH_MODULES[depth];
}

function effectiveDepth(depth: Depth): Exclude<Depth, 'custom'> {
  return depth === 'custom' ? 'standard' : depth;
}

function opEligible(op: ProviderOperation, subject: PlanSubject, input: PlanInput, modules: Set<ModuleId>): boolean {
  if (!op.targetTypes.includes(subject.type)) return false;
  if (!modules.has(op.module)) return false;
  if (input.depth === 'custom') return true;
  return DEPTH_RANK[effectiveDepth(input.depth)] >= DEPTH_RANK[op.minDepth];
}

/** Derived subjects: e.g. the host of a URL target is enriched as a domain. */
export function deriveSubjects(target: PlanSubject, depth: Depth): PlanSubject[] {
  const out: PlanSubject[] = [target];
  const d = effectiveDepth(depth);
  if ((target.type === 'url' || target.type === 'document' || target.type === 'image') && typeof target.metadata.host === 'string') {
    const host = target.metadata.host;
    if (!/^[\d.:]+$/.test(host)) out.push({ type: 'domain', value: host, display: host, metadata: {}, targetId: target.targetId, entityId: null, derived: `host of ${target.display}` });
  }
  if (target.type === 'email' && DEPTH_RANK[d] >= DEPTH_RANK.deep && typeof target.metadata.domain === 'string') {
    const domain = target.metadata.domain;
    out.push({ type: 'domain', value: domain, display: domain, metadata: {}, targetId: target.targetId, entityId: null, derived: `domain of ${target.display}` });
  }
  return out;
}

export function planCollection(targets: PlanSubject[], input: PlanInput): PlannedTask[] {
  const modules = new Set(effectiveModules(input.depth, input.modules));
  const providers = (input.providers ?? ALL_PROVIDERS).filter((p) => providerAllowedInMode(p, input.mode) && p.category !== 'image' && p.category !== 'documents');
  const tasks: PlannedTask[] = [];
  const skippedKeys = new Set<string>();
  const seen = new Set<string>();

  for (const target of targets) {
    for (const subject of deriveSubjects(target, input.depth)) {
      for (const p of providers) {
        if (input.providerAllowList.length && !input.providerAllowList.includes(p.id)) continue;
        const ops = p.operations.filter((op) => opEligible(op, subject, input, modules));
        if (!ops.length) continue;
        const usable = isProviderUsable(p, input.env);
        const disabledByUser = input.userDisabled.has(p.id);
        if (!usable || disabledByUser) {
          const key = `${p.id}|${subject.type}|${subject.value}`;
          if (skippedKeys.has(key)) continue;
          skippedKeys.add(key);
          const st = providerConfigStatus(p, input.env);
          tasks.push({
            providerId: p.id,
            operation: ops[0]!.id,
            subject,
            params: {},
            stage: 'collection',
            status: 'skipped',
            errorCategory: disabledByUser || st.disabledByAdmin ? 'disabled' : 'not_configured',
            errorMessage: disabledByUser
              ? 'Disabled in your provider settings.'
              : st.disabledByAdmin
                ? 'Disabled by the administrator (ATLAS_DISABLED_PROVIDERS).'
                : st.missing.length
                  ? `Not configured: set ${st.missing.join(', ')}.`
                  : 'Not enabled in server configuration.',
          });
          continue;
        }
        for (const op of ops) {
          if (op.id === 'web_search') {
            const queries = planQueries(subject.type, subject.value, subject.display, {
              depth: effectiveDepth(input.depth),
              related: input.related.filter((r) => r.value !== subject.value),
              scope: input.scope,
            });
            for (const q of queries) {
              const key = `${p.id}|${op.id}|${q.query}`;
              if (seen.has(key)) continue;
              seen.add(key);
              tasks.push({ providerId: p.id, operation: op.id, subject, params: { query: q.query, purpose: q.purpose, rationale: q.rationale }, stage: 'collection', status: 'queued' });
            }
          } else {
            const key = `${p.id}|${op.id}|${subject.type}|${subject.value}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tasks.push({ providerId: p.id, operation: op.id, subject, params: {}, stage: 'collection', status: 'queued' });
          }
        }
      }
    }
  }
  return tasks;
}

export const PIVOT_OPERATIONS = new Set(['dns_records', 'domain_profile', 'asn_lookup', 'ptr', 'ip_profile', 'ipinfo', 'internetdb']);

/** Deep-mode infrastructure pivots on entities discovered during collection. */
export function planPivots(
  entities: Array<{ id: string; type: string; value: string; display: string }>,
  input: PlanInput,
  limits = { domain: 8, ip: 8 },
): PlannedTask[] {
  const modules = new Set(effectiveModules(input.depth, input.modules));
  if (!modules.has('infrastructure')) return [];
  const providers = (input.providers ?? ALL_PROVIDERS).filter(
    (p) => providerAllowedInMode(p, input.mode) && isProviderUsable(p, input.env) && !input.userDisabled.has(p.id) && (!input.providerAllowList.length || input.providerAllowList.includes(p.id)),
  );
  const tasks: PlannedTask[] = [];
  const pick = (type: 'domain' | 'ip') => entities.filter((e) => e.type === type).slice(0, limits[type]);
  for (const e of [...pick('domain'), ...pick('ip')]) {
    const subject: PlanSubject = { type: e.type as TargetType, value: e.value, display: e.display, metadata: { pivot: true }, targetId: null, entityId: e.id, derived: 'pivot' };
    for (const p of providers) {
      for (const op of p.operations) {
        if (!op.targetTypes.includes(subject.type)) continue;
        // Pivots use only lightweight infrastructure operations (resolution, routing) — no searches, CT or archives,
        // which keeps a single hop bounded and avoids recursive expansion.
        if (!PIVOT_OPERATIONS.has(op.id)) continue;
        tasks.push({ providerId: p.id, operation: op.id, subject, params: { pivotOf: e.id }, stage: 'pivot', status: 'queued' });
      }
    }
  }
  return tasks;
}
