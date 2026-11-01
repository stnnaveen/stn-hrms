// Map links for OD venues: only Google Maps and Apple Maps are accepted (no free-typed places).
// Pure helpers, shared by the edge function and the tests.

const HOSTS = [/^(www\.|maps\.)?google\.[a-z.]{2,6}$/i, /^goo\.gl$/i, /^maps\.app\.goo\.gl$/i, /^maps\.apple\.com$/i, /^maps\.apple$/i, /^(www\.)?apple\.co$/i];

/** First http(s) URL in pasted text (share sheets often add the place name before the link). */
export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,;]+$/, '') : null;
}

export function isMapsHost(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return false;
    if (/^(www\.)?google\./i.test(x.hostname) && !x.pathname.startsWith('/maps') && !x.searchParams.has('q') && !/^maps\./.test(x.hostname)) return false;
    return HOSTS.some((h) => h.test(x.hostname));
  } catch { return false; }
}

/** Hosts a maps link may pass through on its way to the place (Google and Apple only), wider than what may be pasted. */
export function isMapsRedirect(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return /(^|\.)google\.[a-z.]{2,6}$/.test(h) || /(^|\.)goo\.gl$/.test(h) || h === 'share.google' || h === 'g.co' || /(^|\.)apple\.com$/.test(h) || /(^|\.)apple\.co$/.test(h) || h === 'maps.apple';
  } catch { return false; }
}

/** Directions links ("geocode=start;destination") carry each point as a small binary record: field 2 = lat, field 3 = lng, in millionths. */
export function coordsFromGeocode(u: string): { lat: number; lng: number } | null {
  let g: string | null = null;
  try { g = new URL(u).searchParams.get('geocode'); } catch { return null; }
  if (!g) return null;
  const last = g.split(';').filter(Boolean).pop();
  if (!last) return null;
  try {
    const bin = atob(last.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(last.length / 4) * 4, '='));
    const b = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const read = (i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24));   // signed 32-bit, little endian
    let lat: number | null = null, lng: number | null = null;
    for (let i = 0; i + 4 < b.length; i++) {
      if (b[i] === 0x15 && lat === null) { lat = read(i + 1) / 1e6; i += 4; }
      else if (b[i] === 0x1d && lat !== null && lng === null) { lng = read(i + 1) / 1e6; break; }
    }
    return lat !== null && lng !== null ? num(String(lat), String(lng)) : null;
  } catch { return null; }
}

const num = (a: string, b: string) => { const lat = Number(a), lng = Number(b); return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? { lat, lng } : null; };

/** Coordinates written in a Google or Apple Maps URL. Exact pin (!3d/!4d) beats the map centre (@). */
export function coordsFrom(u: string): { lat: number; lng: number } | null {
  let s = u; try { s = decodeURIComponent(u); } catch { /* keep raw */ }
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|ll|sll|coordinate|center|daddr|destination|query)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/, /\/(?:place|search|dir)\/[^@]*?(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/];
  for (const p of pats) { const m = s.match(p); if (m) { const c = num(m[1], m[2]); if (c) return c; } }
  return coordsFromGeocode(u);
}

/** Coordinates inside a Google Maps HTML page (used when a short link lands on a page without them in the URL).
 *  The preview image's centre counts only when zoomed in to street level: a zoomed-out centre (zoom 7) is
 *  Google's guess of where the *visitor* is (our server in Mumbai), not the place. */
export function coordsFromHtml(html: string): { lat: number; lng: number } | null {
  const pats = [/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)&(?:amp;)?zoom=(?:1[2-9]|2\d)\b/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/, /\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/];
  for (const p of pats) { const m = html.match(p); if (m) { const c = num(m[1], m[2]); if (c) return c; } }
  return null;
}

/** Place name written in the URL, if any ("/place/TIDCO+Office/..." or "?q=Codissia"). */
export function nameFrom(u: string): string | null {
  try {
    const x = new URL(u);
    const pm = x.pathname.match(/\/place\/([^/@]+)/);
    let n = pm ? pm[1] : (x.searchParams.get('q') ?? x.searchParams.get('name') ?? x.searchParams.get('query') ?? x.searchParams.get('address') ?? x.searchParams.get('daddr'));
    if (!n) return null;
    n = decodeURIComponent(n.replace(/\+/g, ' ')).trim();
    if (/^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(n)) return null;
    return n.slice(0, 120) || null;
  } catch { return null; }
}

