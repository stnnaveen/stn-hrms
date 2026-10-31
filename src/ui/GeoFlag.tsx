import { Icon } from './Icon';

/** Radius result of today's check-in, for HR, Chairman and Tech only (never on staff screens):
 *  green = inside the hub or OD venue radius, red = outside. */
export function GeoFlag({ geo }: { geo: 'in' | 'out' | null | undefined }) {
  if (!geo) return null;
  const inside = geo === 'in';
  return <span className={`rf ${inside ? 'gf' : ''}`} role="img" aria-label={inside ? 'Green flag: inside radius' : 'Red flag: outside radius'} title={inside ? 'Inside radius' : 'Outside radius'}><Icon n="flag" size={13} /></span>;
}
