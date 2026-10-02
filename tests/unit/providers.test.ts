import { describe, expect, it } from 'vitest';
import { ProviderError } from '@/server/providers/types';
import { braveSearchProvider, serpApiProvider, parallelSearchProvider } from '@/server/providers/search';
import { githubProvider, gitlabProvider, npmProvider, mastodonProvider, keybaseProvider, hackerNewsProvider } from '@/server/providers/username';
import { hibpProvider, gravatarProvider } from '@/server/providers/email';
import { rdapProvider } from '@/server/providers/domain/rdap';
import { crtShProvider, waybackProvider } from '@/server/providers/domain/history';
import { dnsProvider } from '@/server/providers/domain/dns';
import { cymruProvider, cymruQueryName, parseCymruOrigin, internetDbProvider, reverseDnsProvider, abuseIpDbProvider, virusTotalProvider, ipinfoProvider } from '@/server/providers/ip';
import { blockstreamProvider } from '@/server/providers/crypto';
import { intelxProvider } from '@/server/providers/darkweb';
import { phoneNumberingProvider, cryptoFormatProvider, urlAnalysisProvider } from '@/server/providers/local';
import { gazetteerProvider } from '@/server/providers/geoint';
import { ctx, fakeDns, fakeHttp, input } from '../helpers/provider-harness';

describe('search providers', () => {
  it('Brave: sends the subscription token, normalizes results as unverified leads', async () => {
    const http = fakeHttp(() => ({ body: { web: { results: [{ url: 'https://news.example.com/a?utm_source=x', title: '<strong>shadowfox</strong> interview', description: 'An interview with shadowfox', page_age: '2024-03-01T00:00:00Z' }] } } }));
    const res = await braveSearchProvider.run(input('username', 'shadowfox', { params: { query: '"shadowfox"', purpose: 'exact' } }), ctx(http, undefined, { BRAVE_SEARCH_API_KEY: 'k' }));
    expect(http.calls[0]!.opts.headers!['X-Subscription-Token']).toBe('k');
    const r = res.records[0]!;
    expect(r.claimType).toBe('UNVERIFIED_LEAD');
    expect(r.sourceUrl).toBe('https://news.example.com/a');
    expect(r.title).toBe('shadowfox interview');
    expect(r.publishedAt).toBe('2024-03-01T00:00:00.000Z');
    expect(r.confidenceInputs.matchType).toBe('exact');
    expect(r.relationships?.some((x) => x.type === 'MENTIONS')).toBe(true);
  });
  it('SerpApi and Parallel produce the same fingerprint for the same page (cross-provider dedupe)', async () => {
    const serp = await serpApiProvider.run(input('domain', 'example.com', { operation: 'web_search', params: { query: 'x' } }), ctx(fakeHttp(() => ({ body: { organic_results: [{ position: 1, title: 'T', link: 'https://www.example.com/page/' }] } })), undefined, { SERPAPI_API_KEY: 'k' }));
    const par = await parallelSearchProvider.run(input('domain', 'example.com', { params: { query: 'x' } }), ctx(fakeHttp(() => ({ body: { results: [{ url: 'http://example.com/page', title: 'T', excerpts: ['e'] }] } })), undefined, { PARALLEL_API_KEY: 'k' }));
    expect(serp.records[0]!.fingerprintKey).toBe(par.records[0]!.fingerprintKey);
  });
  it('propagates quota errors as rate_limited', async () => {
    const http = fakeHttp(() => ({ status: 429 }));
    await expect(braveSearchProvider.run(input('keyword', 'x', { params: { query: 'x' } }), ctx(http, undefined, { BRAVE_SEARCH_API_KEY: 'k' }))).rejects.toMatchObject({ category: 'rate_limited' });
  });
});

