// Place names for coordinates, shown to HR as the "probable location".
// Uses the name stored at check-in; otherwise asks OpenStreetMap once and caches it for this session.
const cache = new Map<string, Promise<string | null>>();

export function placeLabel(lat: number, lng: number): Promise<string | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (!cache.has(key)) {
    cache.set(key, fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`, { headers: { 'Accept-Language': 'en' } })
      .then((r) => r.json())
      .then((j) => {
        const a = j?.address ?? {};
        const parts = [j?.name || a.amenity || a.building || a.office || a.shop || a.road, a.neighbourhood || a.suburb || a.quarter || a.village || a.hamlet,
          a.city || a.town || a.municipality || a.county || a.state_district].filter((x, i, arr) => x && arr.indexOf(x) === i);
        return parts.length ? parts.join(', ') : (j?.display_name ?? null);
      })
      .catch(() => null));
  }
  return cache.get(key)!;
}

export const googleMapsUrl = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
export const appleMapsUrl = (lat: number, lng: number) => `https://maps.apple.com/?ll=${lat},${lng}&q=Probable%20location`;
export const fmtDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
