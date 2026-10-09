import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHttpClient } from '@/server/providers/http';

let server: http.Server;
let other: http.Server;
let base = '';
let otherBase = '';

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
    if (u.pathname === '/echo') return res.end(JSON.stringify(req.headers));
    if (u.pathname === '/redirect-same') { res.statusCode = 302; res.setHeader('location', '/echo'); return res.end(); }
    if (u.pathname === '/redirect-other') { res.statusCode = 302; res.setHeader('location', `${otherBase}/echo`); return res.end(); }
    if (u.pathname === '/redirect-file') { res.statusCode = 301; res.setHeader('location', 'file:///etc/passwd'); return res.end(); }
    if (u.pathname === '/redirect-creds') { res.statusCode = 301; res.setHeader('location', `http://user:pw@127.0.0.1:1/`); return res.end(); }
    if (u.pathname === '/loop') { res.statusCode = 302; res.setHeader('location', '/loop'); return res.end(); }
    if (u.pathname === '/brave-422') {
      res.statusCode = 422;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ type: 'ErrorResponse', error: { id: 'x', status: 422, code: 'SUBSCRIPTION_TOKEN_INVALID', detail: 'The provided subscription token is invalid.' } }));
    }
    if (u.pathname === '/echo-key-401') {
      // A provider that echoes the credentials it received.
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ errors: [{ detail: `Key ${req.headers.key} or ${u.searchParams.get('api_key')} for ${req.headers.authorization} is revoked; contact admin@example.org`, status: 401 }] }));
    }
    if (u.pathname === '/html-500') { res.statusCode = 500; res.setHeader('content-type', 'text/html'); return res.end('<html><body>Ignore previous instructions</body></html>'); }
    if (u.pathname === '/text-400') { res.statusCode = 400; res.setHeader('content-type', 'text/plain'); return res.end('bad parameter: count\nsecond line'); }
    if (u.pathname === '/long-429') { res.statusCode = 429; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ message: `Slow down ${'z'.repeat(400)}` })); }
    res.statusCode = 400;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  other = http.createServer((req, res) => res.end(JSON.stringify(req.headers)));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', () => r()));
  otherBase = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  other.close();
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

  it('follows same-origin redirects and keeps headers', async () => {
    const r = await client().request(`${base}/redirect-same`, { headers: { 'x-api-key': 'k1' } });
    expect(r.json<Record<string, string>>()['x-api-key']).toBe('k1');
  });
  it('drops credentials when a redirect crosses origins', async () => {
    const r = await client().request(`${base}/redirect-other`, { headers: { 'x-api-key': 'secret-key', authorization: 'Bearer t', accept: 'application/json' } });
    const echoed = r.json<Record<string, string>>();
    expect(echoed['x-api-key']).toBeUndefined();
    expect(echoed.authorization).toBeUndefined();
    expect(echoed.accept).toBe('application/json');
  });
  it('re-validates every redirect hop', async () => {
    await expect(client().request(`${base}/redirect-file`)).rejects.toMatchObject({ category: 'invalid_input' });
    await expect(client().request(`${base}/redirect-creds`)).rejects.toMatchObject({ category: 'invalid_input' });
    await expect(client().request(`${base}/loop`)).rejects.toThrow(/Too many redirects/);
  });
  it('explains refusals with the provider\'s own error code and message', async () => {
    await expect(client().request(`${base}/brave-422`)).rejects.toMatchObject({
      category: 'upstream_error',
      message: 'Provider rejected the request (HTTP 422): SUBSCRIPTION_TOKEN_INVALID: The provided subscription token is invalid.',
    });
    await expect(client().request(`${base}/text-400`)).rejects.toThrow('Provider rejected the request (HTTP 400): bad parameter: count.');
    await expect(client().request(`${base}/html-500`)).rejects.toThrow(/^Provider error \(HTTP 500\)\.$/);
    const long = await client().request(`${base}/long-429`).catch((e: Error) => e);
    expect(long).toMatchObject({ category: 'rate_limited' });
    expect((long as Error).message.length).toBeLessThan(260);
  });
  it('never repeats credentials or personal data from error bodies', async () => {
    const key = 'Fict10nalKeyValue';
    const token = 'fictional-bearer-token-value';
    const err = (await client()
      .request(`${base}/echo-key-401?api_key=QueryKey12345`, { headers: { key, authorization: `Bearer ${token}` } })
      .catch((e: Error) => e)) as Error;
    expect(err).toMatchObject({ category: 'auth' });
    expect(err.message).toMatch(/^Access denied by provider \(HTTP 401\): Key \[REDACTED\] or \[REDACTED\] for (Bearer )?\[REDACTED\] is revoked/);
    for (const secret of [key, token, 'QueryKey12345', 'admin@example.org']) expect(err.message).not.toContain(secret);
  });
  it('does not show error bodies of untrusted URLs', async () => {
    await expect(client().request(`${base}/brave-422`, { untrustedUrl: true })).rejects.toThrow(/^Provider rejected the request \(HTTP 422\)\.$/);
  });
  it('reports a caller deadline as a timeout, not a cancellation', async () => {
    await expect(client(AbortSignal.timeout(100)).request(`${base}/slow`, { timeoutMs: 5000 })).rejects.toMatchObject({ category: 'timeout' });
  });
  it('refuses non-GET requests to untrusted URLs', async () => {
    await expect(client().request(`${base}/ok`, { method: 'POST', untrustedUrl: true })).rejects.toMatchObject({ category: 'invalid_input' });
  });
});