describe('username providers', () => {
  it('GitHub: builds a profile with linked website, geocoded self-reported location and creation event', async () => {
    const http = fakeHttp(() => ({ body: { login: 'octocat', name: 'The Octocat', bio: 'mascot', blog: 'https://github.blog', location: 'San Francisco', email: null, company: '@github', created_at: '2011-01-25T18:44:36Z', html_url: 'https://github.com/octocat', avatar_url: 'x', followers: 1, public_repos: 8, twitter_username: null, type: 'User' } }));
    const res = await githubProvider.run(input('username', 'octocat', { operation: 'github_user' }), ctx(http));
    const r = res.records[0]!;
    expect(r.normalizedValue).toBe('github:octocat');
    expect(r.claimType).toBe('SOURCE_CLAIM');
    expect(r.geo).toMatchObject({ precision: 'city', countryCode: 'US' });
    expect(r.events?.[0]?.date).toBe('2011-01-25T18:44:36.000Z');
    expect(r.relationships?.find((x) => x.type === 'USES')?.status).toBe('possible');
    expect(r.relationships?.find((x) => x.to === 'site')?.status).toBe('confirmed');
  });
  it('GitHub: 404 means no account (no finding, a note)', async () => {
    const res = await githubProvider.run(input('username', 'nobody-here', { operation: 'github_user' }), ctx(fakeHttp(() => ({ status: 404 }))));
    expect(res.records).toHaveLength(0);
    expect(res.notes?.[0]).toMatch(/No GitHub account/);
  });
  it('GitLab and npm parse their public APIs', async () => {
    const gl = await gitlabProvider.run(input('username', 'gitlab'), ctx(fakeHttp(() => ({ body: [{ id: 1, username: 'gitlab', name: 'GitLab', state: 'active', avatar_url: 'a', web_url: 'https://gitlab.com/gitlab' }] }))));
    expect(gl.records[0]!.sourceUrl).toBe('https://gitlab.com/gitlab');
    const npm = await npmProvider.run(input('username', 'sindresorhus'), ctx(fakeHttp(() => ({ body: { total: 2, objects: [{ package: { name: 'a', version: '1', date: '2025-01-01T00:00:00Z', maintainers: [{ username: 'sindresorhus', email: 's@example.org' }] } }] } }))));
    expect(npm.records[0]!.title).toMatch(/2 package/);
    expect(npm.records[0]!.entities?.some((e) => e.type === 'email' && e.value === 's@example.org')).toBe(true);
  });
  it('Mastodon: tolerates individual instance failures', async () => {
    const http = fakeHttp((url) => (url.includes('mastodon.social') ? new ProviderError('network', 'down', true) : url.includes('fosstodon') ? { status: 404 } : { body: { username: 'alice', acct: 'alice', display_name: 'Alice', note: '<p>hi</p>', url: 'https://infosec.exchange/@alice', created_at: '2020-01-01T00:00:00Z', followers_count: 3, fields: [] } }));
    const res = await mastodonProvider.run(input('username', 'alice'), ctx(http));
    expect(res.records).toHaveLength(1);
    expect(res.notes?.join(' ')).toMatch(/mastodon.social/);
  });
  it('Keybase: cryptographic proofs become confirmed LINKED_TO relationships', async () => {
    const http = fakeHttp(() => ({ body: { them: [{ basics: { username: 'chris', ctime: 1400000000 }, profile: { full_name: 'Chris' }, proofs_summary: { all: [{ proof_type: 'github', nametag: 'chris', service_url: 'https://github.com/chris' }] } }] } }));
    const r = (await keybaseProvider.run(input('username', 'chris'), ctx(http))).records[0]!;
    expect(r.relationships?.some((x) => x.type === 'LINKED_TO' && x.status === 'confirmed' && x.rationale.includes('proof'))).toBe(true);
  });
  it('Hacker News: null response means no account', async () => {
    const res = await hackerNewsProvider.run(input('username', 'nobody'), ctx(fakeHttp(() => ({ text: 'null' }))));
    expect(res.records).toHaveLength(0);
  });
});

