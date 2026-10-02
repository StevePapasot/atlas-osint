import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rateLimit } from '@/server/security/rate-limit';

describe('rateLimit (in-memory store)', () => {
  const previous = process.env.ATLAS_DISABLE_RATE_LIMIT;
  beforeAll(() => {
    process.env.ATLAS_DISABLE_RATE_LIMIT = 'false';
  });
  afterAll(() => {
    process.env.ATLAS_DISABLE_RATE_LIMIT = previous;
  });

  it('allows up to the limit within a window, then blocks with a retry hint', async () => {
    const key = `test:${Math.random()}`;
    for (let i = 0; i < 3; i++) expect((await rateLimit(key, 3, 60_000)).allowed).toBe(true);
    const blocked = await rateLimit(key, 3, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('keeps buckets independent and resets after the window', async () => {
    const a = `a:${Math.random()}`;
    const b = `b:${Math.random()}`;
    expect((await rateLimit(a, 1, 50)).allowed).toBe(true);
    expect((await rateLimit(a, 1, 50)).allowed).toBe(false);
    expect((await rateLimit(b, 1, 50)).allowed).toBe(true);
    await new Promise((r) => setTimeout(r, 70));
    expect((await rateLimit(a, 1, 50)).allowed).toBe(true);
  });
});
