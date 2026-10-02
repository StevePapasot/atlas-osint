/**
 * Indicator and named-entity extraction from untrusted text (documents, OCR output).
 * Text is only pattern-matched — never executed, rendered as HTML, or interpreted as instructions.
 */
import nlp from 'compromise';
import { findPhoneNumbersInText, type CountryCode } from 'libphonenumber-js';
import { isPublicIp, normalizeCrypto, normalizeDomain, normalizeEmail, normalizeUrl } from '@/shared/targets';

export interface Extracted {
  emails: string[];
  urls: string[];
  domains: string[];
  ips: string[];
  phones: string[];
  crypto: Array<{ address: string; chain: string }>;
  people: string[];
  organizations: string[];
  places: string[];
  dates: Array<{ text: string; iso: string; precision: 'day' | 'month' | 'year' }>;
}

const MAX_NLP_CHARS = 60_000;
const uniq = <T,>(arr: T[], limit = 50) => [...new Set(arr)].slice(0, limit);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function extractDates(text: string, limit = 40): Extracted['dates'] {
  const out: Extracted['dates'] = [];
  const seen = new Set<string>();
  const push = (t: string, y: number, m: number | null, d: number | null) => {
    if (y < 1900 || y > 2100 || (m !== null && (m < 1 || m > 12)) || (d !== null && (d < 1 || d > 31))) return;
    const iso = `${y}-${String(m ?? 1).padStart(2, '0')}-${String(d ?? 1).padStart(2, '0')}T00:00:00.000Z`;
    const key = `${iso}|${d ? 'day' : m ? 'month' : 'year'}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: t, iso, precision: d ? 'day' : m ? 'month' : 'year' });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) push(m[0], +m[1]!, +m[2]!, +m[3]!);
  const monthRe = MONTHS.join('|');
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${monthRe})\\s+(\\d{4})\\b`, 'gi'))) push(m[0], +m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!);
  for (const m of text.matchAll(new RegExp(`\\b(${monthRe})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'gi'))) push(m[0], +m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!);
  for (const m of text.matchAll(new RegExp(`\\b(${monthRe})\\s+(\\d{4})\\b`, 'gi'))) push(m[0], +m[2]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, null);
  return out.slice(0, limit);
}

export function extractEntities(text: string, opts: { defaultCountry?: string } = {}): Extracted {
  const t = text.slice(0, 2_000_000);
  const emails = uniq((t.match(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}/gi) ?? []).map((e) => normalizeEmail(e)?.email).filter((e): e is string => Boolean(e)));
  const urls = uniq((t.match(/\bhttps?:\/\/[^\s"'<>()[\]{}]{3,2000}/gi) ?? []).map((u) => normalizeUrl(u.replace(/[.,;:!?]+$/, ''))?.url).filter((u): u is string => Boolean(u)));
  const domainCandidates = [
    ...urls.map((u) => new URL(u).hostname),
    ...emails.map((e) => e.split('@')[1]!),
    ...(t.match(/\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|gov|edu|co|uk|de|fr|eu|info|biz|dev|app|ai|ru|cn|nl|pt|es|it|ca|au|ch|se|no|pl|br|in|jp|us)\b/gi) ?? []),
  ];
  const domains = uniq(domainCandidates.map((d) => normalizeDomain(d)).filter((d): d is string => Boolean(d)));
  const ips = uniq((t.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []).filter((ip) => isPublicIp(ip)));
  let phones: string[] = [];
  try {
    phones = uniq(
      findPhoneNumbersInText(t.slice(0, 300_000), opts.defaultCountry ? { defaultCountry: opts.defaultCountry as CountryCode } : undefined)
        .filter((p) => p.number.isValid())
        .map((p) => p.number.number as string),
      30,
    );
  } catch {
    phones = [];
  }
  const crypto = uniq(
    (t.match(/\b(?:bc1[0-9a-z]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34}|0x[0-9a-fA-F]{40})\b/g) ?? [])
      .map((c) => normalizeCrypto(c))
      .filter((c): c is NonNullable<typeof c> => Boolean(c))
      .map((c) => JSON.stringify({ address: c.address, chain: c.chain })),
    20,
  ).map((s) => JSON.parse(s) as { address: string; chain: string });

  const doc = nlp(t.slice(0, MAX_NLP_CHARS));
  const clean = (arr: string[]) =>
    uniq(
      arr
        .map((s) => s.replace(/[^\p{L}\p{N}&.'’ -]/gu, '').replace(/\s+/g, ' ').trim())
        .filter((s) => s.length >= 3 && s.length <= 80 && /\p{Lu}/u.test(s)),
      30,
    );
  return {
    emails,
    urls,
    domains,
    ips,
    phones,
    crypto,
    people: clean(doc.people().out('array') as string[]).filter((p) => p.includes(' ')),
    organizations: clean(doc.organizations().out('array') as string[]),
    places: clean(doc.places().out('array') as string[]),
    dates: extractDates(t),
  };
}
