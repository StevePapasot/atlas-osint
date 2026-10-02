/**
 * SIMULATED providers for demo mode.
 * They generate deterministic, clearly fictional evidence using reserved names and addresses
 * (RFC 2606 domains, RFC 5737 TEST-NET IPs, RFC 5398 documentation ASNs). Every record is flagged
 * `isSimulated` and every source name is prefixed with "[SIMULATED]". They never touch the network.
 */
import { ProviderError, type NormalizedRecord, type Provider, type ProviderContext, type ProviderInput } from '../types';
import { makeRecord, seededRandom, sleep, slug } from '../util';
import type { TargetType } from '@/shared/domain';

const DEMO_LIMITATION = 'Simulated demo data. Not collected from any real source and must not be treated as intelligence.';

const CITIES = [
  { place: 'Lisbon, Portugal', cc: 'PT', lat: 38.7223, lon: -9.1393 },
  { place: 'Rotterdam, Netherlands', cc: 'NL', lat: 51.9244, lon: 4.4777 },
  { place: 'Tallinn, Estonia', cc: 'EE', lat: 59.437, lon: 24.7536 },
  { place: 'Montréal, Canada', cc: 'CA', lat: 45.5019, lon: -73.5674 },
  { place: 'Kraków, Poland', cc: 'PL', lat: 50.0647, lon: 19.945 },
];

const ORGS = ['Northwind Analytics (fictional)', 'Bluefin Logistics (fictional)', 'Contoso Research Group (fictional)'];

async function simulateLatency(input: ProviderInput, ctx: ProviderContext, providerId: string) {
  const rnd = seededRandom(`${providerId}:${input.subject.value}:${input.operation}:${JSON.stringify(input.params)}`);
  const base = process.env.ATLAS_DEMO_FAST === 'true' ? 20 : 250;
  await sleep(base + Math.floor(rnd() * (base * 3)), ctx.signal);
}

function handleFor(input: ProviderInput): string {
  const s = input.subject;
  if (s.type === 'email') return s.value.split('@')[0]!.replace(/[^a-z0-9]/g, '');
  if (s.type === 'username') return s.value;
  if (s.type === 'person' || s.type === 'organization') return slug(s.display).replace(/-/g, '');
  return slug(s.display).replace(/-/g, '').slice(0, 16) || 'subject';
}

function demoDomainFor(input: ProviderInput): string | null {
  const s = input.subject;
  if (s.type === 'domain') return s.value;
  if (s.type === 'email') return s.value.split('@')[1] ?? null;
  if (s.type === 'url') {
    try {
      return new URL(s.value).hostname;
    } catch {
      return null;
    }
  }
  return null;
}

function testNetIp(seed: string, index: number): string {
  const rnd = seededRandom(`${seed}:${index}`);
  const nets = ['192.0.2', '198.51.100', '203.0.113'];
  return `${nets[Math.floor(rnd() * nets.length)]}.${10 + Math.floor(rnd() * 240)}`;
}

const SUBJECT_ENTITY: Record<TargetType, NormalizedRecord['entityType']> = {
  person: 'person',
  organization: 'organization',
  username: 'username',
  email: 'email',
  ip: 'ip',
  domain: 'domain',
  url: 'url',
  phone: 'phone',
  crypto: 'crypto_address',
  image: 'image',
  document: 'document',
  keyword: 'keyword',
};

function subjectEntity(input: ProviderInput) {
  return { ref: 'subject', type: SUBJECT_ENTITY[input.subject.type], value: input.subject.value, display: input.subject.display };
}

// ------------------------------------------------------------------------------------------------------------
// Simulated web index (two instances so cross-provider deduplication/corroboration can be demonstrated)
// ------------------------------------------------------------------------------------------------------------

