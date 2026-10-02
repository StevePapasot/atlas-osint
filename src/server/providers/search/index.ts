/**
 * Surface-web search adapters using documented, authenticated search APIs (no scraping of search engines).
 * Search results are UNVERIFIED LEADS: a page matching a query is not evidence that it concerns the target.
 */
import type { NormalizedRecord, Provider, ProviderContext, ProviderInput } from '../types';
import { makeRecord, parseSourceDate, stripTags, truncate } from '../util';
import { canonicalUrlKey, normalizeUrl } from '@/shared/targets';
import type { EntityType, TargetType } from '@/shared/domain';

const ALL_SEARCHABLE: TargetType[] = ['person', 'organization', 'username', 'email', 'domain', 'ip', 'url', 'phone', 'crypto', 'keyword', 'document'];

const SUBJECT_ENTITY: Partial<Record<TargetType, EntityType>> = {
  person: 'person', organization: 'organization', username: 'username', email: 'email', domain: 'domain', ip: 'ip',
  url: 'url', phone: 'phone', crypto: 'crypto_address', keyword: 'keyword', document: 'document', image: 'image',
};

interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  published?: string | null;
  rank: number;
  extra?: Record<string, unknown>;
}

/** Does the snippet/title literally contain the identifier? Used as a confidence input, not as verification. */
function matchType(hit: SearchHit, input: ProviderInput): 'exact' | 'partial' | 'none' {
  const hay = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
  const needle = input.subject.display.toLowerCase();
  if (hay.includes(needle) || hay.includes(input.subject.value.toLowerCase())) return 'exact';
  const tokens = needle.split(/[\s@._-]+/).filter((t) => t.length > 2);
  return tokens.length && tokens.every((t) => hay.includes(t)) ? 'partial' : 'none';
}

export function hitsToRecords(provider: Provider, ctx: ProviderContext, input: ProviderInput, hits: SearchHit[]): NormalizedRecord[] {
  const entityType = SUBJECT_ENTITY[input.subject.type] ?? 'keyword';
  const purpose = String(input.params.purpose ?? 'exact');
  return hits
    .map((hit) => {
      const norm = normalizeUrl(hit.url);
      if (!norm) return null;
      const pub = parseSourceDate(hit.published);
      const mt = matchType(hit, input);
      const isDoc = /\.(pdf|docx?|xlsx?|pptx?|csv|txt)(\?|$)/i.test(norm.url) || purpose === 'documents';
      return makeRecord(provider, ctx, {
        sourceName: `${provider.name} → ${norm.host}`,
        sourceUrl: norm.url,
        title: truncate(stripTags(hit.title), 200) ?? norm.url,
        description: truncate(stripTags(hit.snippet), 500),
        excerpt: truncate(stripTags(hit.snippet), 800),
        entityType,
        normalizedValue: input.subject.value,
        publishedAt: pub?.iso ?? null,
        publishedPrecision: pub?.precision ?? 'unknown',
        category: isDoc ? 'document' : 'web_mention',
        claimType: 'UNVERIFIED_LEAD',
        confidenceInputs: { sourceReliability: 'unknown', matchType: mt, signals: mt === 'exact' ? ['identifier_in_snippet'] : [] },
        entities: [
          { ref: 'subject', type: entityType, value: input.subject.value, display: input.subject.display },
          { ref: 'page', type: isDoc ? 'document' : 'url', value: norm.url, display: truncate(stripTags(hit.title), 120) ?? norm.url },
          { ref: 'site', type: 'domain', value: norm.host.replace(/^www\./, '') },
        ],
        subjectRef: 'subject',
        relationships: [
          { from: 'page', to: 'subject', type: 'MENTIONS', status: mt === 'exact' ? 'possible' : 'possible', rationale: `Returned for query ${String(input.params.query)}${mt === 'exact' ? '; identifier appears in snippet' : ''}.` },
          { from: 'page', to: 'site', type: 'HOSTED_ON', status: 'confirmed', rationale: 'URL host.' },
        ],
        events: pub ? [{ date: pub.iso, precision: pub.precision, kind: 'source_published', label: `Published: ${truncate(stripTags(hit.title), 90)}` }] : [],
        metadata: { query: input.params.query, purpose, rank: hit.rank, host: norm.host, ...hit.extra },
        fingerprintKey: `web:${canonicalUrlKey(norm.url)}|${input.subject.value}`,
        limitations: ['Search engines return pages matching text; relevance to the target must be verified by an analyst.'],
        raw: hit,
      });
    })
    .filter((r): r is NormalizedRecord => r !== null);
}

const searchOp = { id: 'web_search', label: 'Planned web search', targetTypes: ALL_SEARCHABLE, module: 'web_search' as const, minDepth: 'quick' as const };

