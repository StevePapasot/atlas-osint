import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpClient } from '@/server/providers/http';

let server: http.Server;
let base = '';

beforeAll(async () => {
  process.env.ATLAS_ALLOW_PRIVATE_EGRESS = 'true'; // local test server on 127.0.0.1
  process.env.ATLAS_IGNORE_PROXY = 'true';
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/ok') return res.end(JSON.stringify({ ok: true }));
    if (u.pathname === '/slow') return setTimeout(() => res.end('late'), 2000);
    if (u.pathname === '/429') { res.statusCode = 429; res.setHeader('retry-after', '2'); return res.end(); }
    if (u.pathname === '/401') { res.statusCode = 401; return res.end(); }
    if (u.pathname === '/500') { res.statusCode = 500; return res.end(); }
    if (u.pathname === '/404') { res.statusCode = 404; return res.end('{}'); }
    if (u.pathname === '/big') return res.end('x'.repeat(50_000));
    if (u.pathname === '/badjson') return res.end('{not json');
    res.statusCode = 400;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  delete process.env.ATLAS_ALLOW_PRIVATE_EGRESS;
  delete process.env.ATLAS_IGNORE_PROXY;
});

const client = (signal = new AbortController().signal) => createHttpClient({ signal, userAgent: 'test', defaultTimeoutMs: 500 });

describe('provider HTTP client', () => {
  it('parses JSON', async () => {
    expect((await client().request(`${base}/ok`)).json()).toEqual({ ok: true });
  });
  it('classifies timeouts as retryable', async () => {
    await expect(client().request(`${base}/slow`, { timeoutMs: 200 })).rejects.toMatchObject({ category: 'timeout', retryable: true });
  });
  it('classifies 429 with Retry-After, 401 as auth, 5xx as retryable upstream errors', async () => {
    await expect(client().request(`${base}/429`)).rejects.toMatchObject({ category: 'rate_limited', retryAfterMs: 2000 });
    await expect(client().request(`${base}/401`)).rejects.toMatchObject({ category: 'auth', retryable: false });
    await expect(client().request(`${base}/500`)).rejects.toMatchObject({ category: 'upstream_error', retryable: true });
  });
  it('returns allowed statuses instead of throwing', async () => {
    expect((await client().request(`${base}/404`, { allowStatus: [404] })).status).toBe(404);
  });
  it('enforces response size limits and reports malformed JSON', async () => {
    await expect(client().request(`${base}/big`, { maxBytes: 1000 })).rejects.toMatchObject({ category: 'parse_error' });
    const r = await client().request(`${base}/badjson`);
    expect(() => r.json()).toThrow(/malformed JSON/);
  });
  it('honours cancellation', async () => {
    const ac = new AbortController();
    const p = client(ac.signal).request(`${base}/slow`, { timeoutMs: 5000 });
    ac.abort();
    await expect(p).rejects.toMatchObject({ category: 'cancelled' });
  });
  it('blocks private destinations unless explicitly allowed', async () => {
    process.env.ATLAS_ALLOW_PRIVATE_EGRESS = 'false';
    await expect(client().request(`${base}/ok`)).rejects.toMatchObject({ category: 'invalid_input' });
    process.env.ATLAS_ALLOW_PRIVATE_EGRESS = 'true';
  });
});
