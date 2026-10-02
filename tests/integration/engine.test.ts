import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { setupDb, makeUser } from '../helpers/db';
import { db } from '@/server/db/client';
import { createInvestigation, startInvestigation, cancelInvestigation, getInvestigationDetail, jobProgress, getOwnedInvestigation } from '@/server/repositories/investigations';
import { claimNextJob, processNextJob, recoverStaleJobs, runJob, enqueueJob } from '@/server/engine/runner';
import { listFindings, findingsQuerySchema, reviewFinding, getTimeline, buildGraph, listCandidates, decideCandidate, getFindingDetail } from '@/server/repositories/workspace';
import { detectContradictions } from '@/server/engine/correlation';
import { registerProvider } from '@/server/providers/registry';
import { ProviderError, type Provider } from '@/server/providers/types';
import { makeRecord } from '@/server/providers/util';

const demoTargets = [
  { type: 'username' as const, value: 'shadowfox_42' },
  { type: 'email' as const, value: 'j.doe@example.org' },
  { type: 'domain' as const, value: 'northwind-analytics.example' },
  { type: 'ip' as const, value: '198.51.100.23' },
];

beforeAll(async () => {
  await setupDb();
});

describe('demo investigation end to end', () => {
  let userId = '';
  let id = '';
  it('creates, runs and completes partially (the unstable demo provider always fails)', async () => {
    const { user } = await makeUser('Engine');
    userId = user.id;
    id = await createInvestigation(user.id, { name: 'Engine test', depth: 'deep', mode: 'demo', modules: [], providers: [], targets: demoTargets, start: false });
    const started = await startInvestigation(id, user.id);
    expect(started.alreadyRunning).toBe(false);
    // Idempotent start while queued.
    expect((await startInvestigation(id, user.id)).alreadyRunning).toBe(true);
    const status = await processNextJob(db());
    expect(status).toBe('partially_completed');
    const detail = await getInvestigationDetail(id, user.id);
    expect(detail.status).toBe('partially_completed');
    expect(detail.counts.findings).toBeGreaterThan(20);
    expect(detail.latestJob?.progress).toBe(1);
  });

  it('isolates the failing provider and records its error category', async () => {
    const p = await jobProgress(id, userId);
    const failed = p.tasks.filter((t) => t.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((t) => t.providerId === 'demo.unstable' && t.errorCategory === 'timeout' && t.attempts === 2)).toBe(true);
    expect(p.tasks.filter((t) => t.status === 'succeeded').length).toBeGreaterThan(20);
    expect(p.tasks.some((t) => t.stage === 'pivot')).toBe(true);
    expect(p.tasks.some((t) => t.stage === 'analysis' && t.status === 'succeeded')).toBe(true);
  });

  it('deduplicates overlapping results across providers while keeping provenance', async () => {
    const res = await listFindings(id, findingsQuerySchema.parse({ q: 'member profile', pageSize: 50 }));
    const multi = res.items.filter((f) => f.providerCount === 2);
    expect(multi.length).toBeGreaterThan(0);
    const detail = await getFindingDetail(id, multi[0]!.id);
    expect(new Set(detail.observations.map((o) => o.providerId))).toEqual(new Set(['demo.search', 'demo.search-alt']));
  });

  it('stores evidence with a SHA-256 that matches the content', async () => {
    const ev = await db().selectFrom('evidence').select(['content', 'sha256', 'is_simulated']).where('investigation_id', '=', id).limit(25).execute();
    for (const e of ev) {
      expect(createHash('sha256').update(e.content).digest('hex')).toBe(e.sha256);
      expect(e.is_simulated).toBe(1);
    }
  });

  it('separates collection time from source dates and never invents timeline dates', async () => {
    const t = await getTimeline(id);
    expect(t.length).toBeGreaterThan(5);
    expect(t.every((e) => e.date && e.precision)).toBe(true);
    const findings = await db().selectFrom('findings').select(['collected_at', 'published_at']).where('investigation_id', '=', id).execute();
    expect(findings.some((f) => f.published_at === null)).toBe(true);
    expect(findings.every((f) => f.collected_at.startsWith('20'))).toBe(true);
  });

  it('builds a relationship graph with confirmed and possible edges', async () => {
    const g = await buildGraph(id, {});
    expect(g.nodes.length).toBeGreaterThan(10);
    expect(new Set(g.edges.map((e) => e.status))).toEqual(new Set(['confirmed', 'possible']));
    expect(g.edges.some((e) => e.type === 'RESOLVES_TO')).toBe(true);
    const confirmedOnly = await buildGraph(id, { includePossible: false });
    expect(confirmedOnly.edges.every((e) => e.status === 'confirmed')).toBe(true);
  });

  it('proposes entity matches without merging, and supports accept → separate', async () => {
    const cands = await listCandidates(id, { status: 'pending' });
    expect(cands.length).toBeGreaterThan(0);
    const before = await db().selectFrom('entities').select('cluster_id').where('investigation_id', '=', id).where('cluster_id', 'is not', null).execute();
    expect(before).toHaveLength(0);
    const c = cands.find((x) => x.strength === 'strong') ?? cands[0]!;
    await decideCandidate(id, c.id, userId, { decision: 'accept', rationale: 'Same linked website on both profiles.' });
    const clustered = await db().selectFrom('entities').select('cluster_id').where('id', 'in', [c.a.id, c.b.id]).execute();
    expect(clustered[0]!.cluster_id).toBeTruthy();
    expect(clustered[0]!.cluster_id).toBe(clustered[1]!.cluster_id);
    await expect(decideCandidate(id, c.id, userId, { decision: 'accept', rationale: 'again and again' })).rejects.toThrow(/already/);
    await decideCandidate(id, c.id, userId, { decision: 'separate', rationale: 'New evidence shows different people.' });
    const rel = await db().selectFrom('relationships').select('status').where('from_entity_id', '=', c.a.id).where('to_entity_id', '=', c.b.id).where('type', '=', 'SIMILAR_TO').executeTakeFirst();
    expect(rel?.status).toBe('rejected');
  });

  it('detects contradictions between sources', async () => {
    const c = await detectContradictions(db(), id);
    expect(c.some((x) => x.attribute === 'display_name')).toBe(true);
  });

  it('verification requires a rationale, keeps an audit trail and updates confidence', async () => {
    const f = (await listFindings(id, findingsQuerySchema.parse({ pageSize: 1 }))).items[0]!;
    await expect(reviewFinding(id, f.id, userId, { status: 'verified' })).rejects.toThrow(/rationale/i);
    await reviewFinding(id, f.id, userId, { status: 'verified', rationale: 'Checked against the registry record directly.' });
    const d = await getFindingDetail(id, f.id);
    expect(d.verificationStatus).toBe('verified');
    expect(d.confidence).toBe('verified');
    expect(d.reviews).toHaveLength(1);
    await reviewFinding(id, f.id, userId, { status: 'false_positive', rationale: 'Turned out to be a different domain.' });
    const listed = await listFindings(id, findingsQuerySchema.parse({ pageSize: 200 }));
    expect(listed.items.some((x) => x.id === f.id)).toBe(false);
    const withFp = await listFindings(id, findingsQuerySchema.parse({ pageSize: 200, includeFalsePositives: 'true' }));
    expect(withFp.items.some((x) => x.id === f.id)).toBe(true);
    expect((await getFindingDetail(id, f.id)).reviews).toHaveLength(2);
  });

  it('filters findings by provider, confidence, category, claim type and location', async () => {
    const q = (p: Record<string, string>) => listFindings(id, findingsQuerySchema.parse({ pageSize: 200, ...p }));
    expect((await q({ provider: 'demo.breach' })).items.every((f) => f.providers.includes('demo.breach'))).toBe(true);
    expect((await q({ category: 'dns' })).items.every((f) => f.category === 'dns')).toBe(true);
    expect((await q({ claimType: 'FACT' })).items.every((f) => f.claimType === 'FACT')).toBe(true);
    expect((await q({ hasGeo: 'true' })).items.every((f) => f.geo)).toBe(true);
    expect((await q({ entityType: 'social_account' })).items.every((f) => f.entity?.type === 'social_account')).toBe(true);
    const sorted = (await q({ sort: 'title', order: 'asc' })).items.map((f) => f.title);
    expect(sorted).toEqual([...sorted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('re-running merges into existing findings instead of duplicating them', async () => {
    const before = (await getInvestigationDetail(id, userId)).counts.findings;
    await startInvestigation(id, userId);
    await processNextJob(db());
    const after = (await getInvestigationDetail(id, userId)).counts.findings;
    expect(after).toBe(before);
  });

  it('enforces ownership', async () => {
    const other = await makeUser('Other');
    await expect(getOwnedInvestigation(id, other.user.id)).rejects.toMatchObject({ status: 404 });
    await expect(getInvestigationDetail(id, other.user.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('job lifecycle', () => {
  it('cancels a queued job immediately', async () => {
    const { user } = await makeUser('Cancel');
    const id = await createInvestigation(user.id, { name: 'Cancel queued', depth: 'quick', mode: 'demo', modules: [], providers: [], targets: [demoTargets[2]!], start: false });
    await startInvestigation(id, user.id);
    await cancelInvestigation(id, user.id);
    expect((await getInvestigationDetail(id, user.id)).status).toBe('cancelled');
    expect(await processNextJob(db())).toBeNull();
  });

  it('cancels a running job cooperatively and keeps partial results', async () => {
    const slow: Provider = {
      id: 'test.slow',
      name: 'Slow test provider',
      category: 'demo',
      kind: 'simulated',
      reliability: 'unknown',
      description: 'test',
      operations: [{ id: 'slow', label: 'slow', targetTypes: ['keyword'], module: 'web_search', minDepth: 'quick' }],
      config: [],
      maxRetries: 0,
      async run(_input, ctx) {
        await new Promise((r, j) => {
          const t = setTimeout(r, 30_000);
          ctx.signal.addEventListener('abort', () => { clearTimeout(t); j(new ProviderError('cancelled', 'aborted')); });
        });
        return { records: [] };
      },
    };
    registerProvider(slow);
    const { user } = await makeUser('Cancel2');
    const id = await createInvestigation(user.id, { name: 'Cancel running', depth: 'custom', mode: 'demo', modules: ['web_search'], providers: ['test.slow', 'demo.search'], targets: [{ type: 'keyword', value: 'fictional keyword' }], start: false });
    await startInvestigation(id, user.id);
    const job = (await claimNextJob(db()))!;
    const running = runJob(db(), job);
    await new Promise((r) => setTimeout(r, 800));
    await cancelInvestigation(id, user.id);
    const status = await running;
    expect(status).toBe('cancelled');
    const p = await jobProgress(id, user.id);
    expect(p.tasks.find((t) => t.providerId === 'test.slow')?.status).toBe('cancelled');
    expect(p.tasks.some((t) => t.providerId === 'demo.search' && t.status === 'succeeded')).toBe(true);
  }, 30_000);

  it('recovers jobs whose worker stopped heartbeating', async () => {
    const { user } = await makeUser('Recover');
    const id = await createInvestigation(user.id, { name: 'Recover', depth: 'quick', mode: 'demo', modules: [], providers: [], targets: [demoTargets[3]!], start: false });
    const jobId = await enqueueJob(db(), id, 'investigation');
    await db().updateTable('investigation_jobs').set({ status: 'running', attempt: 1, heartbeat_at: new Date(Date.now() - 5 * 60_000).toISOString() }).where('id', '=', jobId).execute();
    expect(await recoverStaleJobs(db())).toBe(1);
    const row = await db().selectFrom('investigation_jobs').select(['status']).where('id', '=', jobId).executeTakeFirstOrThrow();
    expect(row.status).toBe('queued');
    expect(await processNextJob(db())).toMatch(/completed/);
  });

  it('fails clearly when no provider can run, and survives provider exceptions', async () => {
    const thrower: Provider = {
      id: 'test.thrower',
      name: 'Throwing provider',
      category: 'demo',
      kind: 'simulated',
      reliability: 'unknown',
      description: 'test',
      operations: [{ id: 'boom', label: 'boom', targetTypes: ['organization'], module: 'web_search', minDepth: 'quick' }],
      config: [],
      async run() {
        throw new TypeError('unexpected bug');
      },
    };
    const ok: Provider = { ...thrower, id: 'test.ok', name: 'OK provider', async run(i, c) { return { records: [makeRecord(ok, c, { sourceUrl: null, title: 'ok', entityType: 'organization', normalizedValue: i.subject.value, category: 'web_mention', claimType: 'UNVERIFIED_LEAD' })] }; } };
    registerProvider(thrower);
    registerProvider(ok);
    const { user } = await makeUser('Thrower');
    const id = await createInvestigation(user.id, { name: 'Thrower', depth: 'custom', mode: 'demo', modules: ['web_search'], providers: ['test.thrower', 'test.ok'], targets: [{ type: 'organization', value: 'Fictional Org' }], start: false });
    await startInvestigation(id, user.id);
    expect(await processNextJob(db())).toBe('partially_completed');
    const p = await jobProgress(id, user.id);
    expect(p.tasks.find((t) => t.providerId === 'test.thrower')).toMatchObject({ status: 'failed', errorCategory: 'internal' });

    const id2 = await createInvestigation(user.id, { name: 'Nothing runs', depth: 'custom', mode: 'demo', modules: ['crypto'], providers: [], targets: [{ type: 'organization', value: 'Fictional Org' }], start: false });
    await startInvestigation(id2, user.id);
    expect(await processNextJob(db())).toBe('failed');
    expect((await getInvestigationDetail(id2, user.id)).latestJob?.error).toMatch(/No usable providers/);
  });
});
