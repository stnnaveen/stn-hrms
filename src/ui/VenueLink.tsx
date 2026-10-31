import { Icon } from './Icon';
import { googleMapsUrl } from '../lib/geo';

/** OD venue for approvers: name, place from the map pin, and a link to open it. Old ODs without a pin say so. */
export function VenueLink({ name, place, url, lat, lng }: { name: string; place?: string | null; url?: string | null; lat?: number | null; lng?: number | null }) {
  const href = url || (lat != null && lng != null ? googleMapsUrl(lat, lng) : null);
  return (
    <div className="venue" style={{ marginTop: 10 }}>
      <span className={`ri ${href ? 'c-od' : 'c-warn'}`}><Icon n="pin" /></span>
      <span className="t"><b>{name}</b><span>{place ?? (lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : 'No map pin · ask for the link')}</span></span>
      {href && <a href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>Open map</a>}
    </div>
  );
}
