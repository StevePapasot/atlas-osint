/**
 * Target validation, normalization and type detection.
 * Pure and isomorphic: used for instant feedback in the browser and authoritatively on the server.
 */
import ipaddr from 'ipaddr.js';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import type { TargetType } from './domain';

export type NormalizeResult =
  | { ok: true; type: TargetType; normalized: string; display: string; metadata: Record<string, unknown> }
  | { ok: false; error: string };

const MAX_LEN = 512;

// ---------------------------------------------------------------------------------------------------------------
// Domains & URLs
// ---------------------------------------------------------------------------------------------------------------

const FILE_EXTENSION_TLDS = new Set(['pdf', 'docx', 'doc', 'txt', 'csv', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'html', 'htm', 'exe', 'js', 'json']);

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function toAsciiHostname(host: string): string | null {
  try {
    // WHATWG URL performs IDNA/punycode conversion.
    const u = new URL(`http://${host}`);
    return u.hostname;
  } catch {
    return null;
  }
}

export function normalizeDomain(raw: string): string | null {
  let v = raw.trim().toLowerCase();
  if (!v || v.length > 253 + 1) return null;
  v = v.replace(/^\*\./, '').replace(/\.$/, '');
  if (/[/:@\s]/.test(v)) return null;
  const ascii = toAsciiHostname(v);
  if (!ascii) return null;
  if (ipaddr.isValid(ascii) || /^\[.*\]$/.test(ascii)) return null;
  const labels = ascii.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((l) => LABEL_RE.test(l))) return null;
  const tld = labels[labels.length - 1]!;
  if (!/^(xn--[a-z0-9-]+|[a-z]{2,63})$/.test(tld)) return null;
  // Common file extensions are far more likely than these (non-existent) TLDs.
  if (FILE_EXTENSION_TLDS.has(tld)) return null;
  return ascii;
}

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_eid|mc_cid|igshid|ref_src|_hsenc|_hsmi)$/i;

export function normalizeUrl(raw: string): { url: string; host: string } | null {
  const v = raw.trim();
  if (!v || v.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null; // never accept embedded credentials
  const host = u.hostname.replace(/\.$/, '');
  const isIp = ipaddr.isValid(host.replace(/^\[|\]$/g, ''));
  if (!isIp && !normalizeDomain(host)) return null;
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
  let out = u.toString();
  if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, '');
  return { url: out, host: host.replace(/^\[|\]$/g, '') };
}

