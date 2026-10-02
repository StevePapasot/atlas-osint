/**
 * RDAP (Registration Data Access Protocol, RFC 9083) for domains and IP networks.
 * Uses the rdap.org bootstrap redirector by default (ATLAS_RDAP_BASE_URL to override).
 */
import type { NormalizedRecord, Provider, ProviderContext, RecordEvent } from '../types';
import { makeRecord, parseSourceDate } from '../util';

interface RdapEntity {
  roles?: string[];
  vcardArray?: [string, Array<[string, Record<string, unknown>, string, unknown]>];
  handle?: string;
  entities?: RdapEntity[];
}
interface RdapEvent {
  eventAction: string;
  eventDate: string;
}
interface RdapResponse {
  ldhName?: string;
  handle?: string;
  name?: string;
  status?: string[];
  events?: RdapEvent[];
  entities?: RdapEntity[];
  nameservers?: Array<{ ldhName?: string }>;
  startAddress?: string;
  endAddress?: string;
  cidr0_cidrs?: Array<{ v4prefix?: string; v6prefix?: string; length: number }>;
  country?: string;
  type?: string;
  port43?: string;
  links?: Array<{ rel?: string; href?: string }>;
}

function base(): string {
  return (process.env.ATLAS_RDAP_BASE_URL ?? 'https://rdap.org').replace(/\/$/, '');
}

