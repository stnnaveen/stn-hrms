// Where a check-in was supposed to be: its hub, or the OD venue. For HR, Chairman and Tech maps only.
import { sb, DEMO } from './api';

export interface Target { lat: number; lng: number; radius: number; name: string; kind: 'hub' | 'od' }
const cache = new Map<string, Promise<Target | null>>();

export function punchTarget(type: string | null | undefined, id: string | null | undefined): Promise<Target | null> {
  if (DEMO) return Promise.resolve({ lat: 13.0321, lng: 80.2436, radius: 300, name: 'Chennai hub', kind: 'hub' });
  if (!type || !id) return Promise.resolve(null);
  const k = `${type}:${id}`;
  if (!cache.has(k)) cache.set(k, (async () => {
    if (type === 'od') {
      const { data } = await sb!.from('od_requests').select('venue_lat, venue_lng, venue_radius_m, venue_name').eq('id', id).maybeSingle();
      return data?.venue_lat != null ? { lat: data.venue_lat, lng: data.venue_lng, radius: data.venue_radius_m ?? 500, name: data.venue_name ?? 'OD venue', kind: 'od' as const } : null;
    }
    const { data } = await sb!.from('hubs').select('lat, lng, radius_m, name').eq('id', id).maybeSingle();
    return data ? { lat: data.lat, lng: data.lng, radius: data.radius_m, name: `${data.name} hub`, kind: 'hub' as const } : null;
  })().catch(() => null));
  return cache.get(k)!;
}
