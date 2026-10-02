'use client';
import { useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { GEO_PRECISION_RADIUS_M, type GeoPrecision } from '@/shared/domain';
import type { FindingItem } from './types';

const PRECISION_COLOR: Record<string, string> = { exact: '#ef4444', approximate: '#f59e0b', city: '#3b82f6', region: '#8b5cf6', country: '#64748b' };

/**
 * Leaflet map. Each finding is drawn as an uncertainty circle sized by its stated precision (never as a pin implying
 * exactness unless the precision is "exact"). If the tile server is unreachable the map still renders markers on a
 * blank canvas and shows a notice.
 */
export function GeoMap({ items, tileUrl, onSelect }: { items: FindingItem[]; tileUrl: string; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [tileError, setTileError] = useState(false);

  useEffect(() => {
    let disposed = false;
    void Promise.all([import('leaflet'), import('world-atlas/countries-110m.json'), import('topojson-client')]).then(([L, world, topo]) => {
      if (disposed || !ref.current) return;
      mapRef.current?.remove();
      const map = L.map(ref.current, { worldCopyJump: true, zoomControl: true, attributionControl: true }).setView([30, 10], 2);
      // Offline basemap (Natural Earth 1:110m, public domain) beneath the tile layer: always available, even when
      // tile servers are blocked or the deployment is air-gapped.
      map.createPane('basemap');
      map.getPane('basemap')!.style.zIndex = '150';
      const css = getComputedStyle(document.documentElement);
      const topology = (world as unknown as { default?: unknown }).default ?? world;
      const countries = topo.feature(topology as never, (topology as { objects: { countries: never } }).objects.countries);
      L.geoJSON(countries as never, {
        pane: 'basemap',
        interactive: false,
        style: { color: css.getPropertyValue('--border-strong').trim() || '#94a3b8', weight: 0.8, fillColor: css.getPropertyValue('--surface').trim() || '#ffffff', fillOpacity: 1 },
      }).addTo(map);
      map.attributionControl.addAttribution('Basemap: Natural Earth');
      const tiles = L.tileLayer(tileUrl, { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' });
      let errors = 0;
      tiles.on('tileerror', () => {
        errors++;
        if (errors >= 3) setTileError(true);
      });
      tiles.addTo(map);
      const bounds: Array<[number, number]> = [];
      for (const f of items) {
        if (f.geo?.lat == null || f.geo.lon == null) continue;
        const p = f.geo.precision as GeoPrecision;
        const color = PRECISION_COLOR[p] ?? '#64748b';
        const latlng: [number, number] = [f.geo.lat, f.geo.lon];
        bounds.push(latlng);
        const label = `${f.geo.place ?? `${f.geo.lat.toFixed(4)}, ${f.geo.lon.toFixed(4)}`} — ${p}`;
        const circle = L.circle(latlng, { radius: GEO_PRECISION_RADIUS_M[p] ?? 50_000, color, weight: 1.5, fillOpacity: 0.12 }).addTo(map);
        const dot = L.circleMarker(latlng, { radius: p === 'exact' ? 7 : 5, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(map);
        for (const layer of [circle, dot]) {
          layer.bindTooltip(label);
          layer.on('click', () => onSelect(f.id));
        }
      }
      if (bounds.length === 1) map.setView(bounds[0]!, 5);
      else if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 8 });
      mapRef.current = map;
    });
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [items, tileUrl, onSelect]);

  return (
    <div className="relative">
      <div ref={ref} className="h-[min(65dvh,560px)] w-full rounded-xl border border-border" data-testid="geo-map" role="region" aria-label="Map of geographic findings" />
      {tileError ? (
        <p className="absolute bottom-3 left-3 z-[500] max-w-xs rounded-md border border-warning/40 bg-elevated px-3 py-2 text-xs text-fg shadow" role="status" data-testid="tile-error">
          Map tiles could not be loaded (offline or blocked), so the offline country basemap is shown. Configure NEXT_PUBLIC_MAP_TILE_URL for an allowed tile server.
        </p>
      ) : null}
    </div>
  );
}
