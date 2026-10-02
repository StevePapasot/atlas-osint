/**
 * GEOINT providers: geocoding of place names discovered during collection.
 */
import type { Provider } from '../types';
import { ProviderError } from '../types';
import { makeRecord } from '../util';
import { geocodePlace } from '../../geo/gazetteer';

export const gazetteerProvider: Provider = {
  id: 'local.gazetteer',
  name: 'Offline gazetteer (GeoNames)',
  category: 'geoint',
  kind: 'local',
  reliability: 'reputable',
  description: 'Geocodes place names to country/city centroids using an embedded GeoNames-derived gazetteer (CC BY 4.0).',
  homepage: 'https://www.geonames.org',
  operations: [{ id: 'geocode_place', label: 'Geocode place name', targetTypes: ['keyword'], module: 'geoint', minDepth: 'standard' }],
  config: [],
  timeoutMs: 2000,
  limitations: ['Resolves to city or country centroids only; ambiguous names resolve to the most populous match and are flagged.'],
  async run(input, ctx) {
    const g = geocodePlace(input.subject.display);
    if (!g) return { records: [], notes: ['Place name not found in the offline gazetteer.'] };
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: null,
          title: `"${input.subject.display}" geocoded to ${g.place} (${g.precision}-level)`,
          description: g.basis,
          entityType: 'location',
          normalizedValue: input.subject.value,
          category: 'geolocation',
          claimType: 'INFERENCE',
          confidenceInputs: { sourceReliability: 'reputable', matchType: g.ambiguous ? 'partial' : 'normalized' },
          entities: [{ ref: 'loc', type: 'location', value: input.subject.value, display: input.subject.display, attributes: { lat: g.lat, lon: g.lon, precision: g.precision } }],
          subjectRef: 'loc',
          geo: { lat: g.lat, lon: g.lon, precision: g.precision, place: g.place, countryCode: g.countryCode, basis: g.basis },
          metadata: { ambiguous: g.ambiguous, alternatives: g.alternatives },
          fingerprintKey: `geocode:${input.subject.value}`,
        }),
      ],
    };
  },
};

export const nominatimProvider: Provider = {
  id: 'nominatim',
  name: 'OpenStreetMap Nominatim',
  category: 'geoint',
  kind: 'live',
  reliability: 'reputable',
  description: 'Geocoding of place names and addresses via Nominatim (opt-in; respects the 1 request/second usage policy).',
  homepage: 'https://nominatim.org',
  docsUrl: 'https://operations.osmfoundation.org/policies/nominatim/',
  operations: [{ id: 'nominatim_geocode', label: 'Geocode (Nominatim)', targetTypes: ['keyword'], module: 'geoint', minDepth: 'deep' }],
  config: [{ env: 'ATLAS_ENABLE_NOMINATIM', label: 'Opt-in flag (ATLAS_ENABLE_NOMINATIM=true)' }],
  enabledByEnv: (env) => env.ATLAS_ENABLE_NOMINATIM === true,
  timeoutMs: 12000,
  maxRetries: 1,
  concurrency: 1,
  minIntervalMs: 1100,
  limitations: ['Geocoding a name does not establish that the subject was at that place.'],
  async run(input, ctx) {
    const base = ctx.env.NOMINATIM_URL.replace(/\/$/, '');
    const res = await ctx.http.request(`${base}/search?q=${encodeURIComponent(input.subject.display)}&format=jsonv2&limit=1&addressdetails=1`);
    const hits = res.json<Array<{ lat: string; lon: string; display_name: string; addresstype?: string; type?: string; address?: { country_code?: string } }>>();
    const h = hits[0];
    if (!h) throw new ProviderError('upstream_error', 'No geocoding result.');
    const kind = h.addresstype ?? h.type ?? '';
    const precision = kind === 'country' ? 'country' : ['state', 'region', 'province', 'county'].includes(kind) ? 'region' : ['city', 'town', 'village', 'municipality'].includes(kind) ? 'city' : 'approximate';
    return {
      records: [
        makeRecord(this, ctx, {
          sourceUrl: `https://www.openstreetmap.org/?mlat=${h.lat}&mlon=${h.lon}`,
          title: `"${input.subject.display}" geocoded to ${h.display_name}`,
          description: `Nominatim result type: ${kind || 'unknown'}.`,
          entityType: 'location',
          normalizedValue: input.subject.value,
          category: 'geolocation',
          claimType: 'INFERENCE',
          geo: { lat: Number(h.lat), lon: Number(h.lon), precision, place: h.display_name, countryCode: h.address?.country_code?.toUpperCase() ?? null, basis: 'Nominatim geocoding of the place name.' },
          metadata: { kind },
          fingerprintKey: `nominatim:${input.subject.value}`,
          raw: h,
        }),
      ],
    };
  },
};

export const GEO_PROVIDERS: Provider[] = [gazetteerProvider, nominatimProvider];