function makeSearchProvider(id: string, name: string, variant: number): Provider {
  const provider: Provider = {
    id,
    name,
    category: 'demo',
    kind: 'simulated',
    reliability: 'unknown',
    description: 'Simulated search index returning fictional web pages on reserved example domains.',
    operations: [
      {
        id: 'web_search',
        label: 'Simulated web search',
        targetTypes: ['person', 'organization', 'username', 'email', 'domain', 'url', 'phone', 'crypto', 'keyword', 'ip'],
        module: 'web_search',
        minDepth: 'quick',
      },
    ],
    config: [],
    limitations: [DEMO_LIMITATION],
    async run(input, ctx) {
      await simulateLatency(input, ctx, id);
      const rnd = seededRandom(`${input.subject.value}:search`);
      const handle = handleFor(input);
      const display = input.subject.display;
      const city = CITIES[Math.floor(rnd() * CITIES.length)]!;
      const org = ORGS[Math.floor(rnd() * ORGS.length)]!;
      const pages = [
        {
          url: `https://news.example.com/2024/${slug(display)}-community-profile`,
          title: `Community spotlight: ${display}`,
          snippet: `A local newsletter profile mentions ${display} in connection with ${org} and community events in ${city.place}.`,
          date: '2024-03-14',
          mentionsOrg: true,
          geo: true,
        },
        {
          url: `https://forum.example.net/members/${handle}`,
          title: `${handle} — member profile (Example Forum)`,
          snippet: `Forum member "${handle}" has posted about open-source tooling. Profile lists a website and joined date.`,
          date: '2021-09-02',
        },
        {
          url: `https://docs.example.org/reports/${slug(org)}-annual-review.pdf`,
          title: `${org} — annual review (PDF)`,
          snippet: `PDF document listing staff and contributors; includes the string "${display}".`,
          date: '2023-11-30',
          mentionsOrg: true,
          document: true,
        },
        {
          url: `https://archive.example.com/snapshots/${slug(display)}`,
          title: `Archived page referencing ${display}`,
          snippet: `An archived copy of a page that references ${display}. Original publication date unknown.`,
          date: null,
        },
      ];
      // Variant 1 returns pages 0-2, variant 2 returns pages 0,1,3 → overlap on 0 and 1 for dedupe demonstration.
      const chosen = variant === 1 ? [pages[0]!, pages[1]!, pages[2]!] : [pages[0]!, pages[1]!, pages[3]!];
      const query = String(input.params.query ?? display);
      return {
        records: chosen.map((p) =>
          makeRecord(provider, ctx, {
            sourceName: `[SIMULATED] ${name}`,
            sourceUrl: p.url,
            title: p.title,
            description: p.snippet,
            excerpt: p.snippet,
            entityType: SUBJECT_ENTITY[input.subject.type],
            normalizedValue: input.subject.value,
            publishedAt: p.date ? `${p.date}T00:00:00.000Z` : null,
            publishedPrecision: p.date ? 'day' : 'unknown',
            category: p.document ? 'document' : 'web_mention',
            claimType: 'UNVERIFIED_LEAD',
            confidenceInputs: { sourceReliability: 'unknown', matchType: 'partial' },
            entities: [
              subjectEntity(input),
              { ref: 'page', type: p.document ? 'document' : 'url', value: p.url, display: p.title },
              ...(p.mentionsOrg ? [{ ref: 'org', type: 'organization' as const, value: org.toLowerCase(), display: org }] : []),
              ...(p.geo ? [{ ref: 'loc', type: 'location' as const, value: city.place.toLowerCase(), display: city.place }] : []),
            ],
            relationships: [
              { from: 'page', to: 'subject', type: 'MENTIONS', status: 'possible', rationale: 'Simulated page text contains the identifier.' },
              ...(p.mentionsOrg
                ? [{ from: 'subject', to: 'org', type: 'ASSOCIATED_WITH' as const, status: 'possible' as const, rationale: 'Co-mentioned on simulated page.' }]
                : []),
              ...(p.geo
                ? [{ from: 'subject', to: 'loc', type: 'LOCATED_IN' as const, status: 'possible' as const, rationale: 'Location mentioned in simulated article.' }]
                : []),
            ],
            geo: p.geo
              ? { lat: city.lat, lon: city.lon, precision: 'city', place: city.place, countryCode: city.cc, basis: 'Place name mentioned in simulated article text (geocoded to city centre).' }
              : null,
            events: p.date
              ? [{ date: `${p.date}T00:00:00.000Z`, precision: 'day', kind: 'source_published', label: `Published: ${p.title}` }]
              : [],
            metadata: { query, rank: chosen.indexOf(p) + 1, simulated: true },
            fingerprintKey: `web:${p.url}`,
            limitations: [DEMO_LIMITATION],
            raw: { simulated: true, query, result: p },
          }),
        ),
      };
    },
  };
  return provider;
}

