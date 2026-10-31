// Real map (OpenStreetMap tiles via Leaflet) for hub pins, the radius circle and test points.
// Loaded on demand with React.lazy so staff screens never download it.
import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface MapPoint { lat: number; lng: number; acc?: number | null; color: string; label?: string }
export interface MapProps {
  circle?: { lat: number; lng: number; radius: number } | null;
  points?: MapPoint[];
  onTap?: (lat: number, lng: number) => void;
  height?: number;
}

export default function MapView({ circle, points = [], onTap, height = 280 }: MapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const tap = useRef(onTap);
  tap.current = onTap;

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([13.0827, 80.2707], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
    m.on('click', (e: L.LeafletMouseEvent) => tap.current?.(e.latlng.lat, e.latlng.lng));
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    setTimeout(() => m.invalidateSize(), 50);
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current, g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    if (circle) {
      const c = L.circle([circle.lat, circle.lng], { radius: circle.radius, color: '#2F62D9', weight: 2, fillColor: '#2F62D9', fillOpacity: 0.12 }).addTo(g);
      L.circleMarker([circle.lat, circle.lng], { radius: 6, color: '#fff', weight: 2, fillColor: '#0B1220', fillOpacity: 1 }).addTo(g).bindTooltip('Hub pin');
      const b = c.getBounds(); bounds.push(b.getNorthEast(), b.getSouthWest());
    }
    for (const p of points) {
      if (p.acc) L.circle([p.lat, p.lng], { radius: Math.min(p.acc, 300), color: p.color, weight: 1, fillColor: p.color, fillOpacity: 0.1, dashArray: '4 4' }).addTo(g);
      const mk = L.circleMarker([p.lat, p.lng], { radius: 7, color: '#fff', weight: 2, fillColor: p.color, fillOpacity: 1 }).addTo(g);
      if (p.label) mk.bindTooltip(esc(p.label));   // Leaflet treats strings as HTML: names and places are escaped
      bounds.push([p.lat, p.lng]);
    }
    if (bounds.length) m.fitBounds(L.latLngBounds(bounds), { padding: [28, 28], maxZoom: 17 });
  }, [circle?.lat, circle?.lng, circle?.radius, JSON.stringify(points)]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="mapv" style={{ height }} role="application" aria-label="Map. Tap to test a point." />;
}
