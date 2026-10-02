/**
 * IP intelligence providers.
 * Geographic information from IP data is always APPROXIMATE and describes network registration or database
 * estimates — never the physical location of a person or device.
 */
import ipaddr from 'ipaddr.js';
import type { NormalizedRecord, Provider } from '../types';
import { ProviderError } from '../types';
import { makeRecord, parseSourceDate } from '../util';
import { countryInfo } from '../../geo/gazetteer';
import { isPublicIp } from '@/shared/targets';

const APPROX = 'IP geolocation is approximate and reflects network data, not the physical location of a person or device.';

function requirePublic(ip: string): void {
  if (!isPublicIp(ip)) {
    throw new ProviderError('not_applicable', 'Private, loopback or reserved address — public enrichment does not apply.');
  }
}

/** Reverse-nibble/octet names used by Team Cymru's DNS service. */
export function cymruQueryName(ip: string): string {
  const addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv4') return `${(addr as ipaddr.IPv4).octets.slice().reverse().join('.')}.origin.asn.cymru.com`;
  const hex = (addr as ipaddr.IPv6).toNormalizedString()
    .split(':')
    .map((p) => p.padStart(4, '0'))
    .join('');
  return `${hex.split('').reverse().join('.')}.origin6.asn.cymru.com`;
}

export function parseCymruOrigin(txt: string): { asn: string; prefix: string; cc: string; registry: string; allocated: string } | null {
  const parts = txt.split('|').map((s) => s.trim());
  if (parts.length < 5 || !parts[0]) return null;
  return { asn: parts[0].split(' ')[0]!, prefix: parts[1]!, cc: parts[2]!, registry: parts[3]!, allocated: parts[4]! };
}

export const cymruProvider: Provider = {
  id: 'cymru',
  name: 'Team Cymru IP-to-ASN (DNS)',
  category: 'ip',
  kind: 'live',
  reliability: 'authoritative',
  description: 'BGP origin ASN, announced prefix, RIR and AS name via Team Cymru’s public DNS service.',
  homepage: 'https://www.team-cymru.com/ip-asn-mapping',
  operations: [{ id: 'asn_lookup', label: 'ASN & prefix', targetTypes: ['ip'], module: 'ip', minDepth: 'quick' }],
  config: [],
  timeoutMs: 10000,
  maxRetries: 2,
  concurrency: 4,
  limitations: ['Country code is the RIR registration country of the prefix, not a geolocation.'],
  async run(input, ctx) {
    const ip = input.subject.value;
    requirePublic(ip);
    const origin = (await ctx.dns.resolveTxt(cymruQueryName(ip))).map((p) => p.join('')).map(parseCymruOrigin).filter((x) => x !== null);
    if (!origin.length) {
      return {
        records: [
          makeRecord(this, ctx, {
            sourceUrl: null,
            title: `${ip} is not announced in global BGP (per Team Cymru)`,
            description: 'No origin ASN found. The address may be unrouted or newly allocated.',
            entityType: 'ip',
            normalizedValue: ip,
            category: 'network',
            claimType: 'SOURCE_CLAIM',
            fingerprintKey: `asn:${ip}`,
          }),
        ],
      };
    }
    const o = origin[0]!;
    const asName = (await ctx.dns.resolveTxt(`AS${o.asn}.asn.cymru.com`).catch(() => [] as string[][]))
      .map((p) => p.join(''))
      .map((t) => t.split('|').map((s) => s.trim())[4] ?? null)
      .find(Boolean) ?? null;
    const country = countryInfo(o.cc);
    const records: NormalizedRecord[] = [
      makeRecord(this, ctx, {
        sourceName: 'Team Cymru (DNS)',
        sourceUrl: null,
        title: `${ip} is announced by AS${o.asn}${asName ? ` (${asName})` : ''}`,
        description: `Prefix ${o.prefix}; registry ${o.registry.toUpperCase()}; allocated ${o.allocated}; registration country ${o.cc}.`,
        excerpt: `${o.asn} | ${o.prefix} | ${o.cc} | ${o.registry} | ${o.allocated}${asName ? `\nAS${o.asn} | ${asName}` : ''}`,
        entityType: 'ip',
        normalizedValue: ip,
        category: 'network',
        claimType: 'FACT',
        entities: [
          { ref: 'ip', type: 'ip', value: ip },
          { ref: 'asn', type: 'asn', value: `as${o.asn}`, display: `AS${o.asn}${asName ? ` ${asName}` : ''}`, attributes: { name: asName, registry: o.registry } },
          ...(asName ? [{ ref: 'org', type: 'organization' as const, value: asName.replace(/^[A-Z0-9-]+ - /, '').toLowerCase(), display: asName.replace(/^[A-Z0-9-]+ - /, '') }] : []),
        ],
        subjectRef: 'ip',
        relationships: [
          { from: 'ip', to: 'asn', type: 'HOSTED_ON', status: 'confirmed', rationale: `BGP origin AS${o.asn} for ${o.prefix}.` },
          ...(asName ? [{ from: 'asn', to: 'org', type: 'ASSOCIATED_WITH' as const, status: 'confirmed' as const, rationale: 'AS name registration.' }] : []),
        ],
        geo: country
          ? { lat: country.lat, lon: country.lon, precision: 'country', place: country.name, countryCode: country.cc, basis: 'RIR registration country of the announcing prefix (administrative, not a physical location).' }
          : null,
        assertions: [{ subjectRef: 'ip', attribute: 'registration_country', value: o.cc }],
        metadata: { asn: Number(o.asn), prefix: o.prefix, registry: o.registry, allocated: o.allocated, asName, allOrigins: origin },
        fingerprintKey: `asn:${ip}`,
        limitations: [APPROX],
        raw: { origin, asName },
      }),
    ];
    return { records };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    const r = await ctx.dns.resolveTxt(cymruQueryName('8.8.8.8'));
    return r.length
      ? { status: 'healthy', message: 'Cymru origin lookup succeeded.', latencyMs: Date.now() - t }
      : { status: 'degraded', message: 'No data returned.', latencyMs: Date.now() - t };
  },
};

