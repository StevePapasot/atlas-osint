/**
 * Live DNS provider (system resolver or ATLAS_DNS_SERVERS). Passive: queries public DNS only.
 * Produces FACT records about what DNS returned at collection time — not historical state.
 */
import type { NormalizedRecord, Provider, ProviderContext } from '../types';
import { makeRecord } from '../util';
import { analyzeDmarc, analyzeSpf, emailDomainKind, mxIndicators, nsIndicators, txtIndicators, type Indicator } from './fingerprints';
import { isPublicIp } from '@/shared/targets';

const CURRENT_NOTE = 'Reflects DNS answers at collection time; DNS changes over time and may differ by resolver location.';

function indicatorRecords(provider: Provider, ctx: ProviderContext, domain: string, indicators: Indicator[]): NormalizedRecord[] {
  return indicators.map((ind) =>
    makeRecord(provider, ctx, {
      sourceUrl: null,
      title: `${domain}: ${ind.service} indicated by DNS`,
      description:
        ind.category === 'saas_verification'
          ? `A TXT verification token suggests ${domain} was verified with this service at some point. It does not prove current use.`
          : `Public DNS configuration suggests use of ${ind.service}.`,
      excerpt: ind.evidence,
      entityType: 'domain',
      normalizedValue: domain,
      category: 'dns',
      claimType: 'INFERENCE',
      confidenceInputs: { sourceReliability: 'authoritative', matchType: 'normalized', signals: ['dns_pattern'] },
      entities: [
        { ref: 'd', type: 'domain', value: domain },
        { ref: 'svc', type: 'organization', value: ind.service.toLowerCase(), display: ind.service },
      ],
      subjectRef: 'd',
      relationships: [{ from: 'd', to: 'svc', type: 'ASSOCIATED_WITH', status: 'possible', rationale: `Inferred from ${ind.evidence}` }],
      metadata: { indicator: ind },
      fingerprintKey: `indicator:${domain}:${ind.service}`,
      limitations: [CURRENT_NOTE],
    }),
  );
}

