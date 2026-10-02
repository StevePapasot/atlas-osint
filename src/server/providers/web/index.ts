import * as cheerio from 'cheerio';
import type { Provider, NormalizedRecord, RecordEntity, RecordRelationship } from '../types';
import { ProviderError } from '../types';
import { makeRecord, truncate } from '../util';
import { normalizeUrl, normalizeDomain, parseProfileUrl } from '@/shared/targets';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_LINKED_DOMAINS = 25;
const MAX_EMAILS = 15;
const MAX_PROFILES = 15;
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,190}\.[A-Z]{2,24}/gi;

/** Parse fetched HTML into plain facts. The page is untrusted data: nothing in it is executed or followed. */
export function parsePage(html: string, finalUrl: string) {
  const $ = cheerio.load(html);
  $('script, style, noscript, template, iframe, object, embed').remove();
  const meta = (sel: string) => $(sel).attr('content')?.trim() || null;
  const base = new URL(finalUrl);
  const links: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
    try {
      links.push(new URL(href, base).toString());
    } catch {
      /* ignore malformed hrefs */
    }
  });
  const mailto = links.filter((l) => l.toLowerCase().startsWith('mailto:')).map((l) => decodeURIComponent(l.slice(7).split('?')[0] ?? ''));
  const text = $('body').text().replace(/\s+/g, ' ').slice(0, 200_000);
  const emails = [...new Set([...mailto, ...(text.match(EMAIL_RE) ?? [])].map((e) => e.toLowerCase()))].filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e)).slice(0, MAX_EMAILS);
  const httpLinks = links.filter((l) => /^https?:/i.test(l));
  const ownHost = base.hostname.replace(/^www\./, '');
  const linkedDomains = [
    ...new Set(
      httpLinks
        .map((l) => normalizeDomain(new URL(l).hostname.replace(/^www\./, '')))
        .filter((d): d is string => Boolean(d) && d !== ownHost && !d!.endsWith(`.${ownHost}`)),
    ),
  ].slice(0, MAX_LINKED_DOMAINS);
  const profiles = [
    ...new Map(
      httpLinks
        .map((l) => ({ url: l, profile: parseProfileUrl(l) }))
        .filter((x) => x.profile)
        .map((x) => [`${x.profile!.platform}:${x.profile!.username.toLowerCase()}`, x] as const),
    ).values(),
  ].slice(0, MAX_PROFILES);
  return {
    title: truncate($('title').first().text(), 300),
    description: truncate(meta('meta[name="description"]') ?? meta('meta[property="og:description"]'), 500),
    siteName: meta('meta[property="og:site_name"]'),
    generator: meta('meta[name="generator"]'),
    canonical: $('link[rel="canonical"]').attr('href') ?? null,
    language: $('html').attr('lang')?.slice(0, 20) ?? null,
    emails,
    linkedDomains,
    profiles,
    textPreview: truncate(text, 2000),
  };
}

/**
 * Opt-in retrieval of a user-supplied URL target (ATLAS_ALLOW_TARGET_FETCH=true). One GET of the page itself —
 * no crawling, no form submission, no script execution — through the SSRF-guarded client in untrusted mode: public
 * addresses only, every redirect re-validated, size and time limited.
 */
