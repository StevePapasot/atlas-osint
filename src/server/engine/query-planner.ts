/**
 * Search-planning engine: turns a target (plus investigation context) into a bounded list of search queries.
 * Pure and deterministic so it can be unit-tested and so plans are reproducible.
 */
import type { Depth, TargetType } from '@/shared/domain';

export interface PlannedQuery {
  query: string;
  purpose: 'exact' | 'profiles' | 'documents' | 'association' | 'infrastructure' | 'mentions' | 'code';
  rationale: string;
}

export interface PlanContext {
  depth: Exclude<Depth, 'custom'>;
  related: Array<{ type: TargetType; value: string; display: string }>;
  scope?: string | null;
}

const LIMITS: Record<PlanContext['depth'], number> = { quick: 2, standard: 5, deep: 9 };

const q = (s: string) => `"${s.replace(/"/g, '')}"`;

function relatedOf(ctx: PlanContext, type: TargetType): string[] {
  return ctx.related.filter((r) => r.type === type).map((r) => r.display);
}

export function planQueries(type: TargetType, value: string, display: string, ctx: PlanContext): PlannedQuery[] {
  const out: PlannedQuery[] = [];
  const add = (query: string, purpose: PlannedQuery['purpose'], rationale: string) => {
    if (!out.some((p) => p.query === query)) out.push({ query, purpose, rationale });
  };
  const orgs = relatedOf(ctx, 'organization');
  const people = relatedOf(ctx, 'person');
  const usernames = relatedOf(ctx, 'username');
  const emails = relatedOf(ctx, 'email');
  const domains = relatedOf(ctx, 'domain');

  switch (type) {
    case 'username': {
      add(q(display), 'exact', 'Exact username match.');
      add(`${q(display)} (profile OR account OR user)`, 'profiles', 'Username plus public-profile terms.');
      add(`${q(display)} site:github.com`, 'code', 'Username on GitHub.');
      add(`${q(display)} (forum OR community OR discussion)`, 'mentions', 'Username on forums.');
      for (const e of emails.slice(0, 1)) add(`${q(display)} ${q(e)}`, 'association', 'Username co-occurring with a related email.');
      for (const p of people.slice(0, 1)) add(`${q(display)} ${q(p)}`, 'association', 'Username co-occurring with a related name.');
      add(`${q(display)} (filetype:pdf OR filetype:doc OR filetype:docx)`, 'documents', 'Username in public documents.');
      add(`${q(display)} site:reddit.com`, 'profiles', 'Username on Reddit.');
      add(`${q(display)} (mastodon OR bsky.app)`, 'profiles', 'Username on federated/social platforms.');
      break;
    }
    case 'email': {
      const [local, domain] = value.split('@') as [string, string];
      add(q(value), 'exact', 'Exact email address.');
      add(`${q(value)} -site:${domain}`, 'mentions', 'Mentions outside the email’s own domain.');
      add(`${q(value)} (filetype:pdf OR filetype:docx OR filetype:xlsx OR filetype:csv)`, 'documents', 'Email in public documents.');
      add(`${q(value)} site:github.com`, 'code', 'Email in public code / commits.');
      add(`${q(local)} ${q(domain)}`, 'association', 'Local part with domain (obfuscated forms).');
      for (const u of usernames.slice(0, 1)) add(`${q(value)} ${q(u)}`, 'association', 'Email with related username.');
      add(`${q(value)} (forum OR profile)`, 'profiles', 'Email on forum or profile pages.');
      break;
    }
    case 'domain': {
      add(`site:${value}`, 'infrastructure', 'Indexed pages on the domain.');
      add(`${q(value)} -site:${value}`, 'mentions', 'Public references to the domain from other sites.');
      add(`site:${value} (filetype:pdf OR filetype:docx OR filetype:xlsx)`, 'documents', 'Documents hosted on the domain.');
      for (const o of orgs.slice(0, 2)) add(`${q(value)} ${q(o)}`, 'association', 'Domain with related organization.');
      add(`${q(value)} (certificate OR "DNS" OR subdomain)`, 'infrastructure', 'Certificate and DNS discussions.');
      add(`${q(value)} (breach OR leak OR phishing)`, 'mentions', 'Security-incident reporting mentioning the domain.');
      add(`site:*.${value} -site:www.${value}`, 'infrastructure', 'Indexed subdomains.');
      break;
    }
    case 'person': {
      add(q(display), 'exact', 'Exact name.');
      for (const o of orgs.slice(0, 2)) add(`${q(display)} ${q(o)}`, 'association', 'Name with known organization.');
      for (const u of usernames.slice(0, 1)) add(`${q(display)} ${q(u)}`, 'association', 'Name with known username.');
      for (const d of domains.slice(0, 1)) add(`${q(display)} ${q(d)}`, 'association', 'Name with known domain.');
      if (ctx.scope) {
        const loc = ctx.scope.match(/\b(?:in|from|based in|located in)\s+([A-Z][\p{L}\s,-]{2,40})/u)?.[1]?.trim();
        if (loc) add(`${q(display)} ${q(loc)}`, 'association', 'Name with location stated in the scope.');
      }
      add(`${q(display)} (filetype:pdf OR filetype:docx)`, 'documents', 'Name in public documents.');
      add(`${q(display)} (linkedin OR profile OR biography)`, 'profiles', 'Public professional profiles.');
      add(`${q(display)} (interview OR speaker OR conference)`, 'mentions', 'Public appearances.');
      break;
    }
    case 'organization': {
      add(q(display), 'exact', 'Exact organization name.');
      for (const d of domains.slice(0, 2)) add(`${q(display)} site:${d}`, 'association', 'Organization on its known domain.');
      add(`${q(display)} (annual report OR filing) filetype:pdf`, 'documents', 'Corporate documents.');
      add(`${q(display)} (breach OR incident OR lawsuit)`, 'mentions', 'Incidents and legal mentions.');
      add(`${q(display)} (employees OR staff OR team)`, 'association', 'Public staff references.');
      add(`${q(display)} (registry OR "company number" OR incorporated)`, 'infrastructure', 'Registry references.');
      break;
    }
    case 'ip': {
      add(q(value), 'exact', 'Exact IP address.');
      add(`${q(value)} (abuse OR malware OR botnet OR phishing)`, 'mentions', 'IP in threat reporting.');
      add(`${q(value)} (log OR blocklist)`, 'mentions', 'IP in public logs or blocklists.');
      break;
    }
    case 'url': {
      add(q(value), 'exact', 'Exact URL references.');
      add(`${q(value)} (phishing OR malware OR scam)`, 'mentions', 'URL in threat reporting.');
      break;
    }
    case 'phone': {
      add(q(display), 'exact', 'International format.');
      add(q(value), 'exact', 'E.164 format.');
      add(`${q(display)} (scam OR spam OR fraud)`, 'mentions', 'Number in scam reports.');
      for (const o of orgs.slice(0, 1)) add(`${q(display)} ${q(o)}`, 'association', 'Number with related organization.');
      break;
    }
    case 'crypto': {
      add(q(value), 'exact', 'Exact address.');
      add(`${q(value)} (scam OR ransomware OR fraud OR donation)`, 'mentions', 'Address in public reporting.');
      break;
    }
    case 'keyword':
    case 'document':
    case 'image': {
      add(q(display), 'exact', 'Exact phrase.');
      add(`${q(display)} filetype:pdf`, 'documents', 'Phrase in documents.');
      break;
    }
  }
  return out.slice(0, LIMITS[ctx.depth]);
}
