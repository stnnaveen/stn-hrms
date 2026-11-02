import { Icon } from './Icon';
import { googleMapsUrl } from '../lib/geo';

/** OD venue for approvers: the OD place the staff typed, the place name from the map link (reference), and the tracked pin. */
export function VenueLink({ name, place, url, lat, lng }: { name: string; place?: string | null; url?: string | null; lat?: number | null; lng?: number | null }) {
  // open the saved pin itself (that is what the venue check-in is measured against); the pasted link only if there is no pin
  const href = lat != null && lng != null ? googleMapsUrl(lat, lng) : url || null;
  return (
    <div className="venue" style={{ marginTop: 10 }}>
      <span className={`ri ${href ? 'c-od' : 'c-warn'}`}><Icon n="pin" /></span>
      <span className="t"><b>{name}</b><span>{place ? `Map: ${place}` : (lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'No map pin · ask for the link')}</span></span>
      {href && <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open map</a>}
    </div>
  );
}