async function domainRecords(provider: Provider, ctx: ProviderContext, domain: string): Promise<NormalizedRecord[]> {
  const { dns } = ctx;
  const settled = await Promise.allSettled([
    dns.resolve4(domain),
    dns.resolve6(domain),
    dns.resolveMx(domain),
    dns.resolveNs(domain),
    dns.resolveTxt(domain),
    dns.resolveCaa(domain),
    dns.resolveSoa(domain),
    dns.resolveCname(`www.${domain}`),
  ]);
  const val = <T,>(i: number, fallback: T): T => (settled[i]!.status === 'fulfilled' ? ((settled[i] as PromiseFulfilledResult<T>).value ?? fallback) : fallback);
  const failures = settled.filter((s) => s.status === 'rejected');
  if (failures.length === settled.length) throw (failures[0] as PromiseRejectedResult).reason;

  const a = val<string[]>(0, []);
  const aaaa = val<string[]>(1, []);
  const mx = val<Array<{ exchange: string; priority: number }>>(2, []).sort((x, y) => x.priority - y.priority);
  const ns = val<string[]>(3, []);
  const txt = val<string[][]>(4, []).map((parts) => parts.join(''));
  const caa = val<Array<Record<string, unknown>>>(5, []);
  const soa = val<{ nsname: string; hostmaster: string; serial: number } | null>(6, null);
  const wwwCname = val<string[]>(7, []);
  const records: NormalizedRecord[] = [];
  const base = {
    sourceName: 'DNS (live resolver)',
    sourceUrl: null,
    entityType: 'domain' as const,
    normalizedValue: domain,
    category: 'dns' as const,
    claimType: 'FACT' as const,
    limitations: [CURRENT_NOTE],
  };

  if (a.length || aaaa.length) {
    const ips = [...a, ...aaaa];
    records.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `${domain} resolves to ${ips.slice(0, 4).join(', ')}${ips.length > 4 ? ` (+${ips.length - 4})` : ''}`,
        description: `${a.length} A and ${aaaa.length} AAAA record(s) observed.`,
        excerpt: [...a.map((ip) => `${domain}. IN A ${ip}`), ...aaaa.map((ip) => `${domain}. IN AAAA ${ip}`)].join('\n'),
        entities: [{ ref: 'd', type: 'domain', value: domain }, ...ips.map((ip, i) => ({ ref: `ip${i}`, type: 'ip' as const, value: ip, attributes: { public: isPublicIp(ip) } }))],
        subjectRef: 'd',
        relationships: ips.map((_, i) => ({ from: 'd', to: `ip${i}`, type: 'RESOLVES_TO' as const, status: 'confirmed' as const, rationale: 'Live A/AAAA record.' })),
        metadata: { A: a, AAAA: aaaa },
        fingerprintKey: `dns:${domain}:address`,
        raw: { A: a, AAAA: aaaa },
      }),
    );
  } else {
    records.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `${domain} has no A/AAAA records`,
        description: 'No address records were returned at collection time (the name may not be used for web hosting).',
        excerpt: 'A: (none); AAAA: (none)',
        metadata: { A: [], AAAA: [] },
        fingerprintKey: `dns:${domain}:address`,
        raw: { A: [], AAAA: [] },
      }),
    );
  }

  if (mx.length) {
    records.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `${domain} mail exchangers: ${mx.slice(0, 3).map((m) => m.exchange).join(', ')}`,
        description: `${mx.length} MX record(s).`,
        excerpt: mx.map((m) => `${domain}. IN MX ${m.priority} ${m.exchange}`).join('\n'),
        entities: [{ ref: 'd', type: 'domain', value: domain }, ...mx.map((m, i) => ({ ref: `mx${i}`, type: 'domain' as const, value: m.exchange.toLowerCase().replace(/\.$/, '') }))],
        subjectRef: 'd',
        relationships: mx.map((_, i) => ({ from: 'd', to: `mx${i}`, type: 'LINKED_TO' as const, status: 'confirmed' as const, rationale: 'MX record (mail exchanger).' })),
        metadata: { MX: mx },
        fingerprintKey: `dns:${domain}:mx`,
        raw: { MX: mx },
      }),
    );
  }

  if (ns.length) {
    records.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `${domain} delegated to ${ns.slice(0, 3).join(', ')}`,
        description: `${ns.length} authoritative name server(s).`,
        excerpt: ns.map((n) => `${domain}. IN NS ${n}`).join('\n'),
        entities: [{ ref: 'd', type: 'domain', value: domain }, ...ns.map((n, i) => ({ ref: `ns${i}`, type: 'domain' as const, value: n.toLowerCase().replace(/\.$/, '') }))],
        subjectRef: 'd',
        relationships: ns.map((_, i) => ({ from: 'd', to: `ns${i}`, type: 'LINKED_TO' as const, status: 'confirmed' as const, rationale: 'NS delegation.' })),
        metadata: { NS: ns, SOA: soa },
        fingerprintKey: `dns:${domain}:ns`,
        raw: { NS: ns, SOA: soa },
      }),
    );
  }

  if (txt.length) {
    records.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `${domain} publishes ${txt.length} TXT record(s)`,
        description: 'TXT records often contain mail policy and third-party verification tokens.',
        excerpt: txt.map((t) => `"${t.length > 160 ? t.slice(0, 160) + '…' : t}"`).join('\n'),
        metadata: { TXT: txt },
        fingerprintKey: `dns:${domain}:txt`,
        raw: { TXT: txt },
      }),
    );
  }

  if (caa.length) {
    const issuers = caa.map((c) => String(c.issue ?? c.issuewild ?? '')).filter(Boolean);
    records.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `${domain} restricts certificate issuance (CAA): ${issuers.join(', ') || 'policy present'}`,
        description: 'CAA records list the certificate authorities permitted to issue certificates.',
        excerpt: caa.map((c) => JSON.stringify(c)).join('\n'),
        metadata: { CAA: caa },
        fingerprintKey: `dns:${domain}:caa`,
        raw: { CAA: caa },
      }),
    );
  }

  if (wwwCname.length) {
    const target = wwwCname[0]!.toLowerCase().replace(/\.$/, '');
    records.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `www.${domain} is an alias (CNAME) for ${target}`,
        description: 'CNAME targets often reveal hosting or CDN providers.',
        excerpt: `www.${domain}. IN CNAME ${target}`,
        entities: [
          { ref: 'd', type: 'domain', value: domain },
          { ref: 'www', type: 'domain', value: `www.${domain}` },
          { ref: 't', type: 'domain', value: target },
        ],
        subjectRef: 'd',
        relationships: [
          { from: 'd', to: 'www', type: 'LINKED_TO', status: 'confirmed', rationale: 'Subdomain.' },
          { from: 'www', to: 't', type: 'RESOLVES_TO', status: 'confirmed', rationale: 'CNAME record.' },
        ],
        metadata: { CNAME: wwwCname },
        fingerprintKey: `dns:${domain}:www-cname`,
        raw: { CNAME: wwwCname },
      }),
    );
  }

  records.push(
    ...indicatorRecords(provider, ctx, domain, [
      ...mxIndicators(mx.map((m) => m.exchange)),
      ...nsIndicators(ns),
      ...txtIndicators(txt),
    ]),
  );
  return records;
}