export const reverseDnsProvider: Provider = {
  id: 'dns.ptr',
  name: 'Reverse DNS (PTR)',
  category: 'ip',
  kind: 'live',
  reliability: 'authoritative',
  description: 'PTR lookup with forward-confirmation (FCrDNS).',
  operations: [{ id: 'ptr', label: 'Reverse DNS', targetTypes: ['ip'], module: 'ip', minDepth: 'quick' }],
  config: [],
  timeoutMs: 10000,
  maxRetries: 1,
  concurrency: 6,
  async run(input, ctx) {
    const ip = input.subject.value;
    requirePublic(ip);
    const names = (await ctx.dns.reverse(ip)).map((n) => n.toLowerCase().replace(/\.$/, ''));
    if (!names.length) {
      return {
        records: [
          makeRecord(this, ctx, {
            sourceName: 'DNS (live resolver)',
            sourceUrl: null,
            title: `${ip} has no reverse DNS (PTR) record`,
            entityType: 'ip',
            normalizedValue: ip,
            category: 'dns',
            claimType: 'FACT',
            fingerprintKey: `ptr:${ip}`,
          }),
        ],
      };
    }
    const confirmed: Record<string, boolean> = {};
    for (const n of names.slice(0, 5)) {
      const fwd = ip.includes(':') ? await ctx.dns.resolve6(n).catch(() => []) : await ctx.dns.resolve4(n).catch(() => []);
      confirmed[n] = fwd.map((x) => ipaddr.parse(x).toString()).includes(ipaddr.parse(ip).toString());
    }
    return {
      records: [
        makeRecord(this, ctx, {
          sourceName: 'DNS (live resolver)',
          sourceUrl: null,
          title: `${ip} reverse DNS: ${names.join(', ')}`,
          description: Object.values(confirmed).some(Boolean)
            ? 'Forward-confirmed: the PTR name resolves back to this address.'
            : 'Not forward-confirmed: PTR names can be set arbitrarily by the address holder.',
          excerpt: names.map((n) => `${ip} PTR ${n} (forward-confirmed: ${confirmed[n] ? 'yes' : 'no'})`).join('\n'),
          entityType: 'ip',
          normalizedValue: ip,
          category: 'dns',
          claimType: 'FACT',
          entities: [{ ref: 'ip', type: 'ip', value: ip }, ...names.map((n, i) => ({ ref: `h${i}`, type: 'domain' as const, value: n }))],
          subjectRef: 'ip',
          relationships: names.map((n, i) => ({
            from: `h${i}`,
            to: 'ip',
            type: 'RESOLVES_TO' as const,
            status: confirmed[n] ? ('confirmed' as const) : ('possible' as const),
            rationale: confirmed[n] ? 'PTR record, forward-confirmed.' : 'PTR record only (not forward-confirmed).',
          })),
          metadata: { ptr: names, forwardConfirmed: confirmed },
          fingerprintKey: `ptr:${ip}`,
          raw: { ptr: names, confirmed },
        }),
      ],
    };
  },
};

