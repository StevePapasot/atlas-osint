/**
 * Local (offline) analysers operating only on the supplied identifier — no network access.
 * They run in both live and demo investigations because they compute facts about the input itself.
 */
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js';
import type { Provider } from '../types';
import { makeRecord } from '../util';
import { countryResult } from '../../geo/gazetteer';
import { normalizeCrypto, normalizeUrl } from '@/shared/targets';

export const phoneNumberingProvider: Provider = {
  id: 'local.phone',
  name: 'Numbering-plan analysis (offline)',
  category: 'phone',
  kind: 'local',
  reliability: 'authoritative',
  description: 'Validates and classifies phone numbers against ITU/national numbering plans (libphonenumber metadata).',
  docsUrl: 'https://gitlab.com/catamphetamine/libphonenumber-js',
  operations: [{ id: 'phone_numbering', label: 'Numbering-plan analysis', targetTypes: ['phone'], module: 'phone', minDepth: 'quick' }],
  config: [],
  timeoutMs: 2000,
  limitations: [
    'Shows where a number was originally allocated. Numbers can be ported between carriers and used from anywhere (VoIP).',
    'No subscriber or carrier lookup is performed.',
  ],
  async run(input, ctx) {
    const p = parsePhoneNumberFromString(input.subject.value);
    if (!p) return { records: [] };
    const type = p.getType() ?? 'UNKNOWN';
    const shared = p.country ? null : getCountries().filter((c) => getCountryCallingCode(c) === p.countryCallingCode);
    const geo = p.country ? countryResult(p.country, `Numbering-plan allocation country for +${p.countryCallingCode} (not the caller’s location).`) : null;
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: null,
          title: `${p.formatInternational()} is a ${p.isValid() ? 'valid' : 'possible but not valid'} ${type.toLowerCase().replace(/_/g, ' ')} number${p.country ? ` allocated to ${p.country}` : ''}`,
          description: `Calling code +${p.countryCallingCode}${shared?.length ? ` (shared by ${shared.join(', ')})` : ''}. National format ${p.formatNational()}.`,
          excerpt: JSON.stringify({ e164: p.number, country: p.country ?? null, type, valid: p.isValid(), national: p.formatNational() }),
          entityType: 'phone',
          normalizedValue: input.subject.value,
          category: 'phone',
          claimType: 'FACT',
          entities: [
            { ref: 'ph', type: 'phone', value: input.subject.value, display: p.formatInternational() },
            ...(geo ? [{ ref: 'loc', type: 'location' as const, value: geo.place.toLowerCase(), display: geo.place }] : []),
          ],
          subjectRef: 'ph',
          relationships: geo ? [{ from: 'ph', to: 'loc', type: 'LOCATED_IN', status: 'possible', rationale: 'Number range allocated to this country (not a physical location).' }] : [],
          geo: geo ? { lat: geo.lat, lon: geo.lon, precision: 'country', place: geo.place, countryCode: geo.countryCode, basis: geo.basis } : null,
          metadata: { e164: p.number, country: p.country ?? null, type, valid: p.isValid(), callingCode: p.countryCallingCode },
          fingerprintKey: `phone:${input.subject.value}`,
          limitations: this.limitations,
        }),
      ],
    };
  },
};

export const cryptoFormatProvider: Provider = {
  id: 'local.crypto',
  name: 'Address format analysis (offline)',
  category: 'crypto',
  kind: 'local',
  reliability: 'authoritative',
  description: 'Checksum validation and chain/format identification for BTC, LTC, DOGE and Ethereum addresses.',
  operations: [{ id: 'crypto_format', label: 'Address validation', targetTypes: ['crypto'], module: 'crypto', minDepth: 'quick' }],
  config: [],
  timeoutMs: 2000,
  async run(input, ctx) {
    const c = normalizeCrypto(input.subject.display) ?? normalizeCrypto(input.subject.value);
    if (!c) return { records: [] };
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: null,
          title: `${input.subject.display} is a valid ${c.chain} address (${c.format})`,
          description: 'Checksum verified offline. Validity says nothing about ownership or activity.',
          excerpt: JSON.stringify(c),
          entityType: 'crypto_address',
          normalizedValue: input.subject.value,
          category: 'crypto',
          claimType: 'FACT',
          metadata: c,
          fingerprintKey: `crypto-format:${c.address}`,
        }),
      ],
    };
  },
};

export const urlAnalysisProvider: Provider = {
  id: 'local.url',
  name: 'URL structure analysis (offline)',
  category: 'domain',
  kind: 'local',
  reliability: 'authoritative',
  description: 'Parses URLs into host, registrable domain, path and query indicators without fetching them.',
  operations: [{ id: 'url_structure', label: 'URL structure', targetTypes: ['url', 'document', 'image'], module: 'domain', minDepth: 'quick' }],
  config: [],
  timeoutMs: 2000,
  limitations: ['Structure only. Retrieving the page itself is done by the opt-in “Target page retrieval” provider (ATLAS_ALLOW_TARGET_FETCH=true).'],
  async run(input, ctx) {
    const n = normalizeUrl(input.subject.value);
    if (!n) return { records: [] };
    const u = new URL(n.url);
    const suspicious: string[] = [];
    if (/xn--/.test(u.hostname)) suspicious.push('punycode (internationalised) hostname — check for homoglyphs');
    if (u.hostname.split('.').length > 4) suspicious.push('deeply nested subdomain');
    if (/(login|verify|secure|account|update|wallet)/i.test(u.hostname + u.pathname)) suspicious.push('credential-themed keywords');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) suspicious.push('raw IP address host');
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: null,
          title: `URL hosted on ${u.hostname}`,
          description: suspicious.length ? `Structural indicators: ${suspicious.join('; ')}.` : 'No structural anomalies detected.',
          excerpt: JSON.stringify({ scheme: u.protocol, host: u.hostname, path: u.pathname, params: [...u.searchParams.keys()] }),
          entityType: input.subject.type === 'document' ? 'document' : input.subject.type === 'image' ? 'image' : 'url',
          normalizedValue: input.subject.value,
          category: 'web_mention',
          claimType: suspicious.length ? 'INFERENCE' : 'FACT',
          entities: [
            { ref: 'u', type: input.subject.type === 'document' ? 'document' : input.subject.type === 'image' ? 'image' : 'url', value: input.subject.value },
            { ref: 'h', type: 'domain', value: u.hostname },
          ],
          subjectRef: 'u',
          relationships: [{ from: 'u', to: 'h', type: 'HOSTED_ON', status: 'confirmed', rationale: 'URL host component.' }],
          metadata: { host: u.hostname, path: u.pathname, suspicious },
          fingerprintKey: `url-structure:${n.url}`,
        }),
      ],
    };
  },
};

export const LOCAL_PROVIDERS: Provider[] = [phoneNumberingProvider, cryptoFormatProvider, urlAnalysisProvider];