async function mailPolicy(provider: Provider, ctx: ProviderContext, domain: string): Promise<NormalizedRecord[]> {
  const settled = await Promise.allSettled([
    ctx.dns.resolveTxt(domain),
    ctx.dns.resolveTxt(`_dmarc.${domain}`),
    ctx.dns.resolveTxt(`_mta-sts.${domain}`),
    ctx.dns.resolveTxt(`_smtp._tls.${domain}`),
  ]);
  if (settled[0].status === 'rejected' && settled[1].status === 'rejected') throw settled[0].reason;
  const pick = (i: number) => (settled[i]!.status === 'fulfilled' ? (settled[i] as PromiseFulfilledResult<string[][]>).value : null);
  const txt = pick(0);
  const dmarcTxt = pick(1);
  const mtaSts = pick(2) ?? [];
  const tlsRpt = pick(3) ?? [];
  const spf = txt ? analyzeSpf(txt.map((p) => p.join(''))) : [];
  const dmarc = dmarcTxt ? analyzeDmarc(dmarcTxt.map((p) => p.join(''))) : null;
  const base = {
    sourceName: 'DNS (live resolver)',
    sourceUrl: null,
    entityType: 'domain' as const,
    normalizedValue: domain,
    category: 'dns' as const,
    claimType: 'FACT' as const,
    limitations: [CURRENT_NOTE],
  };
  const out: NormalizedRecord[] = [];
  if (txt) out.push(
    makeRecord(provider, ctx, {
      ...base,
      title: spf.length ? `SPF for ${domain}: ${spf[0]!.assessment}` : `${domain} publishes no SPF record`,
      description: spf.length
        ? `Includes: ${spf[0]!.includes.join(', ') || 'none'}.${spf.length > 1 ? ' Multiple SPF records found — this is invalid per RFC 7208.' : ''}`
        : 'Without SPF, receivers cannot check which servers may send mail for this domain.',
      excerpt: spf.map((s) => s.record).join('\n') || '(no v=spf1 TXT record)',
      metadata: { spf },
      fingerprintKey: `mail:${domain}:spf`,
      raw: { spf },
    }),
  );
  if (dmarcTxt) out.push(
    makeRecord(provider, ctx, {
      ...base,
      title: dmarc ? `DMARC for ${domain}: ${dmarc.assessment}` : `${domain} publishes no DMARC record`,
      description: dmarc
        ? `Aggregate reports to: ${dmarc.rua.join(', ') || 'not configured'}.`
        : 'No _dmarc TXT record: the domain has no published DMARC policy.',
      excerpt: dmarc?.record ?? '(no _dmarc TXT record)',
      metadata: { dmarc },
      fingerprintKey: `mail:${domain}:dmarc`,
      raw: { dmarc },
    }),
  );
  const mtaRecord = mtaSts.map((p) => p.join('')).find((r) => /^v=STSv1/i.test(r));
  const tlsRecord = tlsRpt.map((p) => p.join('')).find((r) => /^v=TLSRPTv1/i.test(r));
  if (mtaRecord || tlsRecord) {
    out.push(
      makeRecord(provider, ctx, {
        ...base,
        title: `${domain} publishes ${[mtaRecord && 'MTA-STS', tlsRecord && 'TLS-RPT'].filter(Boolean).join(' and ')}`,
        description: 'Transport security policies for inbound mail.',
        excerpt: [mtaRecord, tlsRecord].filter(Boolean).join('\n'),
        metadata: { mtaSts: mtaRecord ?? null, tlsRpt: tlsRecord ?? null },
        fingerprintKey: `mail:${domain}:transport`,
      }),
    );
  }
  return out;
}