interface InternetDbResponse {
  ip: string;
  ports: number[];
  hostnames: string[];
  cpes: string[];
  tags: string[];
  vulns: string[];
}

export const internetDbProvider: Provider = {
  id: 'shodan.internetdb',
  name: 'Shodan InternetDB',
  category: 'ip',
  kind: 'live',
  reliability: 'reputable',
  description: 'Free, keyless summary of open ports, hostnames, CPEs, tags and known CVEs observed by Shodan scanners.',
  homepage: 'https://internetdb.shodan.io',
  operations: [{ id: 'internetdb', label: 'Exposed services summary', targetTypes: ['ip'], module: 'ip', minDepth: 'standard' }],
  config: [],
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 2,
  minIntervalMs: 1000,
  limitations: ['Data reflects Shodan’s most recent scans and may be weeks old. Vulnerabilities are version-inferred, not exploited or confirmed.'],
  async run(input, ctx) {
    const ip = input.subject.value;
    requirePublic(ip);
    const res = await ctx.http.request(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, { allowStatus: [404] });
    if (res.status === 404) {
      return {
        records: [
          makeRecord(this, ctx, {
            sourceUrl: `https://internetdb.shodan.io/${ip}`,
            title: `No Shodan InternetDB data for ${ip}`,
            entityType: 'ip',
            normalizedValue: ip,
            category: 'network',
            claimType: 'SOURCE_CLAIM',
            fingerprintKey: `internetdb:${ip}`,
          }),
        ],
      };
    }
    const d = res.json<InternetDbResponse>();
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://internetdb.shodan.io/${ip}`,
          title: `${ip}: ${d.ports.length} open port(s) observed${d.vulns.length ? `, ${d.vulns.length} version-inferred CVE(s)` : ''}`,
          description: `Ports ${d.ports.join(', ') || '—'}. Tags: ${d.tags.join(', ') || '—'}.`,
          excerpt: `ports=${d.ports.join(',')}; hostnames=${d.hostnames.join(',')}; cpes=${d.cpes.slice(0, 8).join(',')}; vulns=${d.vulns.slice(0, 10).join(',')}`,
          entityType: 'ip',
          normalizedValue: ip,
          category: 'network',
          claimType: 'SOURCE_CLAIM',
          entities: [{ ref: 'ip', type: 'ip', value: ip }, ...d.hostnames.slice(0, 20).map((h, i) => ({ ref: `h${i}`, type: 'domain' as const, value: h.toLowerCase() }))],
          subjectRef: 'ip',
          relationships: d.hostnames.slice(0, 20).map((_, i) => ({ from: `h${i}`, to: 'ip', type: 'RESOLVES_TO' as const, status: 'possible' as const, rationale: 'Hostname observed by Shodan for this IP.' })),
          metadata: { ...d },
          fingerprintKey: `internetdb:${ip}`,
          raw: d,
        }),
      ],
    };
  },
};

