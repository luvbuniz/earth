// Regenerates assets/data/world.geo.json — the single file the app loads.
//
// Merges three sources:
//   • world-atlas countries-110m.json  → country geometry (Natural Earth 110m)
//   • world-countries                  → names, ISO codes, capital, area
//   • ./country-stats.mjs              → population + nominal GDP estimates
//
// Usage:  npm install && npm run build:data

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import { COUNTRY_STATS, MANUAL_META } from './country-stats.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const topo = require('world-atlas/countries-110m.json');
const countries = require('world-countries');

const geo = feature(topo, topo.objects.countries);
const byN3 = new Map(countries.map((c) => [c.ccn3, c]));
const byName = new Map(countries.map((c) => [c.name.common.toLowerCase(), c]));

const unmatched = [];
const noStats = [];

for (const f of geo.features) {
  const neName = f.properties?.name ?? 'Unknown';
  const id = f.id != null ? String(f.id).padStart(3, '0') : null;

  const manual = MANUAL_META[neName];
  const wc = (id && byN3.get(id)) || byName.get(neName.toLowerCase()) || null;

  let props;
  if (manual) {
    const stats = (manual.a3 && COUNTRY_STATS[manual.a3]) || manual;
    props = {
      name: manual.name, a2: manual.a2, a3: manual.a3,
      capital: manual.capital, area: manual.area,
      pop: stats.pop ?? null, gdp: stats.gdp ?? null,
    };
  } else if (wc) {
    const stats = COUNTRY_STATS[wc.cca3] || {};
    if (stats.pop == null) noStats.push(`${wc.cca3} ${wc.name.common}`);
    props = {
      name: wc.name.common,
      a2: wc.cca2,
      a3: wc.cca3,
      capital: wc.capital?.[0] ?? null,
      area: wc.area ?? null,
      pop: stats.pop ?? null,
      gdp: stats.gdp ?? null,
    };
  } else {
    unmatched.push(`id=${id} name=${neName}`);
    props = { name: neName, a2: null, a3: null, capital: null, area: null, pop: null, gdp: null };
  }
  f.properties = props;
}

// Shrink the file: 3 decimals ≈ 110 m precision, plenty for a 110m-scale map.
const round = (n) => Math.round(n * 1000) / 1000;
const roundRing = (ring) => ring.map(([x, y]) => [round(x), round(y)]);
for (const f of geo.features) {
  const g = f.geometry;
  if (g.type === 'Polygon') g.coordinates = g.coordinates.map(roundRing);
  else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map((p) => p.map(roundRing));
}

const outPath = join(ROOT, 'assets', 'data', 'world.geo.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(geo));

const kb = Math.round(Buffer.byteLength(JSON.stringify(geo)) / 1024);
console.log(`✓ wrote ${outPath} — ${geo.features.length} countries, ${kb} KB`);
if (unmatched.length) console.warn('⚠ unmatched features:\n  ' + unmatched.join('\n  '));
if (noStats.length) console.warn('⚠ no pop/gdp stats for:\n  ' + noStats.join('\n  '));