export const urlFetchProvider: Provider = {
  id: 'url.fetch',
  name: 'Target page retrieval (opt-in)',
  category: 'domain',
  kind: 'live',
  reliability: 'unknown',
  description: 'Fetches a URL target once and extracts title, metadata, contact addresses, linked domains and profile links.',
  operations: [{ id: 'fetch_page', label: 'Fetch target page', targetTypes: ['url'], module: 'domain', minDepth: 'standard' }],
  config: [],
  enabledByEnv: (env) => env.ATLAS_ALLOW_TARGET_FETCH === true,
  timeoutMs: 20_000,
  maxRetries: 1,
  concurrency: 2,
  minIntervalMs: 500,
  limitations: [
    'Disabled unless ATLAS_ALLOW_TARGET_FETCH=true: fetching notifies the site operator that the URL was visited (your server address appears in their logs).',
    'Only the page itself is retrieved — no crawling, JavaScript rendering or form submission. Content is attacker-controlled and treated as untrusted.',
  ],
  async run(input, ctx) {
    const n = normalizeUrl(input.subject.value);
    if (!n) throw new ProviderError('invalid_input', 'Not a fetchable http(s) URL.');
    const res = await ctx.http.request(n.url, {
      untrustedUrl: true,
      maxBytes: MAX_PAGE_BYTES,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5' },
      allowStatus: [404, 410],
    });
    const finalUrl = res.url;
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    const records: NormalizedRecord[] = [];
    const urlRef: RecordEntity = { ref: 'u', type: 'url', value: input.subject.value };
    const finalHost = new URL(finalUrl).hostname;
    if (res.status === 404 || res.status === 410) {
      records.push(
        makeRecord(this, ctx, {
          sourceUrl: finalUrl,
          title: `URL returned HTTP ${res.status} (not found / gone)`,
          entityType: 'url',
          normalizedValue: input.subject.value,
          category: 'web_mention',
          claimType: 'FACT',
          confidenceInputs: { sourceReliability: 'authoritative', matchType: 'exact' },
          entities: [urlRef],
          subjectRef: 'u',
          metadata: { status: res.status, finalUrl },
          fingerprintKey: `url-fetch:${n.url}:status`,
        }),
      );
      return { records };
    }
    if (!/html|xml|text\/plain/.test(contentType)) {
      return {
        records: [
          makeRecord(this, ctx, {
            sourceUrl: finalUrl,
            title: `URL serves ${contentType.split(';')[0] || 'unknown content'} (not parsed)`,
            entityType: 'url',
            normalizedValue: input.subject.value,
            category: 'web_mention',
            claimType: 'FACT',
            confidenceInputs: { sourceReliability: 'authoritative', matchType: 'exact' },
            entities: [urlRef, { ref: 'h', type: 'domain', value: finalHost }],
            subjectRef: 'u',
            relationships: [{ from: 'u', to: 'h', type: 'HOSTED_ON', status: 'confirmed', rationale: 'Final URL host after redirects.' }],
            metadata: { status: res.status, finalUrl, contentType },
            fingerprintKey: `url-fetch:${n.url}:type`,
          }),
        ],
      };
    }
    const page = parsePage(res.text, finalUrl);
    const redirected = finalUrl.replace(/\/$/, '') !== n.url.replace(/\/$/, '');
    const entities: RecordEntity[] = [urlRef, { ref: 'h', type: 'domain', value: finalHost }];
    const relationships: RecordRelationship[] = [{ from: 'u', to: 'h', type: 'HOSTED_ON', status: 'confirmed', rationale: redirected ? 'Host of the final URL after redirects.' : 'URL host component.' }];
    records.push(
      makeRecord(this, ctx, {
        sourceUrl: finalUrl,
        sourceName: finalHost,
        title: page.title ? `Page title: “${page.title}”` : `Page retrieved from ${finalHost} (no title)`,
        description: [page.description, redirected ? `Redirected to ${finalUrl}.` : null].filter(Boolean).join(' ') || null,
        excerpt: page.textPreview,
        entityType: 'url',
        normalizedValue: input.subject.value,
        category: 'web_mention',
        claimType: 'SOURCE_CLAIM',
        entities,
        subjectRef: 'u',
        relationships,
        metadata: { status: res.status, finalUrl, redirected, contentType, siteName: page.siteName, generator: page.generator, canonical: page.canonical, language: page.language },
        raw: { status: res.status, finalUrl, title: page.title, description: page.description, generator: page.generator, linkedDomains: page.linkedDomains },
        limitations: ['Page content is published by the site operator and may be inaccurate or deliberately misleading.'],
        fingerprintKey: `url-fetch:${n.url}:page`,
      }),
    );
    for (const email of page.emails) {
      records.push(
        makeRecord(this, ctx, {
          sourceUrl: finalUrl,
          sourceName: finalHost,
          title: `Email address published on ${finalHost}: ${email}`,
          entityType: 'email',
          normalizedValue: email,
          category: 'web_mention',
          claimType: 'SOURCE_CLAIM',
          confidenceInputs: { sourceReliability: 'unknown', matchType: 'exact', signals: ['published_on_target_page'] },
          entities: [urlRef, { ref: 'e', type: 'email', value: email }],
          subjectRef: 'e',
          relationships: [{ from: 'u', to: 'e', type: 'MENTIONS', status: 'confirmed', rationale: 'Address appears in the retrieved page.' }],
          fingerprintKey: `url-fetch:${n.url}:email:${email}`,
        }),
      );
    }
    for (const p of page.profiles) {
      records.push(
        makeRecord(this, ctx, {
          sourceUrl: finalUrl,
          sourceName: finalHost,
          title: `Page links to ${p.profile!.platform} profile “${p.profile!.username}”`,
          description: 'A link is a claim by the page author; it does not establish that the same person controls both.',
          entityType: 'username',
          normalizedValue: p.profile!.username.toLowerCase(),
          category: 'profile',
          claimType: 'UNVERIFIED_LEAD',
          confidenceInputs: { sourceReliability: 'unknown', matchType: 'partial', signals: ['linked_from_target_page'] },
          entities: [urlRef, { ref: 'p', type: 'username', value: p.profile!.username.toLowerCase(), display: `${p.profile!.platform}: ${p.profile!.username}` }],
          subjectRef: 'p',
          relationships: [{ from: 'u', to: 'p', type: 'LINKED_TO', status: 'possible', rationale: `Hyperlink to ${p.url}` }],
          metadata: { platform: p.profile!.platform, profileUrl: p.url },
          fingerprintKey: `url-fetch:${n.url}:profile:${p.profile!.platform}:${p.profile!.username.toLowerCase()}`,
        }),
      );
    }
    if (page.linkedDomains.length) {
      records.push(
        makeRecord(this, ctx, {
          sourceUrl: finalUrl,
          sourceName: finalHost,
          title: `Page links to ${page.linkedDomains.length} external domain(s)`,
          description: page.linkedDomains.join(', '),
          entityType: 'url',
          normalizedValue: input.subject.value,
          category: 'web_mention',
          claimType: 'FACT',
          confidenceInputs: { sourceReliability: 'authoritative', matchType: 'exact' },
          entities: [urlRef, ...page.linkedDomains.map((d, i) => ({ ref: `d${i}`, type: 'domain' as const, value: d }))],
          subjectRef: 'u',
          relationships: page.linkedDomains.map((_, i) => ({ from: 'u', to: `d${i}`, type: 'LINKED_TO' as const, status: 'confirmed' as const, rationale: 'Outbound hyperlink on the retrieved page.' })),
          metadata: { linkedDomains: page.linkedDomains },
          fingerprintKey: `url-fetch:${n.url}:links`,
        }),
      );
    }
    return { records, notes: [`Retrieved ${Math.round(res.text.length / 1024)} KB (HTTP ${res.status})${redirected ? ` after redirect to ${finalUrl}` : ''}.`] };
  },
};

export const WEB_PROVIDERS: Provider[] = [urlFetchProvider];