describe('email providers', () => {
  it('HIBP: sends the API key and records breaches with breach dates; 404 means none', async () => {
    const http = fakeHttp(() => ({ body: [{ Name: 'Adobe', Title: 'Adobe', Domain: 'adobe.com', BreachDate: '2013-10-04', AddedDate: '2013-12-04T00:00:00Z', PwnCount: 152445165, DataClasses: ['Email addresses', 'Passwords'], IsVerified: true, IsFabricated: false }] }));
    const r = await hibpProvider.run(input('email', 'a@example.org'), ctx(http, undefined, { HIBP_API_KEY: 'k' }));
    expect(http.calls[0]!.opts.headers!['hibp-api-key']).toBe('k');
    expect(r.records[0]!.events?.[0]?.date).toBe('2013-10-04T00:00:00.000Z');
    expect(r.records[0]!.category).toBe('breach');
    const none = await hibpProvider.run(input('email', 'b@example.org'), ctx(fakeHttp(() => ({ status: 404 })), undefined, { HIBP_API_KEY: 'k' }));
    expect(none.records).toHaveLength(0);
  });
  it('Gravatar: looks up by SHA-256 of the normalized email and links verified accounts', async () => {
    const http = fakeHttp(() => ({ body: { hash: 'h', display_name: 'J', profile_url: 'https://gravatar.com/jd', verified_accounts: [{ service_type: 'github', service_label: 'GitHub', url: 'https://github.com/jd' }] } }));
    const r = (await gravatarProvider.run(input('email', 'j@example.org'), ctx(http))).records[0]!;
    expect(http.calls[0]!.url).toMatch(/[0-9a-f]{64}$/);
    expect(r.relationships?.[0]).toMatchObject({ type: 'USES', status: 'confirmed' });
  });
});

