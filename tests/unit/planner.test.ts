import { describe, expect, it } from 'vitest';
import { planCollection, planPivots, deriveSubjects, type PlanSubject } from '@/server/engine/planner';
import { env } from '@/server/config/env';

const subj = (type: PlanSubject['type'], value: string, metadata: Record<string, unknown> = {}): PlanSubject => ({ type, value, display: value, metadata, targetId: 't', entityId: null });
const base = { modules: [], providerAllowList: [], userDisabled: new Set<string>(), related: [], scope: null };

describe('collection planner', () => {
  it('demo mode only schedules simulated and local providers', () => {
    const tasks = planCollection([subj('domain', 'example.com')], { ...base, depth: 'deep', mode: 'demo', env: env() });
    const ids = new Set(tasks.map((t) => t.providerId));
    expect([...ids].every((id) => id.startsWith('demo.') || id.startsWith('local.'))).toBe(true);
    expect(ids.has('demo.infrastructure')).toBe(true);
    expect(tasks.every((t) => t.status === 'queued')).toBe(true);
  });

  it('live mode records unconfigured providers as skipped with the missing variable', () => {
    const tasks = planCollection([subj('email', 'a@example.org', { domain: 'example.org' })], { ...base, depth: 'standard', mode: 'live', env: { ...env(), HIBP_API_KEY: undefined } });
    const hibp = tasks.find((t) => t.providerId === 'hibp');
    expect(hibp).toMatchObject({ status: 'skipped', errorCategory: 'not_configured' });
    expect(hibp?.errorMessage).toMatch(/HIBP_API_KEY/);
    expect(tasks.some((t) => t.providerId === 'dns' && t.operation === 'email_domain' && t.status === 'queued')).toBe(true);
  });

  it('configured search providers get one task per planned query', () => {
    const tasks = planCollection([subj('username', 'shadowfox')], { ...base, depth: 'quick', mode: 'live', env: { ...env(), BRAVE_SEARCH_API_KEY: 'k' } });
    const brave = tasks.filter((t) => t.providerId === 'brave');
    expect(brave).toHaveLength(2);
    expect(brave.every((t) => typeof t.params.query === 'string')).toBe(true);
  });

  it('respects depth: deep-only operations are not run at quick depth', () => {
    const quick = planCollection([subj('ip', '8.8.8.8')], { ...base, depth: 'quick', mode: 'live', env: { ...env(), SHODAN_API_KEY: 'k' } });
    expect(quick.some((t) => t.providerId === 'shodan')).toBe(false);
    const deep = planCollection([subj('ip', '8.8.8.8')], { ...base, depth: 'deep', mode: 'live', env: { ...env(), SHODAN_API_KEY: 'k' } });
    expect(deep.some((t) => t.providerId === 'shodan' && t.status === 'queued')).toBe(true);
  });

  it('custom depth honours selected modules and provider allow-list; user-disabled providers are skipped', () => {
    const tasks = planCollection([subj('domain', 'example.com')], { ...base, depth: 'custom', modules: ['domain'], providerAllowList: ['dns', 'rdap'], userDisabled: new Set(['rdap']), mode: 'live', env: env() });
    expect(new Set(tasks.map((t) => t.providerId))).toEqual(new Set(['dns', 'rdap']));
    expect(tasks.find((t) => t.providerId === 'rdap')).toMatchObject({ status: 'skipped', errorCategory: 'disabled' });
  });

  it('derives the host of URL targets as a domain subject', () => {
    const subjects = deriveSubjects(subj('url', 'https://login.example.com/x', { host: 'login.example.com' }), 'quick');
    expect(subjects.map((s) => `${s.type}:${s.value}`)).toEqual(['url:https://login.example.com/x', 'domain:login.example.com']);
  });

  it('pivots only use lightweight infrastructure operations', () => {
    const tasks = planPivots([{ id: 'e1', type: 'domain', value: 'vpn.example.com', display: 'vpn.example.com' }, { id: 'e2', type: 'ip', value: '8.8.8.8', display: '8.8.8.8' }], { ...base, depth: 'deep', mode: 'live', env: env() });
    const ops = new Set(tasks.map((t) => t.operation));
    expect(ops.has('dns_records')).toBe(true);
    expect(ops.has('asn_lookup')).toBe(true);
    expect(ops.has('ct_search')).toBe(false);
    expect(ops.has('web_search')).toBe(false);
    expect(tasks.every((t) => t.stage === 'pivot')).toBe(true);
  });
});