export const dnsProvider: Provider = {
  id: 'dns',
  name: 'DNS resolver',
  category: 'domain',
  kind: 'live',
  reliability: 'authoritative',
  description: 'Live DNS lookups (A, AAAA, MX, NS, TXT, CAA, SOA, CNAME), SPF/DMARC/MTA-STS analysis and passive technology indicators.',
  docsUrl: 'https://nodejs.org/api/dns.html',
  operations: [
    { id: 'dns_records', label: 'DNS records & technology indicators', targetTypes: ['domain'], module: 'domain', minDepth: 'quick' },
    { id: 'mail_policy', label: 'Mail security policy (SPF, DMARC, MTA-STS)', targetTypes: ['domain'], module: 'domain', minDepth: 'standard' },
    { id: 'email_domain', label: 'Email domain profile', targetTypes: ['email'], module: 'email', minDepth: 'quick' },
  ],
  config: [{ env: 'ATLAS_DNS_SERVERS', label: 'Custom resolvers (comma separated)', optional: true }],
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 8,
  limitations: [CURRENT_NOTE, 'No historical DNS. Historical data requires a passive-DNS provider.'],
  async run(input, ctx) {
    if (input.operation === 'email_domain') {
      const email = input.subject.value;
      const domain = email.split('@')[1]!;
      const kind = emailDomainKind(domain);
      const mx = await ctx.dns.resolveMx(domain);
      const indicators = mxIndicators(mx.map((m) => m.exchange));
      const records: NormalizedRecord[] = [
        makeRecord(this, ctx, {
          sourceName: 'DNS (live resolver)',
          sourceUrl: null,
          title: mx.length
            ? `${domain} accepts mail (${indicators[0]?.service ?? mx[0]!.exchange})`
            : `${domain} has no MX records — the address may not receive mail`,
          description: `Email domain classified as ${kind}. ${
            kind === 'free'
              ? 'Free webmail domains say little about the account holder.'
              : kind === 'disposable'
                ? 'Disposable mailbox services are often used to avoid attribution.'
                : 'Organizational domains may link the address to an organization; verify independently.'
          } MX presence does not prove that this specific mailbox exists.`,
          excerpt: mx.map((m) => `${domain}. IN MX ${m.priority} ${m.exchange}`).join('\n') || '(no MX records)',
          entityType: 'email',
          normalizedValue: email,
          category: 'dns',
          claimType: 'FACT',
          entities: [
            { ref: 'e', type: 'email', value: email },
            { ref: 'd', type: 'domain', value: domain, attributes: { emailDomainKind: kind } },
          ],
          subjectRef: 'e',
          relationships: [{ from: 'e', to: 'd', type: 'LINKED_TO', status: 'confirmed', rationale: 'Email address domain part.' }],
          metadata: { domain, kind, mx, indicators },
          fingerprintKey: `email-domain:${email}`,
          limitations: [CURRENT_NOTE, 'Mailbox existence is not tested (no SMTP probing).'],
          raw: { mx },
        }),
      ];
      return { records };
    }
    const domain = input.subject.value;
    if (input.operation === 'mail_policy') return { records: await mailPolicy(this, ctx, domain) };
    return { records: await domainRecords(this, ctx, domain) };
  },
  async healthCheck(ctx) {
    const t = Date.now();
    const r = await ctx.dns.resolveNs('iana.org');
    return r.length
      ? { status: 'healthy', message: `Resolved NS for iana.org (${r.length} records).`, latencyMs: Date.now() - t }
      : { status: 'degraded', message: 'Resolver returned no data for iana.org.', latencyMs: Date.now() - t };
  },
};