/** Canonical form for deduplicating search results that point to the same page. */
export function canonicalUrlKey(raw: string): string {
  const n = normalizeUrl(raw);
  if (!n) return raw.trim().toLowerCase();
  const u = new URL(n.url);
  const host = u.hostname.replace(/^(www|m|mobile)\./, '');
  const path = u.pathname.replace(/\/+$/, '') || '/';
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? '?' + params.map(([k, val]) => `${k}=${val}`).join('&') : '';
  return `${host}${path}${qs}`.toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------------------------------

const EMAIL_LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/i;

export function normalizeEmail(raw: string): { email: string; local: string; domain: string } | null {
  const v = raw.trim().replace(/^mailto:/i, '');
  const at = v.lastIndexOf('@');
  if (at <= 0 || at === v.length - 1) return null;
  const local = v.slice(0, at);
  const domain = normalizeDomain(v.slice(at + 1));
  if (!domain || !EMAIL_LOCAL_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return null;
  }
  // Local parts are technically case-sensitive but virtually all providers treat them case-insensitively.
  const lower = local.toLowerCase();
  return { email: `${lower}@${domain}`, local: lower, domain };
}

// ---------------------------------------------------------------------------------------------------------------
// IP
// ---------------------------------------------------------------------------------------------------------------

export interface IpInfo {
  address: string;
  version: 4 | 6;
  range: string;
  isPublic: boolean;
}

export function normalizeIp(raw: string): IpInfo | null {
  const v = raw.trim().replace(/^\[|\]$/g, '');
  if (!ipaddr.isValid(v)) return null;
  // Reject non-canonical IPv4 forms like "010.1.1.1" or "1" which ipaddr parses leniently.
  if (v.includes('.') && !v.includes(':') && !ipaddr.IPv4.isValidFourPartDecimal(v)) return null;
  let addr = ipaddr.parse(v);
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  const range = addr.range();
  return {
    // ipaddr.js renders IPv6 in RFC 5952 canonical (compressed, lowercase) form.
    address: addr.toString(),
    version: addr.kind() === 'ipv6' ? 6 : 4,
    range,
    isPublic: range === 'unicast',
  };
}

export function isPublicIp(address: string): boolean {
  const info = normalizeIp(address);
  return Boolean(info?.isPublic);
}

// ---------------------------------------------------------------------------------------------------------------
// Usernames & profile URLs
// ---------------------------------------------------------------------------------------------------------------

const PROFILE_PATTERNS: Array<{ platform: string; re: RegExp }> = [
  { platform: 'github', re: /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/?$/i },
  { platform: 'gitlab', re: /^https?:\/\/(?:www\.)?gitlab\.com\/([A-Za-z0-9._-]{1,255})\/?$/i },
  { platform: 'reddit', re: /^https?:\/\/(?:www\.|old\.)?reddit\.com\/(?:u|user)\/([A-Za-z0-9_-]{3,20})\/?$/i },
  { platform: 'youtube', re: /^https?:\/\/(?:www\.)?youtube\.com\/@([A-Za-z0-9._-]{3,30})\/?$/i },
  { platform: 'x', re: /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?$/i },
  { platform: 'npm', re: /^https?:\/\/(?:www\.)?npmjs\.com\/~([a-z0-9._-]{1,214})\/?$/i },
  { platform: 'pypi', re: /^https?:\/\/pypi\.org\/user\/([A-Za-z0-9._-]{1,100})\/?$/i },
  { platform: 'keybase', re: /^https?:\/\/keybase\.io\/([A-Za-z0-9_]{2,16})\/?$/i },
  { platform: 'hackernews', re: /^https?:\/\/news\.ycombinator\.com\/user\?id=([A-Za-z0-9_-]{2,15})$/i },
  { platform: 'mastodon', re: /^https?:\/\/([a-z0-9.-]+\.[a-z]{2,})\/@([A-Za-z0-9_]{1,30})\/?$/i },
  { platform: 'bluesky', re: /^https?:\/\/bsky\.app\/profile\/([A-Za-z0-9.-]{3,253})\/?$/i },
];

export function parseProfileUrl(raw: string): { platform: string; username: string; instance?: string } | null {
  const v = raw.trim();
  for (const { platform, re } of PROFILE_PATTERNS) {
    const m = v.match(re);
    if (m) {
      if (platform === 'mastodon') return { platform, username: m[2]!, instance: m[1]!.toLowerCase() };
      return { platform, username: m[1]! };
    }
  }
  return null;
}

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function normalizeUsername(raw: string): string | null {
  const v = raw.trim().replace(/^@/, '');
  if (!USERNAME_RE.test(v)) return null;
  return v.toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------------------------------------------

export function normalizePhone(raw: string, defaultCountry?: string) {
  const v = raw.trim();
  if (!/^[+\d][\d\s().-]{5,24}$/.test(v)) return null;
  const parsed = parsePhoneNumberFromString(v, defaultCountry as CountryCode | undefined);
  if (!parsed || !parsed.isPossible()) return null;
  return {
    e164: parsed.number as string,
    country: parsed.country ?? null,
    valid: parsed.isValid(),
    type: parsed.getType() ?? null,
    national: parsed.formatNational(),
    international: parsed.formatInternational(),
    callingCode: parsed.countryCallingCode as string,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cryptocurrency addresses
// ---------------------------------------------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s: string): Uint8Array | null {
  let num = 0n;
  for (const ch of s) {
    const idx = B58.indexOf(ch);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  for (const ch of s) {
    if (ch === '1') bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

function base58CheckVersion(s: string): number | null {
  const bytes = base58Decode(s);
  if (!bytes || bytes.length !== 25) return null;
  const payload = bytes.slice(0, 21);
  const checksum = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) if (checksum[i] !== bytes[21 + i]) return null;
  return payload[0]!;
}

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

function bech32Valid(addr: string, hrp: string): boolean {
  const lower = addr.toLowerCase();
  if (addr !== lower && addr !== addr.toUpperCase()) return false;
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length || lower.slice(0, pos) !== hrp) return false;
  const data: number[] = [];
  for (const ch of lower.slice(pos + 1)) {
    const d = BECH32_CHARSET.indexOf(ch);
    if (d < 0) return false;
    data.push(d);
  }
  const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const pm = bech32Polymod(hrpExpand.concat(data));
  return pm === 1 || pm === 0x2bc830a3; // bech32 or bech32m
}

function ethChecksumValid(addr: string): boolean {
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true; // no checksum encoded
  const hash = Array.from(keccak_256(new TextEncoder().encode(body.toLowerCase())))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  for (let i = 0; i < 40; i++) {
    const c = body[i]!;
    const h = parseInt(hash[i]!, 16);
    if (/[a-f]/.test(c) && h >= 8) return false;
    if (/[A-F]/.test(c) && h < 8) return false;
  }
  return true;
}

export type CryptoChain = 'bitcoin' | 'ethereum' | 'litecoin' | 'dogecoin';

export function normalizeCrypto(raw: string): { address: string; chain: CryptoChain; format: string } | null {
  const v = raw.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
    if (!ethChecksumValid(v)) return null;
    return { address: v.toLowerCase(), chain: 'ethereum', format: 'evm' };
  }
  if (/^(bc1|BC1)[0-9a-zA-Z]{8,87}$/.test(v) && bech32Valid(v, 'bc')) {
    return { address: v.toLowerCase(), chain: 'bitcoin', format: 'bech32' };
  }
  if (/^(ltc1|LTC1)[0-9a-zA-Z]{8,87}$/.test(v) && bech32Valid(v, 'ltc')) {
    return { address: v.toLowerCase(), chain: 'litecoin', format: 'bech32' };
  }
  if (/^[1-9A-HJ-NP-Za-km-z]{25,35}$/.test(v)) {
    const version = base58CheckVersion(v);
    if (version === 0x00 || version === 0x05) return { address: v, chain: 'bitcoin', format: 'base58' };
    if (version === 0x30 || version === 0x32) return { address: v, chain: 'litecoin', format: 'base58' };
    if (version === 0x1e || version === 0x16) return { address: v, chain: 'dogecoin', format: 'base58' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Names & keywords
// ---------------------------------------------------------------------------------------------------------------

export function normalizeName(raw: string): string | null {
  const v = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (v.length < 2 || v.length > 200) return null;
  if (!/\p{L}/u.test(v)) return null;
  if (/[<>{}]/.test(v)) return null;
  return v;
}

// ---------------------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------------------

export function normalizeTarget(type: TargetType, raw: string, opts: { defaultCountry?: string } = {}): NormalizeResult {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: 'Value is required.' };
  if (raw.length > MAX_LEN && type !== 'url') return { ok: false, error: `Value exceeds ${MAX_LEN} characters.` };
  switch (type) {
    case 'email': {
      const e = normalizeEmail(raw);
      return e
        ? { ok: true, type, normalized: e.email, display: e.email, metadata: { domain: e.domain, local: e.local } }
        : { ok: false, error: 'Not a valid email address.' };
    }
    case 'domain': {
      const d = normalizeDomain(raw);
      return d ? { ok: true, type, normalized: d, display: d, metadata: {} } : { ok: false, error: 'Not a valid domain name.' };
    }
    case 'ip': {
      const ip = normalizeIp(raw);
      if (!ip) return { ok: false, error: 'Not a valid IPv4 or IPv6 address.' };
      return {
        ok: true,
        type,
        normalized: ip.address,
        display: ip.address,
        metadata: { version: ip.version, range: ip.range, isPublic: ip.isPublic },
      };
    }
    case 'url':
    case 'document': {
      const u = normalizeUrl(raw);
      return u
        ? { ok: true, type, normalized: u.url, display: u.url, metadata: { host: u.host } }
        : { ok: false, error: 'Not a valid http(s) URL (embedded credentials are not allowed).' };
    }
    case 'image': {
      const u = normalizeUrl(raw);
      return u
        ? { ok: true, type, normalized: u.url, display: u.url, metadata: { host: u.host, source: 'url' } }
        : { ok: false, error: 'Provide a valid image URL, or upload the image in the Image Analysis tab.' };
    }
    case 'username': {
      const profile = parseProfileUrl(raw);
      if (profile) {
        const n = normalizeUsername(profile.username);
        if (!n) return { ok: false, error: 'Profile URL contains an unsupported username.' };
        return {
          ok: true,
          type,
          normalized: n,
          display: profile.username,
          metadata: { platform: profile.platform, instance: profile.instance ?? null, profileUrl: raw.trim() },
        };
      }
      const n = normalizeUsername(raw);
      return n
        ? { ok: true, type, normalized: n, display: raw.trim().replace(/^@/, ''), metadata: {} }
        : { ok: false, error: 'Usernames may contain letters, digits, ".", "_" and "-" (max 64).' };
    }
    case 'phone': {
      const p = normalizePhone(raw, opts.defaultCountry);
      if (!p) return { ok: false, error: 'Not a recognisable phone number. Use international format, e.g. +44 20 7946 0000.' };
      return { ok: true, type, normalized: p.e164, display: p.international, metadata: { ...p } };
    }
    case 'crypto': {
      const c = normalizeCrypto(raw);
      return c
        ? { ok: true, type, normalized: c.address, display: raw.trim(), metadata: { chain: c.chain, format: c.format } }
        : { ok: false, error: 'Not a valid BTC, LTC, DOGE or Ethereum address (checksum failed or unknown format).' };
    }
    case 'person':
    case 'organization':
    case 'keyword': {
      const n = normalizeName(raw);
      return n
        ? { ok: true, type, normalized: n.toLowerCase(), display: n, metadata: {} }
        : { ok: false, error: 'Provide 2–200 characters including letters.' };
    }
    default:
      return { ok: false, error: 'Unsupported target type.' };
  }
}

/** Best-effort detection of what an analyst pasted. Never authoritative — the analyst confirms the type. */
export function detectTargetType(raw: string): TargetType | null {
  const v = raw.trim();
  if (!v) return null;
  if (normalizeEmail(v) && !/\s/.test(v)) return 'email';
  if (normalizeIp(v)) return 'ip';
  if (normalizeCrypto(v)) return 'crypto';
  if (/^https?:\/\//i.test(v)) {
    if (parseProfileUrl(v)) return 'username';
    if (/\.(pdf|docx?|csv|txt)(\?|$)/i.test(v)) return 'document';
    if (/\.(jpe?g|png|gif|webp|tiff?)(\?|$)/i.test(v)) return 'image';
    return 'url';
  }
  if (/^\+?[\d\s().-]{7,20}$/.test(v) && normalizePhone(v)) return 'phone';
  if (normalizeDomain(v) && v.includes('.') && !/\s/.test(v)) return 'domain';
  if (v.startsWith('@') && normalizeUsername(v)) return 'username';
  if (/^[A-Za-z0-9._-]{3,64}$/.test(v) && /[0-9_.-]/.test(v)) return 'username';
  if (/^\p{Lu}[\p{L}'-]+(\s+\p{Lu}[\p{L}'.-]+){1,3}$/u.test(v)) return 'person';
  return 'keyword';
}
