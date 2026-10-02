/**
 * Historical/passive sources:
 *  - crt.sh Certificate Transparency search (historical certificates and hostnames)
 *  - Internet Archive Wayback Machine CDX API (first/last capture dates)
 */
import type { NormalizedRecord, Provider } from '../types';
import { makeRecord, parseSourceDate } from '../util';
import { normalizeDomain } from '@/shared/targets';

interface CrtShEntry {
  id: number;
  issuer_name: string;
  common_name: string;
  name_value: string;
  not_before: string;
  not_after: string;
  entry_timestamp: string;
}

export const crtShProvider: Provider = {
  id: 'crtsh',
  name: 'crt.sh Certificate Transparency',
  category: 'domain',
  kind: 'live',
  reliability: 'authoritative',
  description: 'Historical TLS certificates from public CT logs; reveals hostnames (subdomains) and issuance dates.',
  homepage: 'https://crt.sh',
  operations: [{ id: 'ct_search', label: 'Certificate Transparency search', targetTypes: ['domain'], module: 'domain', minDepth: 'standard' }],
  config: [],
  timeoutMs: 30000,
  maxRetries: 2,
  concurrency: 1,
  minIntervalMs: 2000,
  limitations: [
    'Certificates are historical observations; listed hostnames may no longer exist.',
    'crt.sh is a free community service and frequently rate-limits or times out.',
  ],
  async run(input, ctx) {
    const domain = input.subject.value;
    const url = `https://crt.sh/?q=${encodeURIComponent('%.' + domain)}&output=json&exclude=expired&deduplicate=Y`;
    const res = await ctx.http.request(url, { maxBytes: 12 * 1024 * 1024, timeoutMs: 30000 });
    const entries = res.text.trim() ? res.json<CrtShEntry[]>() : [];
    const hostnames = new Map<string, { first: string; last: string; count: number }>();
    for (const e of entries) {
      for (const raw of e.name_value.split('\n')) {
        const h = normalizeDomain(raw.replace(/^\*\./, ''));
        if (!h || (h !== domain && !h.endsWith(`.${domain}`))) continue;
        const cur = hostnames.get(h);
        if (!cur) hostnames.set(h, { first: e.not_before, last: e.not_before, count: 1 });
        else {
          cur.count++;
          if (e.not_before < cur.first) cur.first = e.not_before;
          if (e.not_before > cur.last) cur.last = e.not_before;
        }
      }
    }
    const subs = [...hostnames.entries()].filter(([h]) => h !== domain).sort((a, b) => b[1].count - a[1].count).slice(0, 150);
    const issuers = [...new Set(entries.map((e) => (e.issuer_name.match(/O=([^,]+)/)?.[1] ?? e.issuer_name).trim()))].slice(0, 10);
    const earliest = entries.reduce<string | null>((m, e) => (!m || e.not_before < m ? e.not_before : m), null);
    const records: NormalizedRecord[] = [
      makeRecord(this, ctx, {
        sourceUrl: `https://crt.sh/?q=${encodeURIComponent('%.' + domain)}`,
        title: `${entries.length} unexpired certificate(s) for ${domain}; ${subs.length} hostname(s) observed`,
        description: `Issuers: ${issuers.join(', ') || '—'}. Hostnames come from certificate SANs and may be historical.`,
        excerpt: subs.slice(0, 25).map(([h]) => h).join(', ') || '(no additional hostnames)',
        entityType: 'domain',
        normalizedValue: domain,
        category: 'certificate',
        claimType: 'FACT',
        entities: [
          { ref: 'd', type: 'domain', value: domain },
          ...subs.slice(0, 60).map(([h, v], i) => ({ ref: `h${i}`, type: 'domain' as const, value: h, attributes: { ctFirstSeen: v.first, ctLastSeen: v.last, certificates: v.count } })),
        ],
        subjectRef: 'd',
        relationships: subs.slice(0, 60).map((_, i) => ({ from: 'd', to: `h${i}`, type: 'LINKED_TO' as const, status: 'confirmed' as const, rationale: 'Hostname appears in a certificate for the domain (CT log).' })),
        events: earliest ? [{ date: parseSourceDate(earliest)?.iso ?? earliest, precision: 'exact' as const, kind: 'event' as const, label: `Earliest unexpired certificate for ${domain} issued`, entityRef: 'd' }] : [],
        metadata: { certificateCount: entries.length, hostnames: subs.map(([h, v]) => ({ hostname: h, ...v })), issuers, historical: true },
        fingerprintKey: `ct:${domain}`,
        limitations: ['Historical certificate data; hostnames are leads, not confirmation of current infrastructure.'],
        raw: entries.slice(0, 200),
      }),
    ];
    return { records };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    await ctx.http.request('https://crt.sh/?q=iana.org&output=json&limit=1', { timeoutMs: 20000 });
    return { status: 'healthy', message: 'crt.sh responded.', latencyMs: Date.now() - t };
  },
};

