/**
 * Regenerates src/server/geo/gazetteer-data.json (offline gazetteer used for country/city geocoding).
 *
 *   npm i --no-save all-the-cities i18n-iso-countries && node scripts/build-gazetteer.mjs
 *
 * Data sources:
 *  - City names, coordinates, populations: GeoNames (https://www.geonames.org, CC BY 4.0) via the `all-the-cities` package.
 *  - Country names: `i18n-iso-countries` (MIT).
 * Country representative points are population-weighted centroids of GeoNames places (>=1000 inhabitants).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cities = require('all-the-cities');
const iso = require('i18n-iso-countries');
iso.registerLocale(require('i18n-iso-countries/langs/en.json'));

const names = iso.getNames('en', { select: 'all' });
const weights = new Map();
for (const c of cities) {
  const [lon, lat] = c.loc.coordinates;
  const w = weights.get(c.country) ?? { lat: 0, lon: 0, p: 0 };
  w.lat += lat * c.population;
  w.lon += lon * c.population;
  w.p += c.population;
  weights.set(c.country, w);
}
const round = (n) => Math.round(n * 10000) / 10000;
const countries = Object.entries(names)
  .map(([cc, list]) => {
    const w = weights.get(cc);
    if (!w || !w.p) return null;
    const [name, ...aliases] = list;
    return { cc, name, aliases, lat: round(w.lat / w.p), lon: round(w.lon / w.p) };
  })
  .filter(Boolean)
  .sort((a, b) => a.cc.localeCompare(b.cc));

const selected = cities
  .filter((c) => c.population >= 100000 || c.featureCode === 'PPLC')
  .map((c) => ({ n: c.name, cc: c.country, a: c.adminCode || null, p: c.population, lat: round(c.loc.coordinates[1]), lon: round(c.loc.coordinates[0]), cap: c.featureCode === 'PPLC' ? 1 : 0 }))
  .sort((a, b) => b.p - a.p);

const out = {
  attribution: 'City data © GeoNames (https://www.geonames.org), CC BY 4.0, via all-the-cities. Country names via i18n-iso-countries (MIT).',
  generatedAt: new Date().toISOString().slice(0, 10),
  countries,
  cities: selected,
};
const target = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../src/server/geo/gazetteer-data.json');
fs.writeFileSync(target, JSON.stringify(out));
console.log(`wrote ${countries.length} countries and ${selected.length} cities to ${target}`);
