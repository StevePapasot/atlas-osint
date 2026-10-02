import { describe, expect, it } from 'vitest';
import { analyzeDmarc, analyzeSpf, emailDomainKind, mxIndicators, nsIndicators, txtIndicators } from '@/server/providers/domain/fingerprints';

describe('DNS-derived indicators', () => {
  it('identifies mail and DNS hosting providers', () => {
    expect(mxIndicators(['aspmx.l.google.com.', 'alt1.aspmx.l.google.com']).map((i) => i.service)).toEqual(['Google Workspace']);
    expect(mxIndicators(['example-com.mail.protection.outlook.com'])[0]!.service).toMatch(/Microsoft 365/);
    expect(nsIndicators(['diva.ns.cloudflare.com', 'ns-1.awsdns-01.org'])).toHaveLength(2);
  });
  it('labels verification tokens and SPF includes', () => {
    const ind = txtIndicators(['google-site-verification=abc', 'MS=ms123456', 'v=spf1 include:_spf.google.com include:sendgrid.net ~all']);
    const services = ind.map((i) => i.service);
    expect(services).toContain('Google Search Console / Workspace verification');
    expect(services).toContain('Microsoft 365 domain verification');
    expect(services).toContain('SendGrid');
  });
  it('analyses SPF qualifiers', () => {
    expect(analyzeSpf(['v=spf1 -all'])[0]!.allQualifier).toBe('-');
    expect(analyzeSpf(['v=spf1 include:x.example ~all'])[0]).toMatchObject({ allQualifier: '~', includes: ['x.example'] });
    expect(analyzeSpf(['v=spf1 +all'])[0]!.assessment).toMatch(/misconfiguration/);
    expect(analyzeSpf(['not spf'])).toHaveLength(0);
  });
  it('analyses DMARC policies', () => {
    expect(analyzeDmarc(['v=DMARC1; p=reject; rua=mailto:a@example.org'])).toMatchObject({ policy: 'reject', rua: ['mailto:a@example.org'] });
    expect(analyzeDmarc(['v=DMARC1; p=none'])!.assessment).toMatch(/Monitoring only/);
    expect(analyzeDmarc(['v=spf1 -all'])).toBeNull();
  });
  it('classifies email domains', () => {
    expect(emailDomainKind('gmail.com')).toBe('free');
    expect(emailDomainKind('mailinator.com')).toBe('disposable');
    expect(emailDomainKind('example.org')).toBe('organizational');
  });
});