export const waybackProvider: Provider = {
  id: 'wayback',
  name: 'Internet Archive Wayback Machine',
  category: 'domain',
  kind: 'live',
  reliability: 'reputable',
  description: 'First and most recent archived captures of a domain or URL (CDX API).',
  homepage: 'https://web.archive.org',
  docsUrl: 'https://archive.org/developers/wayback-cdx-server.html',
  operations: [
    { id: 'archive_history', label: 'Archive capture history', targetTypes: ['domain', 'url'], module: 'domain', minDepth: 'standard' },
  ],
  config: [],
  timeoutMs: 25000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 1000,
  async run(input, ctx) {
    const target = input.subject.value;
    const q = (limit: number) =>
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(target)}&output=json&fl=timestamp,original,statuscode,mimetype&limit=${limit}`;
    const [first, last] = await Promise.all([ctx.http.request(q(1)), ctx.http.request(q(-1))]);
    const parse = (text: string) => {
      const rows = text.trim() ? (JSON.parse(text) as string[][]) : [];
      return rows.length > 1 ? rows[1]! : null;
    };
    const f = parse(first.text);
    const l = parse(last.text);
    const toIso = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}.000Z`;
    const isUrl = input.subject.type === 'url';
    if (!f) {
      return {
        records: [
          makeRecord(this, ctx, {
            sourceUrl: `https://web.archive.org/web/*/${target}`,
            title: `No Wayback Machine captures found for ${target}`,
            entityType: isUrl ? 'url' : 'domain',
            normalizedValue: target,
            category: 'web_mention',
            claimType: 'SOURCE_CLAIM',
            fingerprintKey: `wayback:${target}`,
          }),
        ],
      };
    }
    const events = [
      { date: toIso(f[0]!), precision: 'exact' as const, kind: 'event' as const, label: `First archived capture of ${target}` },
      ...(l ? [{ date: toIso(l[0]!), precision: 'exact' as const, kind: 'event' as const, label: `Most recent archived capture of ${target}` }] : []),
    ];
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://web.archive.org/web/${f[0]}/${f[1]}`,
          title: `${target} archived since ${toIso(f[0]!).slice(0, 10)}`,
          description: `First capture ${toIso(f[0]!).slice(0, 10)}${l ? `, latest ${toIso(l[0]!).slice(0, 10)}` : ''}. Archive captures show what was publicly served at those times.`,
          excerpt: `first=${f.join(' ')}\nlast=${l?.join(' ') ?? '—'}`,
          entityType: isUrl ? 'url' : 'domain',
          normalizedValue: target,
          category: 'web_mention',
          claimType: 'FACT',
          events,
          metadata: { first: f, last: l, historical: true },
          fingerprintKey: `wayback:${target}`,
          raw: { first: f, last: l },
        }),
      ],
    };
  },
};
