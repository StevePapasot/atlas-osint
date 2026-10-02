import 'server-only';
import { db } from '../db/client';
import { fromJson } from '../db/json';
import { env } from '../config/env';
import { ALL_PROVIDERS, isProviderUsable, providerConfigStatus } from '../providers/registry';
import { jobSummary } from './investigations';

export async function dashboardData(userId: string) {
  const k = db();
  const invs = await k.selectFrom('investigations').selectAll().where('owner_id', '=', userId).orderBy('updated_at', 'desc').execute();
  const ids = invs.map((i) => i.id);
  const none = ['00000000-0000-0000-0000-000000000000'];
  const countIn = async (table: 'findings' | 'entities' | 'evidence' | 'relationships') =>
    Number((await k.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).where('investigation_id', 'in', ids.length ? ids : none).executeTakeFirst())?.n ?? 0);
  const [findings, entities, evidence, relationships] = await Promise.all([countIn('findings'), countIn('entities'), countIn('evidence'), countIn('relationships')]);
  const perInv = ids.length
    ? await k.selectFrom('findings').select(['investigation_id', (eb) => eb.fn.countAll<number>().as('n')]).where('investigation_id', 'in', ids).groupBy('investigation_id').execute()
    : [];
  const byConfidence = ids.length
    ? await k.selectFrom('findings').select(['confidence', (eb) => eb.fn.countAll<number>().as('n')]).where('investigation_id', 'in', ids).where('verification_status', '!=', 'false_positive').groupBy('confidence').execute()
    : [];
  const byCategory = ids.length
    ? await k.selectFrom('findings').select(['category', (eb) => eb.fn.countAll<number>().as('n')]).where('investigation_id', 'in', ids).groupBy('category').execute()
    : [];
  const activeJobs = ids.length
    ? await k.selectFrom('investigation_jobs').selectAll().where('investigation_id', 'in', ids).where('status', 'in', ['queued', 'running']).orderBy('created_at', 'desc').execute()
    : [];
  const recentActivity = await k
    .selectFrom('audit_events as a')
    .leftJoin('investigations as i', 'i.id', 'a.investigation_id')
    .select(['a.id', 'a.action', 'a.created_at', 'a.metadata', 'a.investigation_id', 'i.name as investigation_name'])
    .where('a.user_id', '=', userId)
    .orderBy('a.created_at', 'desc')
    .limit(15)
    .execute();
  const health = await k.selectFrom('provider_health').selectAll().execute();
  const e = env();
  const providers = ALL_PROVIDERS.filter((p) => p.kind !== 'simulated' && p.category !== 'analysis').map((p) => {
    const h = health.find((x) => x.provider_id === p.id);
    const st = providerConfigStatus(p, e);
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      category: p.category,
      usable: isProviderUsable(p, e),
      configured: st.configured && st.envEnabled,
      health: h ? { status: h.status, message: h.message, checkedAt: h.checked_at, latencyMs: h.latency_ms } : null,
    };
  });
  const statusCounts = invs.reduce<Record<string, number>>((m, i) => ((m[i.status] = (m[i.status] ?? 0) + 1), m), {});
  const countMap = Object.fromEntries(perInv.map((r) => [r.investigation_id, Number(r.n)]));
  return {
    totals: { investigations: invs.length, findings, entities, evidence, relationships, active: activeJobs.filter((j) => j.kind === 'investigation').length },
    statusCounts,
    byConfidence: Object.fromEntries(byConfidence.map((r) => [r.confidence, Number(r.n)])),
    byCategory: Object.fromEntries(byCategory.map((r) => [r.category, Number(r.n)])),
    recent: invs.slice(0, 8).map((i) => ({ id: i.id, name: i.name, status: i.status, depth: i.depth, mode: i.mode, updatedAt: i.updated_at, findings: countMap[i.id] ?? 0 })),
    activeJobs: activeJobs.map((j) => ({ ...jobSummary(j), investigationId: j.investigation_id, investigationName: invs.find((i) => i.id === j.investigation_id)?.name ?? '' })),
    recentActivity: recentActivity.map((a) => ({ ...a, metadata: fromJson<Record<string, unknown>>(a.metadata, {}) })),
    providers,
  };
}