export const shodanProvider: Provider = {
  id: 'shodan',
  name: 'Shodan host API',
  category: 'ip',
  kind: 'live',
  reliability: 'reputable',
  description: 'Detailed service banners, organization, ISP and approximate location from the Shodan host API.',
  homepage: 'https://www.shodan.io',
  docsUrl: 'https://developer.shodan.io/api',
  operations: [{ id: 'shodan_host', label: 'Shodan host details', targetTypes: ['ip'], module: 'reputation', minDepth: 'deep' }],
  config: [{ env: 'SHODAN_API_KEY', label: 'Shodan API key' }],
  timeoutMs: 15000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 1100,
  async run(input, ctx) {
    const ip = input.subject.value;
    requirePublic(ip);
    const key = ctx.env.SHODAN_API_KEY!;
    const res = await ctx.http.request(`https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}&minify=true`, { allowStatus: [404] });
    if (res.status === 404) return { records: [], notes: ['No Shodan host record.'] };
    const d = res.json<{ org?: string; isp?: string; asn?: string; country_code?: string; city?: string; latitude?: number; longitude?: number; ports?: number[]; hostnames?: string[]; last_update?: string; os?: string | null }>();
    const updated = parseSourceDate(d.last_update);
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://www.shodan.io/host/${ip}`,
          title: `${ip}: ${d.org ?? d.isp ?? 'unknown org'} — ports ${(d.ports ?? []).slice(0, 8).join(', ') || 'none'}`,
          description: `ISP ${d.isp ?? '—'}, ${d.asn ?? ''}. Approximate location ${[d.city, d.country_code].filter(Boolean).join(', ') || 'unknown'}.`,
          excerpt: JSON.stringify({ org: d.org, isp: d.isp, asn: d.asn, ports: d.ports, hostnames: d.hostnames, os: d.os }),
          entityType: 'ip',
          normalizedValue: ip,
          publishedAt: updated?.iso ?? null,
          publishedPrecision: updated?.precision ?? null,
          category: 'network',
          claimType: 'SOURCE_CLAIM',
          geo:
            typeof d.latitude === 'number' && typeof d.longitude === 'number'
              ? { lat: d.latitude, lon: d.longitude, precision: d.city ? 'city' : 'country', place: [d.city, d.country_code].filter(Boolean).join(', '), countryCode: d.country_code ?? null, basis: 'Shodan geolocation database estimate.' }
              : null,
          assertions: d.country_code ? [{ subjectRef: 'subject', attribute: 'country', value: d.country_code }] : [],
          entities: [{ ref: 'subject', type: 'ip', value: ip }],
          metadata: { ...d },
          fingerprintKey: `shodan:${ip}`,
          limitations: [APPROX],
          raw: d,
        }),
      ],
    };
  },
};