export const demoSearch = makeSearchProvider('demo.search', 'Simulated Web Index', 1);
export const demoSearchAlt = makeSearchProvider('demo.search-alt', 'Simulated News Index', 2);

// ------------------------------------------------------------------------------------------------------------
// Simulated public profile directory
// ------------------------------------------------------------------------------------------------------------

export const demoProfiles: Provider = {
  id: 'demo.profiles',
  name: 'Simulated Profile Directory',
  category: 'demo',
  kind: 'simulated',
  reliability: 'reputable',
  description: 'Simulated public-profile platforms (Codeforge, Pixelboard, Threadline) with fictional accounts.',
  operations: [
    { id: 'profile_lookup', label: 'Simulated profile lookup', targetTypes: ['username', 'email', 'person'], module: 'username', minDepth: 'quick' },
  ],
  config: [],
  limitations: [DEMO_LIMITATION, 'A matching username is not proof that accounts belong to the same person.'],
  async run(input, ctx) {
    await simulateLatency(input, ctx, this.id);
    const handle = handleFor(input);
    const rnd = seededRandom(`${handle}:profiles`);
    const city = CITIES[Math.floor(rnd() * CITIES.length)]!;
    const website = `https://${handle}.example.dev`;
    const platforms = [
      { platform: 'Codeforge', host: 'codeforge.example', created: '2016-05-21', bio: `Builds data pipelines. ${city.place.split(',')[0]}.`, website, name: 'J. Doe' },
      { platform: 'Pixelboard', host: 'pixelboard.example', created: '2019-02-11', bio: 'Photography and maps. Opinions my own.', website, name: 'J. Doe' },
      { platform: 'Threadline', host: 'threadline.example', created: '2022-08-03', bio: 'Mostly lurking.', website: null, name: `${handle}` },
    ];
    const records = platforms.map((p, i) => {
      const url = `https://${p.host}/${handle}`;
      const acct = `${p.platform.toLowerCase()}:${handle}`;
      return makeRecord(this, ctx, {
        sourceName: `[SIMULATED] ${p.platform}`,
        sourceUrl: url,
        title: `${p.platform} account "${handle}" exists`,
        description: `Simulated public profile on ${p.platform}. Display name "${p.name}". Bio: ${p.bio}`,
        excerpt: `display_name=${p.name}; bio=${p.bio}; website=${p.website ?? 'none'}; location=${i === 0 ? city.place : 'not stated'}`,
        entityType: 'social_account',
        normalizedValue: acct,
        subjectRef: 'acct',
        publishedAt: `${p.created}T00:00:00.000Z`,
        publishedPrecision: 'day',
        category: 'profile',
        claimType: 'SOURCE_CLAIM',
        confidenceInputs: { sourceReliability: 'reputable', matchType: input.subject.type === 'username' ? 'exact' : 'partial', signals: ['username_match'] },
        entities: [
          subjectEntity(input),
          { ref: 'acct', type: 'social_account', value: acct, display: `${p.platform} / ${handle}`, attributes: { platform: p.platform, username: handle, displayName: p.name, bio: p.bio, website: p.website, profileUrl: url } },
          ...(p.website ? [{ ref: 'site', type: 'url' as const, value: p.website, display: p.website }] : []),
          ...(i === 0 ? [{ ref: 'loc', type: 'location' as const, value: city.place.toLowerCase(), display: city.place }] : []),
        ],
        relationships: [
          { from: 'subject', to: 'acct', type: 'USES', status: 'possible', rationale: 'Account handle matches the supplied identifier (simulated).' },
          ...(p.website ? [{ from: 'acct', to: 'site', type: 'LINKED_TO' as const, status: 'confirmed' as const, rationale: 'Website listed on the simulated profile.' }] : []),
          ...(i === 0 ? [{ from: 'acct', to: 'loc', type: 'LOCATED_IN' as const, status: 'possible' as const, rationale: 'Self-reported profile location (simulated).' }] : []),
        ],
        geo: i === 0 ? { lat: city.lat, lon: city.lon, precision: 'city', place: city.place, countryCode: city.cc, basis: 'Self-reported profile location (simulated); not verified.' } : null,
        events: [{ date: `${p.created}T00:00:00.000Z`, precision: 'day', kind: 'event', label: `${p.platform} account created (simulated)`, entityRef: 'acct' }],
        assertions: i < 2 ? [{ subjectRef: 'subject', attribute: 'display_name', value: p.name }] : [{ subjectRef: 'subject', attribute: 'display_name', value: p.name }],
        metadata: { platform: p.platform, username: handle, displayName: p.name, bio: p.bio, website: p.website, simulated: true },
        limitations: [DEMO_LIMITATION],
        raw: { simulated: true, platform: p.platform, username: handle, display_name: p.name, bio: p.bio, website: p.website, created_at: p.created },
      });
    });
    return { records };
  },
};

