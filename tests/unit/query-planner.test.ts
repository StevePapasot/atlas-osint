import { describe, expect, it } from 'vitest';
import { planQueries } from '@/server/engine/query-planner';

describe('search query planning', () => {
  it('plans username queries including GitHub, forums and associated email at deep depth', () => {
    const q = planQueries('username', 'shadowfox', 'shadowfox', { depth: 'deep', related: [{ type: 'email', value: 'j@example.org', display: 'j@example.org' }] });
    const texts = q.map((x) => x.query);
    expect(texts).toContain('"shadowfox"');
    expect(texts).toContain('"shadowfox" site:github.com');
    expect(texts.some((t) => t.includes('forum'))).toBe(true);
    expect(texts).toContain('"shadowfox" "j@example.org"');
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('bounds the number of queries by depth', () => {
    const n = (depth: 'quick' | 'standard' | 'deep') => planQueries('domain', 'example.com', 'example.com', { depth, related: [] }).length;
    expect(n('quick')).toBe(2);
    expect(n('standard')).toBeLessThanOrEqual(5);
    expect(n('deep')).toBeGreaterThan(n('standard'));
  });

  it('plans domain queries for references, documents and certificates', () => {
    const texts = planQueries('domain', 'example.com', 'example.com', { depth: 'deep', related: [{ type: 'organization', value: 'acme', display: 'Acme Ltd' }] }).map((x) => x.query);
    expect(texts).toContain('site:example.com');
    expect(texts).toContain('"example.com" -site:example.com');
    expect(texts.some((t) => t.includes('filetype:pdf'))).toBe(true);
    expect(texts).toContain('"example.com" "Acme Ltd"');
    expect(texts.some((t) => t.includes('certificate'))).toBe(true);
  });

  it('uses scope-stated locations and related organisations for person queries', () => {
    const texts = planQueries('person', 'jane doe', 'Jane Doe', { depth: 'deep', related: [{ type: 'organization', value: 'n', display: 'Northwind' }], scope: 'Review of a contractor based in Lisbon' }).map((x) => x.query);
    expect(texts).toContain('"Jane Doe"');
    expect(texts).toContain('"Jane Doe" "Northwind"');
    expect(texts).toContain('"Jane Doe" "Lisbon"');
  });

  it('never emits raw quotes from user input that would break query syntax', () => {
    const q = planQueries('keyword', 'a"b', 'a"b', { depth: 'quick', related: [] });
    expect(q[0]!.query).toBe('"ab"');
  });
});
