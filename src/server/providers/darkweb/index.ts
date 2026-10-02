/**
 * Dark-web research providers.
 *
 * Policy (enforced by design):
 *  - Only clearnet-accessible, lawful research indexes are queried. ATLAS never connects to onion services,
 *    never routes requests through Tor, and never fetches arbitrary user-supplied onion URLs.
 *  - Only result METADATA (title, snippet, date, source) is stored. No leaked file contents, credentials or
 *    purchases; no interaction with marketplaces.
 *  - All dark-web findings are UNVERIFIED LEADS with low source reliability.
 */
import * as cheerio from 'cheerio';
import type { NormalizedRecord, Provider, ProviderContext, ProviderInput } from '../types';
import { ProviderError } from '../types';
import { makeRecord, parseSourceDate, sleep, truncate } from '../util';
import type { EntityType } from '@/shared/domain';

const DW_LIMITS = [
  'Dark-web coverage is partial and volatile; absence of results is not evidence of absence.',
  'Mentions are unverified and may be fabricated, recycled or unrelated.',
];

function subjectEntityType(input: ProviderInput): EntityType {
  return input.subject.type === 'email' ? 'email' : input.subject.type === 'domain' ? 'domain' : input.subject.type === 'username' ? 'username' : 'keyword';
}

function leadRecord(provider: Provider, ctx: ProviderContext, input: ProviderInput, hit: { title: string; snippet: string; url: string | null; date?: string | null; source: string; extra?: Record<string, unknown> }): NormalizedRecord {
  const pub = parseSourceDate(hit.date ?? null);
  return makeRecord(provider, ctx, {
    sourceName: `${provider.name} → ${hit.source}`,
    sourceUrl: hit.url,
    title: truncate(hit.title, 200) ?? 'Dark-web index result',
    description: truncate(hit.snippet, 500),
    excerpt: truncate(hit.snippet, 800),
    entityType: subjectEntityType(input),
    normalizedValue: input.subject.value,
    publishedAt: pub?.iso ?? null,
    publishedPrecision: pub?.precision ?? 'unknown',
    category: 'darkweb',
    claimType: 'UNVERIFIED_LEAD',
    confidenceInputs: { sourceReliability: 'low', matchType: `${hit.title} ${hit.snippet}`.toLowerCase().includes(input.subject.display.toLowerCase()) ? 'exact' : 'partial' },
    metadata: { source: hit.source, ...hit.extra },
    fingerprintKey: `darkweb:${provider.id}:${hit.url ?? hit.title}`,
    limitations: DW_LIMITS,
    raw: hit,
  });
}

const DW_TARGETS = ['email', 'username', 'domain', 'keyword', 'organization', 'crypto'] as const;

export const ahmiaProvider: Provider = {
  id: 'ahmia',
  name: 'Ahmia (clearnet onion index)',
  category: 'darkweb',
  kind: 'live',
  reliability: 'low',
  description: 'Searches Ahmia’s clearnet index of Tor onion-service pages (which filters abuse material). Never contacts onion services.',
  homepage: 'https://ahmia.fi',
  operations: [{ id: 'ahmia_search', label: 'Onion index search', targetTypes: [...DW_TARGETS], module: 'darkweb', minDepth: 'deep' }],
  config: [{ env: 'ATLAS_ENABLE_AHMIA', label: 'Opt-in flag (ATLAS_ENABLE_AHMIA=true)' }],
  enabledByEnv: (env) => env.ATLAS_ENABLE_AHMIA === true,
  timeoutMs: 20000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 3000,
  limitations: [...DW_LIMITS, 'Parses Ahmia’s public HTML results page; if Ahmia requires interactive verification, no results are returned.'],
  async run(input, ctx) {
    const res = await ctx.http.request(`https://ahmia.fi/search/?q=${encodeURIComponent(input.subject.display)}`, { headers: { accept: 'text/html' } });
    const $ = cheerio.load(res.text);
    const items = $('li.result').toArray().slice(0, 20);
    if (!items.length) {
      return { records: [], notes: ['Ahmia returned no parseable results (no matches, or an interactive challenge was served).'] };
    }
    return {
      records: items.map((el) => {
        const r = $(el);
        const title = r.find('h4').text().trim();
        const snippet = r.find('p').first().text().trim();
        const onion = r.find('cite').text().trim();
        const date = r.find('.lastSeen').attr('data-timestamp') ?? null;
        return leadRecord(this, ctx, input, { title, snippet: `${snippet}${onion ? ` [indexed onion: ${onion}]` : ''}`, url: null, date, source: 'ahmia.fi', extra: { onionAddress: onion || null } });
      }),
    };
  },
};

