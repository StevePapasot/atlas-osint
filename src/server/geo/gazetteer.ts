/**
 * Offline gazetteer (GeoNames-derived) for country- and city-level geocoding of place names.
 * Results carry explicit precision; ambiguous names are reported as such rather than silently resolved.
 */
import data from './gazetteer-data.json';
import type { GeoPrecision } from '@/shared/domain';

interface Country {
  cc: string;
  name: string;
  aliases: string[];
  lat: number;
  lon: number;
}
interface City {
  n: string;
  cc: string;
  a: string | null;
  p: number;
  lat: number;
  lon: number;
  cap: number;
}

const COUNTRIES = data.countries as Country[];
const CITIES = data.cities as City[];
export const GAZETTEER_ATTRIBUTION = data.attribution;

function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const countryByCode = new Map<string, Country>();
const countryByName = new Map<string, Country>();
for (const c of COUNTRIES) {
  countryByCode.set(c.cc, c);
  for (const n of [c.name, ...c.aliases]) countryByName.set(fold(n), c);
}
// Common short forms not always present in alias lists.
const EXTRA_COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US', 'u s a': 'US', 'united states': 'US', america: 'US', uk: 'GB', 'u k': 'GB', britain: 'GB', 'great britain': 'GB',
  england: 'GB', scotland: 'GB', wales: 'GB', russia: 'RU', 'south korea': 'KR', 'north korea': 'KP', uae: 'AE',
  'czech republic': 'CZ', holland: 'NL', vietnam: 'VN', iran: 'IR', syria: 'SY', taiwan: 'TW', bolivia: 'BO', venezuela: 'VE',
};
for (const [alias, cc] of Object.entries(EXTRA_COUNTRY_ALIASES)) {
  const c = countryByCode.get(cc);
  if (c) countryByName.set(alias, c);
}

const citiesByName = new Map<string, City[]>();
for (const c of CITIES) {
  const key = fold(c.n);
  const list = citiesByName.get(key);
  if (list) list.push(c);
  else citiesByName.set(key, [c]);
}

export interface GeocodeResult {
  lat: number;
  lon: number;
  precision: GeoPrecision;
  place: string;
  countryCode: string;
  ambiguous: boolean;
  alternatives: number;
  basis: string;
}

export function countryInfo(cc: string | null | undefined): { cc: string; name: string; lat: number; lon: number } | null {
  if (!cc) return null;
  const c = countryByCode.get(cc.toUpperCase());
  return c ? { cc: c.cc, name: c.name, lat: c.lat, lon: c.lon } : null;
}

export function countryResult(cc: string, basis: string): GeocodeResult | null {
  const c = countryByCode.get(cc.toUpperCase());
  if (!c) return null;
  return { lat: c.lat, lon: c.lon, precision: 'country', place: c.name, countryCode: c.cc, ambiguous: false, alternatives: 0, basis };
}

function cityResult(list: City[], countryHint: Country | null, basis: string): GeocodeResult | null {
  const filtered = countryHint ? list.filter((c) => c.cc === countryHint.cc) : list;
  if (!filtered.length) return null;
  const best = [...filtered].sort((a, b) => b.cap - a.cap || b.p - a.p)[0]!;
  const country = countryByCode.get(best.cc);
  const ambiguous = !countryHint && new Set(filtered.map((c) => c.cc)).size > 1;
  return {
    lat: best.lat,
    lon: best.lon,
    precision: 'city',
    place: `${best.n}, ${country?.name ?? best.cc}`,
    countryCode: best.cc,
    ambiguous,
    alternatives: filtered.length - 1,
    basis: ambiguous
      ? `${basis} Name is ambiguous (${filtered.length} candidate places); resolved to the most populous match.`
      : basis,
  };
}

/** Geocode a free-text place such as "Lisbon", "Lisbon, Portugal" or "Portugal". */
export function geocodePlace(text: string, basis = 'Offline GeoNames gazetteer match.'): GeocodeResult | null {
  if (!text || text.length > 200) return null;
  const parts = text.split(/[,;/|]/).map((p) => fold(p)).filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1]!;
  const countryHint = parts.length > 1 ? countryByName.get(last) ?? null : null;
  const first = parts[0]!;
  const cityList = citiesByName.get(first);
  if (cityList) {
    const r = cityResult(cityList, countryHint, basis);
    if (r) return r;
  }
  const whole = countryByName.get(fold(text));
  if (whole) return countryResult(whole.cc, basis);
  if (countryHint) return countryResult(countryHint.cc, `${basis} Only the country could be resolved.`);
  const firstCountry = countryByName.get(first);
  if (firstCountry) return countryResult(firstCountry.cc, basis);
  return null;
}

/**
 * Find place names mentioned in free text. Conservative: only country names and large cities (>= 500k or capitals)
 * written with an initial capital, to limit false positives such as "Reading" or "Nice".
 */
export function findPlacesInText(text: string, limit = 25): Array<GeocodeResult & { mention: string }> {
  const out = new Map<string, GeocodeResult & { mention: string }>();
  const sample = text.slice(0, 200_000);
  const tokens = sample.match(/\b\p{Lu}[\p{L}'’.-]*(?:\s+(?:de|da|do|del|of|the|\p{Lu}[\p{L}'’.-]*)){0,3}/gu) ?? [];
  for (const raw of tokens) {
    const words = raw.split(/\s+/);
    // Try the longest prefix first ("United Kingdom" before "United").
    for (let len = Math.min(words.length, 4); len >= 1; len--) {
      const cand = words.slice(0, len).join(' ').replace(/[.'’]+$/, '');
      const key = fold(cand);
      if (key.length < 3) continue;
      const country = countryByName.get(key);
      if (country && !out.has(`c:${country.cc}`)) {
        out.set(`c:${country.cc}`, { ...countryResult(country.cc, 'Country name mentioned in text.')!, mention: cand });
        break;
      }
      const cities = citiesByName.get(key)?.filter((c) => c.p >= 500_000 || c.cap === 1);
      if (cities?.length) {
        const r = cityResult(cities, null, 'City name mentioned in text (offline gazetteer).');
        if (r && !out.has(`p:${r.place}`)) out.set(`p:${r.place}`, { ...r, mention: cand });
        break;
      }
    }
    if (out.size >= limit) break;
  }
  return [...out.values()];
}