describe('domain providers', () => {
  it('DNS: records A/MX/NS/TXT facts and technology indicators', async () => {
    const dns = fakeDns({
      resolve4: { 'example.com': ['93.184.215.14'] },
      resolveMx: { 'example.com': [{ exchange: 'aspmx.l.google.com', priority: 1 }] },
      resolveNs: { 'example.com': ['a.ns.cloudflare.com'] },
      resolveTxt: { 'example.com': [['google-site-verification=x'], ['v=spf1 -all']] },
    });
    const res = await dnsProvider.run(input('domain', 'example.com', { operation: 'dns_records' }), ctx(fakeHttp(() => ({})), dns));
    const titles = res.records.map((r) => r.title);
    expect(titles.some((t) => t.includes('resolves to 93.184.215.14'))).toBe(true);
    expect(res.records.filter((r) => r.claimType === 'INFERENCE').map((r) => r.title).join(' ')).toMatch(/Google Workspace.*Cloudflare DNS|Cloudflare DNS.*Google Workspace/);
    const a = res.records.find((r) => r.metadata?.A)!;
    expect(a.relationships?.[0]).toMatchObject({ type: 'RESOLVES_TO', status: 'confirmed' });
  });
  it('DNS: mail policy reports SPF and missing DMARC', async () => {
    const dns = fakeDns({ resolveTxt: { 'example.com': [['v=spf1 ~all']], '_dmarc.example.com': [] } });
    const res = await dnsProvider.run(input('domain', 'example.com', { operation: 'mail_policy' }), ctx(fakeHttp(() => ({})), dns));
    expect(res.records.map((r) => r.title)).toEqual(expect.arrayContaining([expect.stringMatching(/Soft fail/), expect.stringMatching(/no DMARC/)]));
  });
  it('RDAP: extracts registrar, redacted registrant and registration events', async () => {
    const http = fakeHttp(() => ({
      body: {
        ldhName: 'example.com',
        status: ['active'],
        events: [{ eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-08-13T04:00:00Z' }],
        entities: [
          { roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority']]] },
          { roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY']]] },
        ],
        nameservers: [{ ldhName: 'A.IANA-SERVERS.NET' }],
      },
    }));
    const r = (await rdapProvider.run(input('domain', 'example.com', { operation: 'domain_rdap' }), ctx(http))).records[0]!;
    expect(r.title).toMatch(/Internet Assigned Numbers Authority/);
    expect(r.description).toMatch(/redacted/i);
    expect(r.events?.map((e) => e.kind)).toEqual(['registration', 'registration']);
    expect(r.entities?.some((e) => e.ref === 'registrant')).toBe(false);
  });
  it('crt.sh: collects hostnames within the domain only', async () => {
    const http = fakeHttp(() => ({ body: [{ id: 1, issuer_name: "C=US, O=Let's Encrypt, CN=R3", common_name: 'example.com', name_value: 'example.com\n*.dev.example.com\nvpn.example.com\nevil.other.test', not_before: '2025-01-01T00:00:00', not_after: '2025-04-01T00:00:00', entry_timestamp: '2025-01-01T00:00:00' }] }));
    const r = (await crtShProvider.run(input('domain', 'example.com'), ctx(http))).records[0]!;
    const hosts = r.entities!.filter((e) => e.ref !== 'd').map((e) => e.value);
    expect(hosts.sort()).toEqual(['dev.example.com', 'vpn.example.com']);
  });
  it('Wayback: first and latest capture events', async () => {
    const http = fakeHttp((url) => ({ body: [['timestamp', 'original', 'statuscode', 'mimetype'], url.includes('limit=1&') || url.endsWith('limit=1') ? ['19980101000000', 'http://example.com/', '200', 'text/html'] : ['20260101000000', 'http://example.com/', '200', 'text/html']] }));
    const r = (await waybackProvider.run(input('domain', 'example.com'), ctx(http))).records[0]!;
    expect(r.events?.[0]?.date).toBe('1998-01-01T00:00:00.000Z');
  });
});

describe('IP providers', () => {
  it('Team Cymru: builds query names and parses origin records', async () => {
    expect(cymruQueryName('8.8.4.4')).toBe('4.4.8.8.origin.asn.cymru.com');
    expect(cymruQueryName('2001:db8::1')).toMatch(/\.8\.b\.d\.0\.1\.0\.0\.2\.origin6\.asn\.cymru\.com$/);
    expect(parseCymruOrigin('15169 | 8.8.8.0/24 | US | arin | 2023-12-28')).toEqual({ asn: '15169', prefix: '8.8.8.0/24', cc: 'US', registry: 'arin', allocated: '2023-12-28' });
    const dns = fakeDns({ resolveTxt: { '8.8.8.8.origin.asn.cymru.com': [['15169 | 8.8.8.0/24 | US | arin | 2023-12-28']], 'AS15169.asn.cymru.com': [['15169 | US | arin | 2000-03-30 | GOOGLE - Google LLC, US']] } });
    const r = (await cymruProvider.run(input('ip', '8.8.8.8'), ctx(fakeHttp(() => ({})), dns))).records[0]!;
    expect(r.title).toBe('8.8.8.8 is announced by AS15169 (GOOGLE - Google LLC, US)');
    expect(r.geo).toMatchObject({ precision: 'country', countryCode: 'US' });
    expect(r.geo?.basis).toMatch(/not a physical location/);
  });
  it('refuses public enrichment of private addresses', async () => {
    await expect(cymruProvider.run(input('ip', '10.0.0.1'), ctx(fakeHttp(() => ({}))))).rejects.toMatchObject({ category: 'not_applicable' });
  });
  it('reverse DNS distinguishes forward-confirmed PTR records', async () => {
    const dns = fakeDns({ reverse: { '8.8.8.8': ['dns.google'] }, resolve4: { 'dns.google': ['8.8.8.8'] } });
    const r = (await reverseDnsProvider.run(input('ip', '8.8.8.8'), ctx(fakeHttp(() => ({})), dns))).records[0]!;
    expect(r.relationships?.[0]?.status).toBe('confirmed');
  });
  it('InternetDB, AbuseIPDB, VirusTotal and IPinfo normalize responses', async () => {
    const idb = await internetDbProvider.run(input('ip', '8.8.8.8'), ctx(fakeHttp(() => ({ body: { ip: '8.8.8.8', ports: [53, 443], hostnames: ['dns.google'], cpes: [], tags: [], vulns: [] } }))));
    expect(idb.records[0]!.title).toMatch(/2 open port/);
    const ab = await abuseIpDbProvider.run(input('ip', '8.8.8.8'), ctx(fakeHttp(() => ({ body: { data: { abuseConfidenceScore: 0, totalReports: 3, numDistinctUsers: 2, lastReportedAt: '2026-09-01T00:00:00+00:00' } } })), undefined, { ABUSEIPDB_API_KEY: 'k' }));
    expect(ab.records[0]!.description).toMatch(/not an ATLAS probability/);
    const vt = await virusTotalProvider.run(input('domain', 'example.com', { operation: 'vt_domain' }), ctx(fakeHttp(() => ({ body: { data: { attributes: { last_analysis_stats: { malicious: 1, harmless: 60 }, reputation: 0 } } } })), undefined, { VIRUSTOTAL_API_KEY: 'k' }));
    expect(vt.records[0]!.title).toMatch(/1 malicious/);
    const ii = await ipinfoProvider.run(input('ip', '8.8.8.8'), ctx(fakeHttp(() => ({ body: { city: 'Mountain View', region: 'California', country: 'US', loc: '37.4,-122.07', anycast: true } }))));
    expect(ii.records[0]!.geo?.precision).toBe('country');
  });
});

describe('other providers', () => {
  it('Blockstream: only applies to Bitcoin addresses', async () => {
    const i = input('crypto', '0xabc');
    i.subject.metadata = { chain: 'ethereum' };
    await expect(blockstreamProvider.run(i, ctx(fakeHttp(() => ({}))))).rejects.toMatchObject({ category: 'not_applicable' });
  });
  it('Intelligence X: polls results and stores metadata only', async () => {
    const http = fakeHttp((url) => (url.endsWith('/intelligent/search') ? { body: { id: 'sid', status: 0 } } : { body: { status: 1, records: [{ systemid: 's1', name: 'paste.txt', date: '2024-01-01T00:00:00Z', added: '', bucket: 'pastes', media: 1 }] } }));
    const r = await intelxProvider.run(input('email', 'a@example.org'), ctx(http, undefined, { INTELX_API_KEY: 'k' }));
    expect(r.records[0]).toMatchObject({ claimType: 'UNVERIFIED_LEAD', category: 'darkweb' });
    expect(r.records[0]!.description).toMatch(/Content not retrieved/);
  });
  it('local analysers work offline', async () => {
    const ph = await phoneNumberingProvider.run(input('phone', '+442079460958'), ctx(fakeHttp(() => ({}))));
    expect(ph.records[0]!.title).toMatch(/fixed line number allocated to GB/);
    const cr = await cryptoFormatProvider.run(input('crypto', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'), ctx(fakeHttp(() => ({}))));
    expect(cr.records[0]!.claimType).toBe('FACT');
    const u = await urlAnalysisProvider.run(input('url', 'https://secure-login.account.example.com.evil.test/verify'), ctx(fakeHttp(() => ({}))));
    expect(u.records[0]!.claimType).toBe('INFERENCE');
    const g = await gazetteerProvider.run(input('keyword', 'Lisbon, Portugal'), ctx(fakeHttp(() => ({}))));
    expect(g.records[0]!.geo).toMatchObject({ precision: 'city', countryCode: 'PT' });
  });
});