export const braveSearchProvider: Provider = {
  id: 'brave',
  name: 'Brave Search API',
  category: 'search',
  kind: 'live',
  reliability: 'unknown',
  description: 'Independent web index via the Brave Search API (web results endpoint).',
  homepage: 'https://brave.com/search/api/',
  docsUrl: 'https://api-dashboard.search.brave.com/app/documentation/web-search/get-started',
  operations: [searchOp],
  config: [{ env: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search subscription token' }],
  timeoutMs: 15000,
  maxRetries: 2,
  concurrency: 1,
  minIntervalMs: 1100, // free plan: 1 request/second
  async run(input, ctx) {
    const query = String(input.params.query ?? input.subject.display);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&safesearch=moderate&text_decorations=false`;
    const res = await ctx.http.request(url, { headers: { 'X-Subscription-Token': ctx.env.BRAVE_SEARCH_API_KEY!, accept: 'application/json' } });
    const data = res.json<{ web?: { results?: Array<{ url: string; title: string; description?: string; page_age?: string; age?: string; extra_snippets?: string[] }> } }>();
    const hits: SearchHit[] = (data.web?.results ?? []).map((r, i) => ({
      url: r.url,
      title: r.title,
      snippet: [r.description, ...(r.extra_snippets ?? []).slice(0, 2)].filter(Boolean).join(' … '),
      published: r.page_age ?? null,
      rank: i + 1,
    }));
    return { records: hitsToRecords(this, ctx, input, hits) };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    await ctx.http.request('https://api.search.brave.com/res/v1/web/search?q=iana&count=1', { headers: { 'X-Subscription-Token': ctx.env.BRAVE_SEARCH_API_KEY! } });
    return { status: 'healthy', message: 'Brave Search API accepted the key.', latencyMs: Date.now() - t };
  },
};

export const serpApiProvider: Provider = {
  id: 'serpapi',
  name: 'SerpApi (Google results)',
  category: 'search',
  kind: 'live',
  reliability: 'unknown',
  description: 'Google web results via SerpApi; also supports Google Lens reverse-image search for image URLs.',
  homepage: 'https://serpapi.com',
  docsUrl: 'https://serpapi.com/search-api',
  operations: [
    searchOp,
    { id: 'reverse_image', label: 'Reverse image search (Google Lens)', targetTypes: ['image'], module: 'images', minDepth: 'standard' },
  ],
  config: [{ env: 'SERPAPI_API_KEY', label: 'SerpApi API key' }],
  timeoutMs: 25000,
  maxRetries: 1,
  concurrency: 2,
  limitations: ['Reverse-image search requires the image to be reachable at a public URL; uploaded files are never published.'],
  async run(input, ctx) {
    const key = ctx.env.SERPAPI_API_KEY!;
    if (input.operation === 'reverse_image') {
      const res = await ctx.http.request(`https://serpapi.com/search.json?engine=google_lens&url=${encodeURIComponent(input.subject.value)}&api_key=${encodeURIComponent(key)}`);
      const data = res.json<{ visual_matches?: Array<{ position: number; title: string; link: string; source?: string }> }>();
      const hits: SearchHit[] = (data.visual_matches ?? []).slice(0, 15).map((m) => ({ url: m.link, title: m.title, snippet: `Visually similar image on ${m.source ?? 'unknown source'}.`, rank: m.position }));
      return {
        records: hitsToRecords(this, ctx, { ...input, params: { ...input.params, query: 'Google Lens visual match', purpose: 'exact' } }, hits).map((r) => ({
          ...r,
          category: 'image' as const,
          title: `Visually similar image: ${r.title}`,
          limitations: ['Visual similarity does not establish that images depict the same person, place or event.'],
        })),
      };
    }
    const query = String(input.params.query ?? input.subject.display);
    const res = await ctx.http.request(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=10&api_key=${encodeURIComponent(key)}`);
    const data = res.json<{ organic_results?: Array<{ position: number; title: string; link: string; snippet?: string; date?: string }> }>();
    const hits: SearchHit[] = (data.organic_results ?? []).map((r) => ({ url: r.link, title: r.title, snippet: r.snippet ?? '', published: r.date ?? null, rank: r.position }));
    return { records: hitsToRecords(this, ctx, input, hits) };
  },
};

export const parallelSearchProvider: Provider = {
  id: 'parallel',
  name: 'Parallel Search API',
  category: 'search',
  kind: 'live',
  reliability: 'unknown',
  description: 'Parallel Web Systems search API returning ranked results with source excerpts.',
  homepage: 'https://parallel.ai',
  docsUrl: 'https://docs.parallel.ai/search/search-quickstart',
  operations: [searchOp],
  config: [{ env: 'PARALLEL_API_KEY', label: 'Parallel API key' }],
  timeoutMs: 30000,
  maxRetries: 1,
  concurrency: 2,
  async run(input, ctx) {
    const query = String(input.params.query ?? input.subject.display);
    const objective = `Find public web pages that reference ${input.subject.display} (${input.subject.type}). Return pages that literally contain the identifier.`;
    const res = await ctx.http.request('https://api.parallel.ai/v1beta/search', {
      method: 'POST',
      headers: { 'x-api-key': ctx.env.PARALLEL_API_KEY!, 'content-type': 'application/json', 'parallel-beta': 'search-extract-2025-10-10' },
      body: JSON.stringify({ objective, search_queries: [query.slice(0, 200)], max_results: 10, excerpts: { max_chars_per_result: 1200 } }),
    });
    const data = res.json<{ results?: Array<{ url: string; title?: string; publish_date?: string | null; excerpts?: string[] }> }>();
    const hits: SearchHit[] = (data.results ?? []).map((r, i) => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: (r.excerpts ?? []).join(' … '),
      published: r.publish_date ?? null,
      rank: i + 1,
    }));
    return { records: hitsToRecords(this, ctx, input, hits) };
  },
};

export const SEARCH_PROVIDERS: Provider[] = [braveSearchProvider, serpApiProvider, parallelSearchProvider];
