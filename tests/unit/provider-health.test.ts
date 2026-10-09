import { describe, expect, it } from 'vitest';
import { ProviderError, type Provider } from '@/server/providers/types';
import { ALL_PROVIDERS, isProviderUsable } from '@/server/providers/registry';
import { braveSearchProvider, serpApiProvider, parallelSearchProvider } from '@/server/providers/search';
import { githubProvider, redditProvider, youtubeProvider } from '@/server/providers/username';
import { hibpProvider } from '@/server/providers/email';
import { crtShProvider } from '@/server/providers/domain/history';
import { abuseIpDbProvider, ipinfoProvider, reverseDnsProvider, shodanProvider, virusTotalProvider } from '@/server/providers/ip';
import { etherscanProvider } from '@/server/providers/crypto';
import { intelxProvider } from '@/server/providers/darkweb';
import { env } from '@/server/config/env';
import { ctx, fakeDns, fakeHttp } from '../helpers/provider-harness';

const health = (p: Provider, http: ReturnType<typeof fakeHttp>, overrides: Parameters<typeof ctx>[2] = {}, dns = fakeDns()) => p.healthCheck!(ctx(http, dns, overrides));

describe('health checks of keyed providers', () => {
  it('every provider that needs a key can verify it', () => {
    const keyed = ALL_PROVIDERS.filter((p) => p.config.some((c) => !c.optional && /_(API_KEY|TOKEN)$/.test(String(c.env))) && p.id !== 'darkweb.custom');
    expect(keyed.map((p) => p.id).sort()).toEqual(['abuseipdb', 'brave', 'etherscan', 'hibp', 'intelx', 'parallel', 'serpapi', 'shodan', 'virustotal', 'youtube']);
    for (const p of keyed) expect(p.healthCheck, p.id).toBeTypeOf('function');
  });

  it('Brave: sends the key and explains SUBSCRIPTION_TOKEN_INVALID', async () => {
    const ok = fakeHttp(() => ({ body: { web: { results: [] } } }));
    await expect(health(braveSearchProvider, ok, { BRAVE_SEARCH_API_KEY: 'k' })).resolves.toMatchObject({ status: 'healthy' });
    expect(ok.calls[0]!.opts.headers).toMatchObject({ 'X-Subscription-Token': 'k', accept: 'application/json' });
    const invalid = fakeHttp(() => new ProviderError('upstream_error', 'Provider rejected the request (HTTP 422): SUBSCRIPTION_TOKEN_INVALID: The provided subscription token is invalid.'));
    await expect(health(braveSearchProvider, invalid, { BRAVE_SEARCH_API_KEY: 'k' })).rejects.toMatchObject({ category: 'auth', message: expect.stringMatching(/^Brave did not accept the API key/) });
    const badParam = fakeHttp(() => new ProviderError('upstream_error', 'Provider rejected the request (HTTP 422): VALIDATION: count must be <= 20.'));
    await expect(health(braveSearchProvider, badParam, { BRAVE_SEARCH_API_KEY: 'k' })).rejects.toMatchObject({ category: 'upstream_error' });
  });

  it('SerpApi: uses the free Account API and reports only the searches left', async () => {
    const http = fakeHttp(() => ({ body: { account_email: 'someone@example.org', plan_searches_left: 240, total_searches_left: 240 } }));
    const r = await health(serpApiProvider, http, { SERPAPI_API_KEY: 'k' });
    expect(http.calls[0]!.url).toBe('https://serpapi.com/account.json?api_key=k');
    expect(r).toMatchObject({ status: 'healthy', message: 'SerpApi accepted the key: 240 search(es) left.' });
    expect(r.message).not.toContain('example.org');
    await expect(health(serpApiProvider, fakeHttp(() => ({ body: { total_searches_left: 0 } })), { SERPAPI_API_KEY: 'k' })).resolves.toMatchObject({ status: 'degraded' });
  });

  it('Parallel: one minimal search with the key header', async () => {
    const http = fakeHttp(() => ({ body: { results: [] } }));
    await expect(health(parallelSearchProvider, http, { PARALLEL_API_KEY: 'k' })).resolves.toMatchObject({ status: 'healthy' });
    expect(http.calls[0]!.opts).toMatchObject({ method: 'POST', headers: { 'x-api-key': 'k' } });
    expect(JSON.parse(http.calls[0]!.opts.body as string)).toMatchObject({ max_results: 1 });
  });

  it('GitHub and IPinfo: verify the optional token when one is set', async () => {
    const gh = fakeHttp(() => ({ body: { resources: { core: { limit: 5000, remaining: 4999 } } } }));
    await expect(health(githubProvider, gh, { GITHUB_TOKEN_OSINT: 't' })).resolves.toMatchObject({ message: 'GitHub accepted the token (4999 of 5000 requests left this hour).' });
    expect(gh.calls[0]!.url).toBe('https://api.github.com/rate_limit');
    expect(gh.calls[0]!.opts.headers!.authorization).toBe('Bearer t');
    const anon = fakeHttp(() => ({ body: { resources: { core: { limit: 60, remaining: 60 } } } }));
    await expect(health(githubProvider, anon, { GITHUB_TOKEN_OSINT: undefined })).resolves.toMatchObject({ message: expect.stringMatching(/without a token \(60 of 60/) });
    expect(anon.calls[0]!.opts.headers!.authorization).toBeUndefined();

    const ii = fakeHttp(() => ({ body: { ip: '8.8.8.8' } }));
    await expect(health(ipinfoProvider, ii, { IPINFO_TOKEN: 't' })).resolves.toMatchObject({ message: 'IPinfo accepted the token.' });
    expect(ii.calls[0]!.opts.headers).toEqual({ authorization: 'Bearer t' });
    await expect(health(ipinfoProvider, fakeHttp(() => ({ body: {} })), { IPINFO_TOKEN: undefined })).resolves.toMatchObject({ message: expect.stringMatching(/without a token/) });
  });

  it('AbuseIPDB, VirusTotal, Shodan, YouTube, HIBP and Intelligence X send their keys to documented endpoints', async () => {
    const abuse = fakeHttp(() => ({ body: { data: {} }, headers: { 'x-ratelimit-remaining': '998' } }));
    await expect(health(abuseIpDbProvider, abuse, { ABUSEIPDB_API_KEY: 'k' })).resolves.toMatchObject({ message: 'AbuseIPDB accepted the key: 998 check(s) left today.' });
    expect(abuse.calls[0]!.opts.headers!.key).toBe('k');

    const vt = fakeHttp(() => ({ body: { data: { attributes: {} } } }));
    await expect(health(virusTotalProvider, vt, { VIRUSTOTAL_API_KEY: 'k' })).resolves.toMatchObject({ status: 'healthy' });
    expect(vt.calls[0]!.opts.headers!['x-apikey']).toBe('k');

    const sh = fakeHttp(() => ({ body: { plan: 'dev', query_credits: 100 } }));
    await expect(health(shodanProvider, sh, { SHODAN_API_KEY: 'k' })).resolves.toMatchObject({ message: 'Shodan accepted the key (plan dev, 100 query credit(s)).' });
    expect(sh.calls[0]!.url).toBe('https://api.shodan.io/api-info?key=k');

    const yt = fakeHttp(() => ({ body: { items: [] } }));
    await expect(health(youtubeProvider, yt, { YOUTUBE_API_KEY: 'k' })).resolves.toMatchObject({ status: 'healthy' });
    expect(yt.calls[0]!.url).toMatch(/^https:\/\/www\.googleapis\.com\/youtube\/v3\/i18nLanguages\?.*key=k$/);

    const hibp = fakeHttp(() => ({ body: { SubscriptionName: 'Pwned 1', SubscribedUntil: '2027-01-01T00:00:00' } }));
    await expect(health(hibpProvider, hibp, { HIBP_API_KEY: 'k' })).resolves.toMatchObject({ message: 'HIBP accepted the key (Pwned 1, until 2027-01-01).' });
    expect(hibp.calls[0]!.url).toBe('https://haveibeenpwned.com/api/v3/subscription/status');
    expect(hibp.calls[0]!.opts.headers!['hibp-api-key']).toBe('k');

    const ix = fakeHttp(() => ({ body: { paths: {} } }));
    await expect(health(intelxProvider, ix, { INTELX_API_KEY: 'k', INTELX_API_URL: 'https://free.intelx.io/' })).resolves.toMatchObject({ status: 'healthy' });
    expect(ix.calls[0]!.url).toBe('https://free.intelx.io/authenticate/info');
    expect(ix.calls[0]!.opts.headers!['x-key']).toBe('k');
  });

  it('Etherscan: errors arrive as HTTP 200 with status 0 and are reported without the key', async () => {
    const ok = fakeHttp(() => ({ body: { status: '1', message: 'OK', result: '0' } }));
    await expect(health(etherscanProvider, ok, { ETHERSCAN_API_KEY: 'k' })).resolves.toMatchObject({ status: 'healthy' });
    expect(ok.calls[0]!.url).toMatch(/^https:\/\/api\.etherscan\.io\/v2\/api\?chainid=1&module=account&action=balance/);
    const bad = fakeHttp(() => ({ body: { status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)|FICTIONALKEY000000000000000000000000' } }));
    await expect(health(etherscanProvider, bad, { ETHERSCAN_API_KEY: 'FICTIONALKEY000000000000000000000000' })).rejects.toMatchObject({
      category: 'auth',
      message: 'Etherscan did not accept the key: Invalid API Key (#err2)',
    });
  });
});

describe('health checks of keyless providers', () => {
  it('crt.sh: a timeout explains that the service is often overloaded', async () => {
    const http = fakeHttp(() => new ProviderError('timeout', 'No answer within 30 s.', true));
    await expect(health(crtShProvider, http)).rejects.toMatchObject({ category: 'timeout', message: expect.stringMatching(/crt\.sh did not answer within 30 s/) });
    expect(http.calls[0]!.opts.timeoutMs).toBe(30000);
  });

  it('Reddit: opt-in, and a refusal says why instead of asking for credentials', async () => {
    expect(isProviderUsable(redditProvider, env())).toBe(false);
    expect(isProviderUsable(redditProvider, { ...env(), ATLAS_ENABLE_REDDIT: true })).toBe(true);
    const http = fakeHttp(() => ({ status: 403 }));
    await expect(health(redditProvider, http)).rejects.toMatchObject({ category: 'auth', message: expect.stringMatching(/^Reddit refused the request \(HTTP 403\)\. .*ATLAS_ENABLE_REDDIT=false/) });
  });

  it('reverse DNS: suggests public resolvers when the system resolver has no PTR answers', async () => {
    const empty = fakeDns({ reverse: { '8.8.8.8': [] } });
    await expect(health(reverseDnsProvider, fakeHttp(() => ({})), { ATLAS_DNS_SERVERS: undefined }, empty)).resolves.toMatchObject({
      status: 'degraded',
      message: expect.stringMatching(/set ATLAS_DNS_SERVERS=1\.1\.1\.1,9\.9\.9\.9/),
    });
    const answered = fakeDns({ reverse: { '8.8.8.8': ['dns.google'] } });
    await expect(health(reverseDnsProvider, fakeHttp(() => ({})), {}, answered)).resolves.toMatchObject({ status: 'healthy' });
  });
});