export const ipinfoProvider: Provider = {
  id: 'ipinfo',
  name: 'IPinfo',
  category: 'ip',
  kind: 'live',
  reliability: 'reputable',
  description: 'Approximate geolocation, ASN and hosting/anycast flags. Works with a free token; limited without one.',
  homepage: 'https://ipinfo.io',
  docsUrl: 'https://ipinfo.io/developers',
  operations: [{ id: 'ipinfo', label: 'Approximate geolocation', targetTypes: ['ip'], module: 'ip', minDepth: 'standard' }],
  config: [{ env: 'IPINFO_TOKEN', label: 'IPinfo token', optional: true }],
  timeoutMs: 10000,
  maxRetries: 1,
  concurrency: 2,
  limitations: [APPROX],
  async run(input, ctx) {
    const ip = input.subject.value;
    requirePublic(ip);
    const token = ctx.env.IPINFO_TOKEN;
    const res = await ctx.http.request(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const d = res.json<{ city?: string; region?: string; country?: string; loc?: string; org?: string; hostname?: string; anycast?: boolean; bogon?: boolean }>();
    if (d.bogon) return { records: [], notes: ['Bogon address.'] };
    const [lat, lon] = (d.loc ?? '').split(',').map(Number);
    const precision = d.city ? 'city' : d.region ? 'region' : 'country';
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://ipinfo.io/${ip}`,
          title: `${ip} approximately located in ${[d.city, d.region, d.country].filter(Boolean).join(', ') || 'unknown'}`,
          description: `${d.org ?? 'Organization unknown'}${d.anycast ? '. Anycast address — location is especially unreliable.' : ''}`,
          excerpt: JSON.stringify(d),
          entityType: 'ip',
          normalizedValue: ip,
          category: 'geolocation',
          claimType: 'SOURCE_CLAIM',
          entities: [{ ref: 'subject', type: 'ip', value: ip }],
          geo:
            Number.isFinite(lat) && Number.isFinite(lon)
              ? { lat: lat!, lon: lon!, precision: d.anycast ? 'country' : precision, place: [d.city, d.region, d.country].filter(Boolean).join(', '), countryCode: d.country ?? null, basis: 'IPinfo geolocation database estimate.' }
              : null,
          assertions: d.country ? [{ subjectRef: 'subject', attribute: 'country', value: d.country }] : [],
          metadata: { ...d },
          fingerprintKey: `ipinfo:${ip}`,
          limitations: [APPROX],
          raw: d,
        }),
      ],
    };
  },
};

export const abuseIpDbProvider: Provider = {
  id: 'abuseipdb',
  name: 'AbuseIPDB',
  category: 'ip',
  kind: 'live',
  reliability: 'reputable',
  description: 'Community abuse reports and confidence-of-abuse score for an IP (last 90 days).',
  homepage: 'https://www.abuseipdb.com',
  docsUrl: 'https://docs.abuseipdb.com/#check-endpoint',
  operations: [{ id: 'abuse_check', label: 'Abuse reports', targetTypes: ['ip'], module: 'reputation', minDepth: 'standard' }],
  config: [{ env: 'ABUSEIPDB_API_KEY', label: 'AbuseIPDB API key' }],
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 2,
  async run(input, ctx) {
    const ip = input.subject.value;
    requirePublic(ip);
    const res = await ctx.http.request(`https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`, {
      headers: { key: ctx.env.ABUSEIPDB_API_KEY!, accept: 'application/json' },
    });
    const d = res.json<{ data: { abuseConfidenceScore: number; totalReports: number; numDistinctUsers: number; lastReportedAt: string | null; usageType?: string; isp?: string; domain?: string; isTor?: boolean; countryCode?: string } }>().data;
    const last = parseSourceDate(d.lastReportedAt);
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://www.abuseipdb.com/check/${ip}`,
          title: `${ip}: ${d.totalReports} abuse report(s) from ${d.numDistinctUsers} reporter(s) in 90 days (AbuseIPDB score ${d.abuseConfidenceScore}/100)`,
          description: `Usage type ${d.usageType ?? '—'}; ISP ${d.isp ?? '—'}${d.isTor ? '; Tor exit node' : ''}. The AbuseIPDB score is the provider’s own metric, not an ATLAS probability.`,
          excerpt: JSON.stringify(d),
          entityType: 'ip',
          normalizedValue: ip,
          publishedAt: last?.iso ?? null,
          publishedPrecision: last?.precision ?? null,
          category: 'reputation',
          claimType: 'SOURCE_CLAIM',
          events: last ? [{ date: last.iso, precision: last.precision, kind: 'event', label: `Most recent AbuseIPDB report for ${ip}` }] : [],
          metadata: { ...d },
          fingerprintKey: `abuseipdb:${ip}`,
          limitations: ['Community reports can be erroneous or malicious; shared/NAT addresses accumulate unrelated reports.'],
          raw: d,
        }),
      ],
    };
  },
};

