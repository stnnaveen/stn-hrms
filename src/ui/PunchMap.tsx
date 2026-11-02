import { lazy, Suspense, useEffect, useState } from 'react';
import { punchTarget, type Target } from '../lib/target';
import { fmtDistance } from '../lib/geo';
import type { MapPoint } from './MapView';
const MapView = lazy(() => import('./MapView'));

export interface MapPunch { lat: number; lng: number; accuracy_m?: number | null; inside?: boolean | null; label: string; target_type?: string | null; target_id?: string | null }

const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
const meters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => 2 * R * Math.asin(Math.sqrt(Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2));

/** Hub (or OD venue) pin with its radius, the staff member's pin(s), a dashed line from the main pin to the hub with the
 *  distance, and earlier check-ins as small grey dots, so HR can see at a glance: nearby, on the way, or far off.
 *  For HR, Chairman and Tech only (CLAUDE.md rule 2). */
export function PunchMap({ main, extra = [], earlier = [], height = 260 }: { main: MapPunch; extra?: MapPunch[]; earlier?: { lat: number; lng: number; label: string }[]; height?: number }) {
  const [t, setT] = useState<Target | null | undefined>(undefined);
  useEffect(() => { punchTarget(main.target_type, main.target_id).then(setT); }, [main.target_type, main.target_id]);
  // red outside; amber when beyond the radius but counted inside only thanks to the GPS accuracy allowance; green inside
  const color = (p: MapPunch) => (p.inside === false ? '#E5303F' : t && meters(p, t) > t.radius ? '#E39A0B' : p.inside ? '#1FAA6B' : '#2F62D9');
  const dist = t ? meters(main, t) : null;
  const points: MapPoint[] = [
    ...earlier.map((e) => ({ lat: e.lat, lng: e.lng, color: '#9AA0AC', label: e.label })),
    ...extra.map((p) => ({ lat: p.lat, lng: p.lng, acc: p.accuracy_m, color: color(p), label: p.label })),
    { lat: main.lat, lng: main.lng, acc: main.accuracy_m, color: color(main), label: main.label }
  ];
  return (
    <div style={{ marginTop: 12 }}>
      <Suspense fallback={<div className="mapv" style={{ height }} />}>
        <MapView height={height} points={points}
          circle={t ? { lat: t.lat, lng: t.lng, radius: t.radius, label: t.name } : null}
          line={t && dist != null && dist > 15 ? { from: main, to: t, label: fmtDistance(dist), color: color(main) } : null} />
      </Suspense>
      <div className="mlegend">
        <span><i style={{ background: '#0B1220' }} />{t ? `${t.name} · ${t.radius} m radius` : t === null ? 'Target pin not found' : 'Loading target…'}</span>
        <span><i style={{ background: color(main) }} />{main.label}{dist != null ? ` · ${fmtDistance(dist)} away` : ''}{t && dist != null && dist > t.radius && main.inside ? ' · edge (GPS ±' + Math.round(main.accuracy_m ?? 0) + ' m)' : ''}</span>
        {extra.map((p, i) => <span key={i}><i style={{ background: color(p) }} />{p.label}</span>)}
        {earlier.length > 0 && <span><i style={{ background: '#9AA0AC' }} />Earlier check-ins</span>}
      </div>
    </div>
  );
}