/** Coordinates typed or pasted as text: "13.00623, 80.25241" or 13°00'22.4"N 80°15'08.7"E. */
export function coordsFromText(text: string): { lat: number; lng: number } | null {
  const t = text.trim();
  const d = t.match(/^\(?\s*(-?\d{1,2}\.\d{3,})\s*[,\s]\s*(-?\d{1,3}\.\d{3,})\s*\)?$/);
  if (d) return num(d[1], d[2]);
  const dms = t.match(/(\d{1,2})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([NS])[\s,]+(\d{1,3})°\s*(\d{1,2})['′]\s*([\d.]+)["″]?\s*([EW])/i);
  if (dms) {
    const lat = (Number(dms[1]) + Number(dms[2]) / 60 + Number(dms[3]) / 3600) * (/s/i.test(dms[4]) ? -1 : 1);
    const lng = (Number(dms[5]) + Number(dms[6]) / 60 + Number(dms[7]) / 3600) * (/w/i.test(dms[8]) ? -1 : 1);
    return num(lat.toFixed(6), lng.toFixed(6));
  }
  return null;
}

// ---- Plus Codes (Open Location Code), e.g. "7M52244M+6JF" or the short "244M+6JF Tharapakkam" Google puts in shared links
const OLC = '23456789CFGHJMPQRVWX';
const PV = [20, 1, 0.05, 0.0025, 0.000125];   // degrees per digit, pairs 1-5

/** A Plus Code found in text: full ("7M52244M+6JF") or short ("244M+6JF"), plus the words after it (the area name). */
export function plusCodeIn(text: string): { code: string; full: boolean; area: string } | null {
  let t = text; try { t = decodeURIComponent(text); } catch { /* raw */ }   // '+' kept: it is part of the code
  const m = t.match(/(?:^|[\s=,/+])([23456789CFGHJMPQRVWX]{4,8})\+([23456789CFGHJMPQRVWX]{2,3})(?=$|[\s,&+])/i);
  if (!m) return null;
  const code = `${m[1]}+${m[2]}`.toUpperCase();
  if (m[1].length % 2 !== 0) return null;
  const rest = t.slice((m.index ?? 0) + m[0].length).split('&')[0].replace(/\+/g, ' ').replace(/^[\s,]+/, '').replace(/\s+/g, ' ').trim();
  return { code, full: m[1].length === 8, area: rest.slice(0, 160) };
}

function olcDecodeFull(code: string): { lat: number; lng: number } | null {
  const c = code.replace('+', '').toUpperCase();
  if (c.length < 8) return null;
  let lat = -90, lng = -180;
  for (let i = 0; i < 5 && i * 2 + 1 < c.length; i++) {
    const a = OLC.indexOf(c[i * 2]), b = OLC.indexOf(c[i * 2 + 1]);
    if (a < 0 || b < 0) return null;
    lat += a * PV[i]; lng += b * PV[i];
  }
  const pairs = Math.min(5, Math.floor(c.length / 2)), res = PV[pairs - 1];
  return { lat: Number((lat + res / 2).toFixed(6)), lng: Number((lng + res / 2).toFixed(6)) };
}

function olcEncode(lat: number, lng: number): string {
  let la = Math.min(179.999999, lat + 90), ln = ((lng + 180) % 360 + 360) % 360, out = '';
  for (let i = 0; i < 5; i++) {
    const a = Math.floor(la / PV[i] + 1e-9), b = Math.floor(ln / PV[i] + 1e-9);
    la -= a * PV[i]; ln -= b * PV[i];
    out += OLC[Math.min(19, a)] + OLC[Math.min(19, b)];
    if (i === 3) out += '+';
  }
  return out;
}

/** Decode a Plus Code; a short code needs a reference point within ~50 km (e.g. the area named after it). */
export function decodePlusCode(code: string, ref?: { lat: number; lng: number } | null): { lat: number; lng: number } | null {
  const sep = code.indexOf('+');
  if (sep === 8) return olcDecodeFull(code);
  if (!ref || sep < 2) return null;
  const pad = 8 - sep, res = Math.pow(20, 2 - pad / 2), half = res / 2;
  const c = olcDecodeFull(olcEncode(ref.lat, ref.lng).slice(0, pad) + code);
  if (!c) return null;
  let { lat, lng } = c;
  if (ref.lat + half < lat && lat - res >= -90) lat -= res; else if (ref.lat - half > lat && lat + res <= 90) lat += res;
  if (ref.lng + half < lng) lng -= res; else if (ref.lng - half > lng) lng += res;
  return num(lat.toFixed(6), lng.toFixed(6));
}