// ------------------------------------------------------------------------------------------------------------
// Simulated infrastructure (DNS / RDAP / certificates)
// ------------------------------------------------------------------------------------------------------------

export const demoInfrastructure: Provider = {
  id: 'demo.infrastructure',
  name: 'Simulated DNS & Registration',
  category: 'demo',
  kind: 'simulated',
  reliability: 'authoritative',
  description: 'Simulated DNS records, registration data and certificate history using documentation address space.',
  operations: [
    { id: 'domain_profile', label: 'Simulated domain profile', targetTypes: ['domain', 'email', 'url'], module: 'domain', minDepth: 'quick' },
  ],
  config: [],
  limitations: [DEMO_LIMITATION],
  async run(input, ctx) {
    await simulateLatency(input, ctx, this.id);
    const domain = demoDomainFor(input);
    if (!domain) return { records: [] };
    const ips = [testNetIp(domain, 1), testNetIp(domain, 2)];
    const asn = 64500 + (domain.length % 10);
    const recs: NormalizedRecord[] = [];
    const isPivot = input.subject.metadata.pivot === true;
    const base = {
      sourceName: '[SIMULATED] DNS resolver',
      entityType: 'domain' as const,
      normalizedValue: domain,
      claimType: 'FACT' as const,
      limitations: [DEMO_LIMITATION],
      confidenceInputs: { sourceReliability: 'authoritative' as const, matchType: 'exact' as const },
    };
    recs.push(
      makeRecord(this, ctx, {
        ...base,
        sourceUrl: null,
        title: `${domain} resolves to ${ips.join(', ')}`,
        description: `A records observed for ${domain} (simulated).`,
        excerpt: ips.map((ip) => `${domain}. 300 IN A ${ip}`).join('\n'),
        category: 'dns',
        entities: [
          { ref: 'd', type: 'domain', value: domain },
          ...ips.map((ip, i) => ({ ref: `ip${i}`, type: 'ip' as const, value: ip })),
          { ref: 'asn', type: 'asn', value: `as${asn}`, display: `AS${asn} EXAMPLE-NET (simulated)` },
        ],
        subjectRef: 'd',
        relationships: [
          ...ips.map((_, i) => ({ from: 'd', to: `ip${i}`, type: 'RESOLVES_TO' as const, status: 'confirmed' as const, rationale: 'A record (simulated).' })),
          ...ips.map((_, i) => ({ from: `ip${i}`, to: 'asn', type: 'HOSTED_ON' as const, status: 'confirmed' as const, rationale: 'Prefix announced by ASN (simulated).' })),
        ],
        metadata: { recordType: 'A', values: ips },
        raw: { simulated: true, A: ips },
      }),
    );
    // Pivoted (discovered) hostnames only get address resolution, mirroring the live pivot policy.
    if (isPivot) return { records: recs };
    recs.push(
      makeRecord(this, ctx, {
        ...base,
        sourceUrl: null,
        title: `Mail for ${domain} handled by mx1.mail.example.net`,
        description: 'MX and SPF records indicate a hosted mail provider (simulated).',
        excerpt: `${domain}. 3600 IN MX 10 mx1.mail.example.net.\n${domain}. 3600 IN TXT "v=spf1 include:_spf.mail.example.net -all"`,
        category: 'dns',
        entities: [
          { ref: 'd', type: 'domain', value: domain },
          { ref: 'mx', type: 'domain', value: 'mx1.mail.example.net' },
        ],
        subjectRef: 'd',
        relationships: [{ from: 'd', to: 'mx', type: 'LINKED_TO', status: 'confirmed', rationale: 'MX record (simulated).' }],
        metadata: { recordType: 'MX', provider: 'Example Mail (simulated)' },
        raw: { simulated: true, MX: ['10 mx1.mail.example.net'] },
      }),
      makeRecord(this, ctx, {
        ...base,
        sourceName: '[SIMULATED] RDAP registry',
        sourceUrl: `https://rdap.example.net/domain/${domain}`,
        title: `${domain} registered via Example Registrar (simulated)`,
        description: 'Registration record lists creation and expiry dates; registrant details redacted for privacy.',
        excerpt: `registrar=Example Registrar, Inc. (simulated); created=2015-06-01; expires=2027-06-01; registrant=REDACTED FOR PRIVACY`,
        category: 'registration',
        claimType: 'SOURCE_CLAIM',
        confidenceInputs: { sourceReliability: 'authoritative', matchType: 'exact' },
        entities: [
          { ref: 'd', type: 'domain', value: domain },
          { ref: 'reg', type: 'organization', value: 'example registrar, inc. (simulated)', display: 'Example Registrar, Inc. (simulated)' },
        ],
        subjectRef: 'd',
        relationships: [{ from: 'd', to: 'reg', type: 'ASSOCIATED_WITH', status: 'confirmed', rationale: 'Sponsoring registrar per RDAP (simulated).' }],
        events: [
          { date: '2015-06-01T00:00:00.000Z', precision: 'day', kind: 'registration', label: `${domain} registered (simulated)`, entityRef: 'd' },
          { date: '2027-06-01T00:00:00.000Z', precision: 'day', kind: 'registration', label: `${domain} registration expires (simulated)`, entityRef: 'd' },
        ],
        assertions: [{ subjectRef: 'd', attribute: 'registrar', value: 'Example Registrar, Inc.' }],
        metadata: { registrar: 'Example Registrar, Inc. (simulated)' },
        raw: { simulated: true, events: [{ eventAction: 'registration', eventDate: '2015-06-01' }] },
      }),
      makeRecord(this, ctx, {
        ...base,
        sourceName: '[SIMULATED] Certificate Transparency',
        sourceUrl: `https://ct.example.org/?q=${domain}`,
        title: `Certificates reveal hostnames vpn.${domain}, dev.${domain}`,
        description: 'Certificate Transparency entries list additional hostnames (historical observations).',
        excerpt: `CN=${domain}; SAN=www.${domain}, vpn.${domain}, dev.${domain}; not_before=2025-01-10`,
        category: 'certificate',
        entities: [
          { ref: 'd', type: 'domain', value: domain },
          { ref: 'vpn', type: 'domain', value: `vpn.${domain}` },
          { ref: 'dev', type: 'domain', value: `dev.${domain}` },
        ],
        subjectRef: 'd',
        relationships: [
          { from: 'd', to: 'vpn', type: 'LINKED_TO', status: 'confirmed', rationale: 'Shared certificate SAN (simulated).' },
          { from: 'd', to: 'dev', type: 'LINKED_TO', status: 'confirmed', rationale: 'Shared certificate SAN (simulated).' },
        ],
        events: [{ date: '2025-01-10T00:00:00.000Z', precision: 'day', kind: 'event', label: `Certificate issued for ${domain} (simulated)`, entityRef: 'd' }],
        metadata: { sans: [`www.${domain}`, `vpn.${domain}`, `dev.${domain}`], historical: true },
        raw: { simulated: true },
      }),
    );
    return { records: recs };
  },
};

