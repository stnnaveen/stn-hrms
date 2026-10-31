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

const num = (a: string, b: string) => { const lat = Number(a), lng = Number(b); return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? { lat, lng } : null; };

/** Coordinates written in a Google or Apple Maps URL. Exact pin (!3d/!4d) beats the map centre (@). */
export function coordsFrom(u: string): { lat: number; lng: number } | null {
  let s = u; try { s = decodeURIComponent(u); } catch { /* keep raw */ }
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|ll|sll|coordinate|center|daddr|destination|query)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/, /\/(?:place|search|dir)\/[^@]*?(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/];
  for (const p of pats) { const m = s.match(p); if (m) { const c = num(m[1], m[2]); if (c) return c; } }
  return null;
}

/** Coordinates inside a Google Maps HTML page (used when a short link lands on a page without them in the URL). */
export function coordsFromHtml(html: string): { lat: number; lng: number } | null {
  const pats = [/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)/, /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/, /\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/];
  for (const p of pats) { const m = html.match(p); if (m) { const c = num(m[1], m[2]); if (c) return c; } }
  return null;
}

/** Place name written in the URL, if any ("/place/TIDCO+Office/..." or "?q=Codissia"). */
export function nameFrom(u: string): string | null {
  try {
    const x = new URL(u);
    const pm = x.pathname.match(/\/place\/([^/@]+)/);
    let n = pm ? pm[1] : (x.searchParams.get('q') ?? x.searchParams.get('name') ?? x.searchParams.get('query') ?? x.searchParams.get('address'));
    if (!n) return null;
    n = decodeURIComponent(n.replace(/\+/g, ' ')).trim();
    if (/^-?\d+\.\d+\s*,\s*-?\d+\.\d+$/.test(n)) return null;
    return n.slice(0, 120) || null;
  } catch { return null; }
}
