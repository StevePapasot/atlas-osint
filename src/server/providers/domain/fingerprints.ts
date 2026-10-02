/**
 * Passive technology indicators derived from public DNS records.
 * These are INFERENCES: a TXT verification token shows a domain was once verified with a service,
 * not that the service is currently in use.
 */
export interface Indicator {
  service: string;
  category: 'email' | 'dns_hosting' | 'saas_verification' | 'email_sending' | 'cdn';
  evidence: string;
}

const MX_RULES: Array<[RegExp, string]> = [
  [/(aspmx\.l\.google\.com|googlemail\.com|smtp\.google\.com)\.?$/i, 'Google Workspace'],
  [/mail\.protection\.outlook\.com\.?$/i, 'Microsoft 365 (Exchange Online)'],
  [/zoho\.(com|eu|in)\.?$/i, 'Zoho Mail'],
  [/protonmail\.ch\.?$/i, 'Proton Mail'],
  [/mimecast\.com\.?$/i, 'Mimecast'],
  [/pphosted\.com\.?$/i, 'Proofpoint'],
  [/messagelabs\.com\.?$/i, 'Broadcom Email Security.cloud'],
  [/barracudanetworks\.com\.?$/i, 'Barracuda'],
  [/mx\.cloudflare\.net\.?$/i, 'Cloudflare Email Routing'],
  [/fastmail\.com\.?$/i, 'Fastmail'],
  [/icloud\.com\.?$/i, 'iCloud Mail'],
  [/yandex\.(net|ru)\.?$/i, 'Yandex Mail'],
  [/secureserver\.net\.?$/i, 'GoDaddy Email'],
  [/amazonaws\.com\.?$/i, 'Amazon SES / WorkMail'],
];

const NS_RULES: Array<[RegExp, string]> = [
  [/\.ns\.cloudflare\.com\.?$/i, 'Cloudflare DNS'],
  [/awsdns-\d+\./i, 'Amazon Route 53'],
  [/azure-dns\./i, 'Azure DNS'],
  [/(googledomains\.com|ns-cloud-[a-z]\d*\.googledomains\.com|google\.com)\.?$/i, 'Google Cloud DNS'],
  [/nsone\.net\.?$/i, 'NS1'],
  [/dnsimple\.com\.?$/i, 'DNSimple'],
  [/domaincontrol\.com\.?$/i, 'GoDaddy DNS'],
  [/registrar-servers\.com\.?$/i, 'Namecheap DNS'],
  [/dynect\.net\.?$/i, 'Oracle Dyn'],
  [/akam\.net\.?$/i, 'Akamai Edge DNS'],
  [/ultradns\.(com|net|org|biz|info)\.?$/i, 'Vercara UltraDNS'],
  [/hetzner\.(com|de)\.?$/i, 'Hetzner DNS'],
  [/digitalocean\.com\.?$/i, 'DigitalOcean DNS'],
  [/vercel-dns\.com\.?$/i, 'Vercel DNS'],
];

const TXT_RULES: Array<[RegExp, string]> = [
  [/^google-site-verification=/i, 'Google Search Console / Workspace verification'],
  [/^MS=ms\d+/i, 'Microsoft 365 domain verification'],
  [/^facebook-domain-verification=/i, 'Meta (Facebook) domain verification'],
  [/^atlassian-domain-verification=/i, 'Atlassian domain verification'],
  [/^apple-domain-verification=/i, 'Apple domain verification'],
  [/^docusign=/i, 'DocuSign domain verification'],
  [/^stripe-verification=/i, 'Stripe domain verification'],
  [/^ZOOM_verify_/i, 'Zoom domain verification'],
  [/^slack-domain-verification=/i, 'Slack domain verification'],
  [/^adobe-idp-site-verification=/i, 'Adobe identity verification'],
  [/^globalsign-domain-verification=/i, 'GlobalSign certificate verification'],
  [/^_?globalsign/i, 'GlobalSign certificate verification'],
  [/^dropbox-domain-verification=/i, 'Dropbox domain verification'],
  [/^miro-verification=/i, 'Miro domain verification'],
  [/^openai-domain-verification=/i, 'OpenAI domain verification'],
  [/^anthropic-domain-verification/i, 'Anthropic domain verification'],
  [/^hubspot-developer-verification=/i, 'HubSpot verification'],
  [/^knowbe4-site-verification=/i, 'KnowBe4 verification'],
  [/^cisco-ci-domain-verification=/i, 'Cisco Webex verification'],
  [/^onetrust-domain-verification=/i, 'OneTrust verification'],
  [/^status-page-domain-verification=/i, 'Atlassian Statuspage verification'],
  [/^teamviewer-sso-verification=/i, 'TeamViewer SSO verification'],
  [/^yandex-verification:/i, 'Yandex Webmaster verification'],
  [/^have-i-been-pwned-verification=/i, 'Have I Been Pwned domain verification'],
  [/^v=spf1/i, 'SPF policy present'],
];