export const intelxProvider: Provider = {
  id: 'intelx',
  name: 'Intelligence X',
  category: 'darkweb',
  kind: 'live',
  reliability: 'low',
  description: 'Intelligence X search API (darknet, paste and public-leak index). Only result metadata is retrieved.',
  homepage: 'https://intelx.io',
  docsUrl: 'https://github.com/IntelligenceX/SDK',
  operations: [{ id: 'intelx_search', label: 'Intelligence X search', targetTypes: [...DW_TARGETS], module: 'darkweb', minDepth: 'deep' }],
  config: [{ env: 'INTELX_API_KEY', label: 'Intelligence X API key' }, { env: 'INTELX_API_URL', label: 'API base URL', optional: true }],
  timeoutMs: 40000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 2000,
  async run(input, ctx) {
    const base = ctx.env.INTELX_API_URL.replace(/\/$/, '');
    const headers = { 'x-key': ctx.env.INTELX_API_KEY!, 'content-type': 'application/json' };
    const start = await ctx.http.request(`${base}/intelligent/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ term: input.subject.display, maxresults: 20, media: 0, sort: 2, terminate: [], timeout: 10 }),
    });
    const { id } = start.json<{ id: string; status: number }>();
    if (!id) throw new ProviderError('upstream_error', 'Intelligence X did not return a search id.');
    const out: NormalizedRecord[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await ctx.http.request(`${base}/intelligent/search/result?id=${encodeURIComponent(id)}&limit=20`, { headers });
      const data = res.json<{ status: number; records?: Array<{ systemid: string; name: string; date: string; added: string; bucket: string; bucketh?: string; media: number; mediah?: string }> }>();
      for (const r of data.records ?? []) {
        out.push(
          leadRecord(this, ctx, input, {
            title: r.name || `${r.bucketh ?? r.bucket} item`,
            snippet: `Indexed in bucket ${r.bucketh ?? r.bucket} (${r.mediah ?? `media ${r.media}`}). Content not retrieved by ATLAS.`,
            url: `https://intelx.io/?did=${encodeURIComponent(r.systemid)}`,
            date: r.date,
            source: r.bucket,
            extra: { bucket: r.bucket, systemId: r.systemid, media: r.media },
          }),
        );
      }
      if (data.status === 1 || data.status === 2 || out.length >= 20) break;
      await sleep(1500, ctx.signal);
    }
    return { records: out.slice(0, 20) };
  },
};

/** Generic adapter for an organisation's own authorised dark-web/threat-intel index exposing a simple JSON API. */
export const customDarkwebIndexProvider: Provider = {
  id: 'darkweb.custom',
  name: 'Authorised dark-web index (custom)',
  category: 'darkweb',
  kind: 'live',
  reliability: 'low',
  description:
    'Queries an organisation-operated, authorised dark-web intelligence index. Contract: GET {ATLAS_DARKWEB_INDEX_URL}?q=<term> → {"results":[{"title","snippet","url","published","source"}]}.',
  operations: [{ id: 'custom_index_search', label: 'Custom index search', targetTypes: [...DW_TARGETS], module: 'darkweb', minDepth: 'deep' }],
  config: [
    { env: 'ATLAS_DARKWEB_INDEX_URL', label: 'Index search endpoint (https)' },
    { env: 'ATLAS_DARKWEB_INDEX_TOKEN', label: 'Bearer token', optional: true },
  ],
  timeoutMs: 20000,
  maxRetries: 1,
  concurrency: 1,
  async run(input, ctx) {
    const url = ctx.env.ATLAS_DARKWEB_INDEX_URL!;
    const token = ctx.env.ATLAS_DARKWEB_INDEX_TOKEN;
    const res = await ctx.http.request(`${url}${url.includes('?') ? '&' : '?'}q=${encodeURIComponent(input.subject.display)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const data = res.json<{ results?: Array<{ title?: string; snippet?: string; url?: string | null; published?: string | null; source?: string }> }>();
    return {
      records: (data.results ?? []).slice(0, 30).map((r) =>
        leadRecord(this, ctx, input, { title: r.title ?? 'Result', snippet: r.snippet ?? '', url: r.url && /^https:\/\//.test(r.url) ? r.url : null, date: r.published ?? null, source: r.source ?? 'custom index' }),
      ),
    };
  },
};

export const DARKWEB_PROVIDERS: Provider[] = [ahmiaProvider, intelxProvider, customDarkwebIndexProvider];