interface VtAttributes {
  last_analysis_stats?: Record<string, number>;
  reputation?: number;
  as_owner?: string;
  country?: string;
  last_analysis_date?: number;
  categories?: Record<string, string>;
  creation_date?: number;
  registrar?: string;
}

export const virusTotalProvider: Provider = {
  id: 'virustotal',
  name: 'VirusTotal',
  category: 'ip',
  kind: 'live',
  reliability: 'reputable',
  description: 'Multi-engine reputation verdicts for IPs, domains and URLs.',
  homepage: 'https://www.virustotal.com',
  docsUrl: 'https://docs.virustotal.com/reference/overview',
  operations: [
    { id: 'vt_ip', label: 'IP reputation', targetTypes: ['ip'], module: 'reputation', minDepth: 'standard' },
    { id: 'vt_domain', label: 'Domain reputation', targetTypes: ['domain'], module: 'reputation', minDepth: 'standard' },
    { id: 'vt_url', label: 'URL reputation', targetTypes: ['url'], module: 'reputation', minDepth: 'standard' },
  ],
  config: [{ env: 'VIRUSTOTAL_API_KEY', label: 'VirusTotal API key' }],
  timeoutMs: 15000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 15500, // public API: 4 requests/minute
  limitations: ['Public API quota is 4 requests/minute and 500/day.'],
  async run(input, ctx) {
    const v = input.subject.value;
    let path: string;
    let entityType: 'ip' | 'domain' | 'url';
    if (input.operation === 'vt_ip') {
      requirePublic(v);
      path = `ip_addresses/${encodeURIComponent(v)}`;
      entityType = 'ip';
    } else if (input.operation === 'vt_domain') {
      path = `domains/${encodeURIComponent(v)}`;
      entityType = 'domain';
    } else {
      path = `urls/${Buffer.from(v).toString('base64url')}`;
      entityType = 'url';
    }
    const res = await ctx.http.request(`https://www.virustotal.com/api/v3/${path}`, {
      headers: { 'x-apikey': ctx.env.VIRUSTOTAL_API_KEY! },
      allowStatus: [404],
    });
    if (res.status === 404) return { records: [], notes: ['VirusTotal has no record for this indicator.'] };
    const a = res.json<{ data: { attributes: VtAttributes } }>().data.attributes;
    const stats = a.last_analysis_stats ?? {};
    const analyzed = parseSourceDate(a.last_analysis_date);
    const guiType = entityType === 'ip' ? 'ip-address' : entityType;
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://www.virustotal.com/gui/${guiType}/${entityType === 'url' ? Buffer.from(v).toString('base64url') : v}`,
          title: `VirusTotal: ${stats.malicious ?? 0} malicious / ${stats.suspicious ?? 0} suspicious of ${Object.values(stats).reduce((s, n) => s + n, 0)} engines`,
          description: `Community reputation ${a.reputation ?? 0}.${a.as_owner ? ` AS owner ${a.as_owner}.` : ''}${a.registrar ? ` Registrar ${a.registrar}.` : ''} Engine verdicts can disagree and include false positives.`,
          excerpt: JSON.stringify({ stats, reputation: a.reputation, categories: a.categories }),
          entityType,
          normalizedValue: v,
          publishedAt: analyzed?.iso ?? null,
          publishedPrecision: analyzed?.precision ?? null,
          category: 'reputation',
          claimType: 'SOURCE_CLAIM',
          metadata: { stats, reputation: a.reputation, asOwner: a.as_owner, country: a.country, categories: a.categories },
          fingerprintKey: `vt:${entityType}:${v}`,
          raw: { stats, reputation: a.reputation, as_owner: a.as_owner, country: a.country, categories: a.categories },
        }),
      ],
    };
  },
};

export const IP_PROVIDERS: Provider[] = [cymruProvider, reverseDnsProvider, internetDbProvider, ipinfoProvider, abuseIpDbProvider, shodanProvider, virusTotalProvider];