const SPF_INCLUDE_RULES: Array<[RegExp, string]> = [
  [/_spf\.google\.com/i, 'Google Workspace (sending)'],
  [/spf\.protection\.outlook\.com/i, 'Microsoft 365 (sending)'],
  [/sendgrid\.net/i, 'SendGrid'],
  [/mailgun\.org/i, 'Mailgun'],
  [/servers\.mcsv\.net/i, 'Mailchimp'],
  [/amazonses\.com/i, 'Amazon SES'],
  [/_spf\.salesforce\.com/i, 'Salesforce'],
  [/spf\.mandrillapp\.com/i, 'Mandrill'],
  [/mktomail\.com/i, 'Adobe Marketo'],
  [/hubspotemail\.net|_spf\.hubspot/i, 'HubSpot'],
  [/zendesk\.com/i, 'Zendesk'],
  [/sparkpostmail\.com/i, 'SparkPost'],
  [/_spf\.atlassian\.net/i, 'Atlassian'],
  [/postmarkapp\.com/i, 'Postmark'],
];

export function mxIndicators(exchanges: string[]): Indicator[] {
  const out = new Map<string, Indicator>();
  for (const mx of exchanges) {
    for (const [re, service] of MX_RULES) {
      if (re.test(mx) && !out.has(service)) out.set(service, { service, category: 'email', evidence: `MX ${mx}` });
    }
  }
  return [...out.values()];
}

export function nsIndicators(nameservers: string[]): Indicator[] {
  const out = new Map<string, Indicator>();
  for (const ns of nameservers) {
    for (const [re, service] of NS_RULES) {
      if (re.test(ns) && !out.has(service)) out.set(service, { service, category: 'dns_hosting', evidence: `NS ${ns}` });
    }
  }
  return [...out.values()];
}

export function txtIndicators(txt: string[]): Indicator[] {
  const out = new Map<string, Indicator>();
  for (const record of txt) {
    for (const [re, service] of TXT_RULES) {
      if (service === 'SPF policy present') continue;
      if (re.test(record) && !out.has(service)) {
        out.set(service, { service, category: 'saas_verification', evidence: `TXT "${record.slice(0, 80)}${record.length > 80 ? '…' : ''}"` });
      }
    }
    if (/^v=spf1/i.test(record)) {
      for (const [re, service] of SPF_INCLUDE_RULES) {
        if (re.test(record) && !out.has(service)) out.set(service, { service, category: 'email_sending', evidence: 'SPF include' });
      }
    }
  }
  return [...out.values()];
}

export interface SpfAnalysis {
  record: string;
  allQualifier: '+' | '-' | '~' | '?' | null;
  includes: string[];
  mechanisms: number;
  assessment: string;
}

export function analyzeSpf(records: string[]): SpfAnalysis[] {
  return records
    .filter((r) => /^v=spf1(\s|$)/i.test(r))
    .map((record) => {
      const terms = record.split(/\s+/).slice(1);
      const all = terms.find((t) => /^[+\-~?]?all$/i.test(t));
      const allQualifier = all ? ((/^[+\-~?]/.test(all) ? all[0] : '+') as SpfAnalysis['allQualifier']) : null;
      const includes = terms.filter((t) => /^[+\-~?]?include:/i.test(t)).map((t) => t.replace(/^[+\-~?]?include:/i, ''));
      const assessment =
        allQualifier === '-'
          ? 'Hard fail (-all): unauthorised senders should be rejected.'
          : allQualifier === '~'
            ? 'Soft fail (~all): unauthorised senders are flagged, not rejected.'
            : allQualifier === '?'
              ? 'Neutral (?all): SPF provides no protection.'
              : allQualifier === '+'
                ? 'Pass-all (+all): any server may send — a misconfiguration.'
                : 'No "all" mechanism: policy result defaults to neutral.';
      return { record, allQualifier, includes, mechanisms: terms.length, assessment };
    });
}

export interface DmarcAnalysis {
  record: string;
  policy: string | null;
  subdomainPolicy: string | null;
  pct: number | null;
  rua: string[];
  assessment: string;
}

export function analyzeDmarc(records: string[]): DmarcAnalysis | null {
  const record = records.find((r) => /^v=DMARC1/i.test(r));
  if (!record) return null;
  const tags = Object.fromEntries(
    record
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()];
      }),
  ) as Record<string, string>;
  const policy = tags.p?.toLowerCase() ?? null;
  return {
    record,
    policy,
    subdomainPolicy: tags.sp?.toLowerCase() ?? null,
    pct: tags.pct ? Number(tags.pct) : null,
    rua: (tags.rua ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    assessment:
      policy === 'reject'
        ? 'Enforced (p=reject).'
        : policy === 'quarantine'
          ? 'Partially enforced (p=quarantine).'
          : policy === 'none'
            ? 'Monitoring only (p=none): spoofed mail is not blocked by DMARC.'
            : 'Policy tag missing or invalid.',
  };
}

const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com',
  'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'gmx.de', 'web.de', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'fastmail.com', 'tutanota.com', 'tuta.io', 'hey.com', 'mail.ru', 'qq.com', '163.com',
]);

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com',
  'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com',
]);

export function emailDomainKind(domain: string): 'free' | 'disposable' | 'organizational' {
  if (DISPOSABLE.has(domain)) return 'disposable';
  if (FREE_MAIL.has(domain)) return 'free';
  return 'organizational';
}