// ------------------------------------------------------------------------------------------------------------
// Simulated IP intelligence
// ------------------------------------------------------------------------------------------------------------

export const demoIpIntel: Provider = {
  id: 'demo.ipintel',
  name: 'Simulated IP Intelligence',
  category: 'demo',
  kind: 'simulated',
  reliability: 'reputable',
  description: 'Simulated ASN, approximate geolocation and reputation for IP addresses.',
  operations: [{ id: 'ip_profile', label: 'Simulated IP profile', targetTypes: ['ip'], module: 'ip', minDepth: 'quick' }],
  config: [],
  limitations: [DEMO_LIMITATION, 'IP geolocation is approximate and never an exact physical location.'],
  async run(input, ctx) {
    await simulateLatency(input, ctx, this.id);
    const ip = input.subject.value;
    const rnd = seededRandom(`${ip}:ip`);
    const city = CITIES[Math.floor(rnd() * CITIES.length)]!;
    const asn = 64500 + Math.floor(rnd() * 12);
    return {
      records: [
        makeRecord(this, ctx, {
          sourceName: '[SIMULATED] Routing registry',
          sourceUrl: null,
          title: `${ip} announced by AS${asn} (simulated)`,
          description: `Prefix ${ip.split('.').slice(0, 3).join('.')}.0/24 originated by AS${asn} EXAMPLE-NET.`,
          excerpt: `${asn} | ${ip.split('.').slice(0, 3).join('.')}.0/24 | ${city.cc} | example-rir`,
          entityType: 'ip',
          normalizedValue: ip,
          category: 'network',
          claimType: 'FACT',
          entities: [
            { ref: 'ip', type: 'ip', value: ip },
            { ref: 'asn', type: 'asn', value: `as${asn}`, display: `AS${asn} EXAMPLE-NET (simulated)` },
          ],
          subjectRef: 'ip',
          relationships: [{ from: 'ip', to: 'asn', type: 'HOSTED_ON', status: 'confirmed', rationale: 'BGP origin (simulated).' }],
          assertions: [{ subjectRef: 'ip', attribute: 'country', value: city.cc }],
          metadata: { asn, simulated: true },
          limitations: [DEMO_LIMITATION],
          raw: { simulated: true, asn },
        }),
        makeRecord(this, ctx, {
          sourceName: '[SIMULATED] Geo-IP database',
          sourceUrl: null,
          title: `${ip} geolocates approximately to ${city.place}`,
          description: 'Database estimate for the network block. Approximate; not a physical location of a person or device.',
          excerpt: `country=${city.cc}; city=${city.place}; accuracy_radius_km=50`,
          entityType: 'ip',
          normalizedValue: ip,
          category: 'geolocation',
          claimType: 'SOURCE_CLAIM',
          confidenceInputs: { sourceReliability: 'unknown', matchType: 'exact' },
          entities: [
            { ref: 'ip', type: 'ip', value: ip },
            { ref: 'loc', type: 'location', value: city.place.toLowerCase(), display: city.place },
          ],
          subjectRef: 'ip',
          relationships: [{ from: 'ip', to: 'loc', type: 'LOCATED_IN', status: 'possible', rationale: 'Geo-IP database estimate (simulated).' }],
          geo: { lat: city.lat, lon: city.lon, precision: 'approximate', place: `${city.place} (approx.)`, countryCode: city.cc, basis: 'Geo-IP database estimate with ~50 km accuracy radius (simulated).' },
          assertions: [{ subjectRef: 'ip', attribute: 'country', value: rnd() > 0.5 ? city.cc : 'DE' }],
          metadata: { accuracyRadiusKm: 50, simulated: true },
          limitations: [DEMO_LIMITATION, 'IP geolocation is approximate.'],
          raw: { simulated: true, country: city.cc, city: city.place },
        }),
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------------------------
// Simulated breach catalogue
// ------------------------------------------------------------------------------------------------------------

export const demoBreach: Provider = {
  id: 'demo.breach',
  name: 'Simulated Breach Catalogue',
  category: 'demo',
  kind: 'simulated',
  reliability: 'reputable',
  description: 'Simulated breach-exposure results naming fictional breaches. No real breach data is used.',
  operations: [{ id: 'breach_lookup', label: 'Simulated breach lookup', targetTypes: ['email'], module: 'breach', minDepth: 'standard' }],
  config: [],
  limitations: [DEMO_LIMITATION],
  async run(input, ctx) {
    await simulateLatency(input, ctx, this.id);
    const email = input.subject.value;
    const breaches = [
      { name: 'FictionalForum', date: '2019-07-22', classes: ['Email addresses', 'Usernames'] },
      { name: 'ExampleShop', date: '2022-01-15', classes: ['Email addresses', 'Names'] },
    ];
    return {
      records: breaches.map((b) =>
        makeRecord(this, ctx, {
          sourceName: '[SIMULATED] Breach catalogue',
          sourceUrl: `https://breaches.example.com/${b.name}`,
          title: `${email} appears in the "${b.name}" breach (simulated)`,
          description: `Exposed data classes: ${b.classes.join(', ')}. No passwords or secrets are stored by ATLAS.`,
          excerpt: `breach=${b.name}; breach_date=${b.date}; data_classes=${b.classes.join('|')}`,
          entityType: 'email',
          normalizedValue: email,
          category: 'breach',
          claimType: 'SOURCE_CLAIM',
          entities: [
            { ref: 'e', type: 'email', value: email },
            { ref: 'b', type: 'organization', value: `${b.name.toLowerCase()} (breached service, simulated)`, display: `${b.name} (simulated breached service)` },
          ],
          subjectRef: 'e',
          relationships: [{ from: 'e', to: 'b', type: 'APPEARS_IN', status: 'confirmed', rationale: 'Listed by breach catalogue (simulated).' }],
          events: [{ date: `${b.date}T00:00:00.000Z`, precision: 'day', kind: 'event', label: `${b.name} breach occurred (simulated)`, entityRef: 'e' }],
          metadata: { breach: b.name, dataClasses: b.classes, simulated: true },
          limitations: [DEMO_LIMITATION],
          raw: { simulated: true, ...b },
        }),
      ),
    };
  },
};

// ------------------------------------------------------------------------------------------------------------
// Simulated dark-web index
// ------------------------------------------------------------------------------------------------------------

export const demoDarkweb: Provider = {
  id: 'demo.darkweb',
  name: 'Simulated Dark-web Index',
  category: 'demo',
  kind: 'simulated',
  reliability: 'low',
  description: 'Simulated clearnet index of dark-web forum mentions. No onion services are contacted.',
  operations: [
    { id: 'darkweb_search', label: 'Simulated dark-web mention search', targetTypes: ['email', 'username', 'domain'], module: 'darkweb', minDepth: 'deep' },
  ],
  config: [],
  limitations: [DEMO_LIMITATION, 'Dark-web coverage is inherently partial; absence of results is not evidence of absence.'],
  async run(input, ctx) {
    await simulateLatency(input, ctx, this.id);
    return {
      records: [
        makeRecord(this, ctx, {
          sourceName: '[SIMULATED] Dark-web forum index',
          sourceUrl: `https://darkweb-index.example/mention/${slug(input.subject.value)}`,
          title: `Identifier mentioned in a simulated forum post`,
          description: 'An indexed (simulated) forum post contains the identifier in a list of handles. Context unclear; reliability low.',
          excerpt: `…list of handles: ${input.subject.display}, ${handleFor(input)}_alt…`,
          entityType: SUBJECT_ENTITY[input.subject.type],
          normalizedValue: input.subject.value,
          category: 'darkweb',
          claimType: 'UNVERIFIED_LEAD',
          confidenceInputs: { sourceReliability: 'low', matchType: 'exact' },
          entities: [subjectEntity(input)],
          publishedAt: '2025-05-02T00:00:00.000Z',
          publishedPrecision: 'month',
          events: [{ date: '2025-05-01T00:00:00.000Z', precision: 'month', kind: 'source_published', label: 'Simulated forum post (month approximate)' }],
          metadata: { simulated: true },
          limitations: [DEMO_LIMITATION],
          raw: { simulated: true },
        }),
      ],
    };
  },
};

// ------------------------------------------------------------------------------------------------------------
// Simulated unstable provider — always fails, to exercise partial-completion handling
// ------------------------------------------------------------------------------------------------------------

export const demoUnstable: Provider = {
  id: 'demo.unstable',
  name: 'Simulated Unstable Feed',
  category: 'demo',
  kind: 'simulated',
  reliability: 'unknown',
  description: 'Deliberately failing simulated provider. Demonstrates timeouts, retries and partial completion.',
  operations: [
    { id: 'feed_lookup', label: 'Simulated failing lookup', targetTypes: ['person', 'organization', 'username', 'email', 'domain', 'ip', 'url', 'phone', 'crypto', 'keyword'], module: 'web_search', minDepth: 'standard' },
  ],
  config: [],
  maxRetries: 1,
  limitations: [DEMO_LIMITATION, 'This provider always fails by design.'],
  async run(input, ctx) {
    await sleep(process.env.ATLAS_DEMO_FAST === 'true' ? 10 : 400, ctx.signal);
    throw new ProviderError('timeout', 'Simulated upstream timeout (this demo provider always fails).', true);
  },
};

export const DEMO_PROVIDERS: Provider[] = [demoSearch, demoSearchAlt, demoProfiles, demoInfrastructure, demoIpIntel, demoBreach, demoDarkweb, demoUnstable];