function vcardName(e: RdapEntity): string | null {
  const props = e.vcardArray?.[1] ?? [];
  const fn = props.find((p) => p[0] === 'fn');
  const org = props.find((p) => p[0] === 'org');
  const v = (fn?.[3] ?? org?.[3]) as string | undefined;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function flattenEntities(list: RdapEntity[] = [], depth = 0): RdapEntity[] {
  if (depth > 3) return [];
  return list.flatMap((e) => [e, ...flattenEntities(e.entities, depth + 1)]);
}

function isRedacted(name: string): boolean {
  return /redacted|privacy|withheld|not disclosed|data protected/i.test(name);
}

function eventsFrom(data: RdapResponse, label: string, ref: string): RecordEvent[] {
  const map: Record<string, string> = {
    registration: 'registered',
    expiration: 'registration expires',
    'last changed': 'registration record last changed',
    transfer: 'transferred',
  };
  return (data.events ?? [])
    .filter((e) => map[e.eventAction])
    .map((e) => {
      const d = parseSourceDate(e.eventDate);
      return d ? { date: d.iso, precision: d.precision, kind: 'registration' as const, label: `${label} ${map[e.eventAction]}`, entityRef: ref } : null;
    })
    .filter((e): e is NonNullable<typeof e> => Boolean(e));
}

async function domainLookup(provider: Provider, ctx: ProviderContext, domain: string): Promise<NormalizedRecord[]> {
  const url = `${base()}/domain/${encodeURIComponent(domain)}`;
  const res = await ctx.http.request(url, { headers: { accept: 'application/rdap+json, application/json' }, allowStatus: [404] });
  if (res.status === 404) {
    return [
      makeRecord(provider, ctx, {
        sourceUrl: url,
        title: `No RDAP registration record found for ${domain}`,
        description: 'The registry returned 404. The name may be unregistered, a subdomain, or the TLD may not support RDAP.',
        entityType: 'domain',
        normalizedValue: domain,
        category: 'registration',
        claimType: 'SOURCE_CLAIM',
        fingerprintKey: `rdap:${domain}`,
      }),
    ];
  }
  const data = res.json<RdapResponse>();
  const all = flattenEntities(data.entities);
  const registrar = all.find((e) => e.roles?.includes('registrar'));
  const registrant = all.find((e) => e.roles?.includes('registrant'));
  const registrarName = registrar ? vcardName(registrar) : null;
  const registrantName = registrant ? vcardName(registrant) : null;
  const created = data.events?.find((e) => e.eventAction === 'registration')?.eventDate;
  const expires = data.events?.find((e) => e.eventAction === 'expiration')?.eventDate;
  const ns = (data.nameservers ?? []).map((n) => n.ldhName?.toLowerCase()).filter((n): n is string => Boolean(n));
  const entities = [
    { ref: 'd', type: 'domain' as const, value: domain },
    ...(registrarName ? [{ ref: 'registrar', type: 'organization' as const, value: registrarName.toLowerCase(), display: registrarName }] : []),
    ...(registrantName && !isRedacted(registrantName)
      ? [{ ref: 'registrant', type: 'organization' as const, value: registrantName.toLowerCase(), display: registrantName }]
      : []),
  ];
  const records: NormalizedRecord[] = [
    makeRecord(provider, ctx, {
      sourceUrl: res.url,
      title: `${domain} registration: ${registrarName ?? 'registrar not stated'}${created ? `, created ${created.slice(0, 10)}` : ''}`,
      description: [
        registrantName ? `Registrant: ${isRedacted(registrantName) ? 'redacted for privacy' : registrantName}.` : 'Registrant not disclosed.',
        expires ? `Expires ${expires.slice(0, 10)}.` : null,
        data.status?.length ? `Status: ${data.status.join(', ')}.` : null,
      ]
        .filter(Boolean)
        .join(' '),
      excerpt: `registrar=${registrarName ?? '—'}; created=${created ?? '—'}; expires=${expires ?? '—'}; nameservers=${ns.join(', ') || '—'}`,
      entityType: 'domain',
      normalizedValue: domain,
      category: 'registration',
      claimType: 'SOURCE_CLAIM',
      entities,
      subjectRef: 'd',
      relationships: [
        ...(registrarName ? [{ from: 'd', to: 'registrar', type: 'ASSOCIATED_WITH' as const, status: 'confirmed' as const, rationale: 'Sponsoring registrar per RDAP.' }] : []),
        ...(entities.some((e) => e.ref === 'registrant')
          ? [{ from: 'registrant', to: 'd', type: 'USES' as const, status: 'possible' as const, rationale: 'Registrant organization per RDAP (registry data may be stale).' }]
          : []),
      ],
      events: eventsFrom(data, domain, 'd'),
      assertions: registrarName ? [{ subjectRef: 'd', attribute: 'registrar', value: registrarName }] : [],
      metadata: { registrar: registrarName, registrant: registrantName, status: data.status ?? [], nameservers: ns, port43: data.port43 ?? null },
      fingerprintKey: `rdap:${domain}`,
      limitations: ['Registration data reflects registry records, which may be redacted, proxied or outdated.'],
      raw: data,
    }),
  ];
  return records;
}

async function ipLookup(provider: Provider, ctx: ProviderContext, ip: string): Promise<NormalizedRecord[]> {
  const url = `${base()}/ip/${encodeURIComponent(ip)}`;
  const res = await ctx.http.request(url, { headers: { accept: 'application/rdap+json, application/json' }, allowStatus: [404] });
  if (res.status === 404) return [];
  const data = res.json<RdapResponse>();
  const all = flattenEntities(data.entities);
  const orgEntity = all.find((e) => e.roles?.includes('registrant')) ?? all.find((e) => e.roles?.includes('administrative'));
  const orgName = orgEntity ? vcardName(orgEntity) : null;
  const cidr = data.cidr0_cidrs?.[0];
  const prefix = cidr ? `${cidr.v4prefix ?? cidr.v6prefix}/${cidr.length}` : data.startAddress && data.endAddress ? `${data.startAddress} – ${data.endAddress}` : null;
  return [
    makeRecord(provider, ctx, {
      sourceUrl: res.url,
      title: `${ip} is in network ${data.name ?? data.handle ?? 'unknown'}${orgName ? ` registered to ${orgName}` : ''}`,
      description: `Network ${prefix ?? 'range unknown'}${data.country ? `, registration country ${data.country}` : ''}. Registration country is administrative and not a physical location.`,
      excerpt: `handle=${data.handle ?? '—'}; name=${data.name ?? '—'}; range=${prefix ?? '—'}; org=${orgName ?? '—'}; country=${data.country ?? '—'}`,
      entityType: 'ip',
      normalizedValue: ip,
      category: 'registration',
      claimType: 'SOURCE_CLAIM',
      entities: [
        { ref: 'ip', type: 'ip', value: ip },
        ...(orgName ? [{ ref: 'org', type: 'organization' as const, value: orgName.toLowerCase(), display: orgName }] : []),
      ],
      subjectRef: 'ip',
      relationships: orgName ? [{ from: 'ip', to: 'org', type: 'ASSOCIATED_WITH', status: 'confirmed', rationale: 'Network registrant per RIR RDAP.' }] : [],
      events: eventsFrom(data, `Network ${data.handle ?? ''}`.trim(), 'ip'),
      assertions: data.country ? [{ subjectRef: 'ip', attribute: 'registration_country', value: data.country }] : [],
      metadata: { handle: data.handle, name: data.name, prefix, org: orgName, country: data.country ?? null },
      fingerprintKey: `rdap-ip:${ip}`,
      raw: data,
    }),
  ];
}

export const rdapProvider: Provider = {
  id: 'rdap',
  name: 'RDAP registration data',
  category: 'domain',
  kind: 'live',
  reliability: 'authoritative',
  description: 'Domain and IP registration records via RDAP (registrar, dates, nameservers, network owner).',
  homepage: 'https://rdap.org',
  docsUrl: 'https://www.rfc-editor.org/rfc/rfc9083',
  operations: [
    { id: 'domain_rdap', label: 'Domain registration (RDAP)', targetTypes: ['domain'], module: 'domain', minDepth: 'quick' },
    { id: 'ip_rdap', label: 'IP network registration (RDAP)', targetTypes: ['ip'], module: 'ip', minDepth: 'standard' },
  ],
  config: [],
  timeoutMs: 15000,
  maxRetries: 2,
  concurrency: 2,
  minIntervalMs: 500,
  limitations: ['Registrant data is frequently redacted under privacy rules.', 'Subdomains have no RDAP records of their own.'],
  async run(input, ctx) {
    if (input.operation === 'ip_rdap') return { records: await ipLookup(this, ctx, input.subject.value) };
    return { records: await domainLookup(this, ctx, input.subject.value) };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    await ctx.http.request(`${base()}/domain/iana.org`, { headers: { accept: 'application/rdap+json' } });
    return { status: 'healthy', message: 'RDAP lookup for iana.org succeeded.', latencyMs: Date.now() - t };
  },
};
