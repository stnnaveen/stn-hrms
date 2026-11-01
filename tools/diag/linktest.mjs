// Diagnostic: follow one map link with different settings and show where it lands.
const link = process.env.LINK;
const UAS = { iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', curl: 'curl/8.5.0' };
const strip = (u) => { const x = new URL(u); x.searchParams.delete('g_st'); return x.toString(); };
for (const [k, ua] of Object.entries(UAS)) for (const clean of [false, true]) {
  let url = clean ? strip(link) : link; const hops = [];
  for (let i = 0; i < 7; i++) {
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': ua, 'Accept-Language': 'en' } });
    const loc = r.headers.get('location'); hops.push(`${r.status} ${url.slice(0, 150)}`);
    if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
    if (r.ok) { const t = await r.text(); const m = t.match(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps[^"'\s<>\\]*/); hops.push(`html ${t.length} · maps url in page: ${m ? m[0].slice(0, 160) : 'none'}`);
      const pairs = [...t.matchAll(/(-?\d{1,2}\.\d{4,})\s*(?:,|%2C|\\u002C)\s*(-?\d{1,3}\.\d{4,})/g)].map((x) => `${x[1]},${x[2]}`); hops.push(`coord pairs: ${[...new Set(pairs)].slice(0, 8).join(' | ') || 'none'}`);
      const ctx = [...t.matchAll(/.{0,60}(1[0-3]\.\d{5,}).{0,60}/g)].slice(0, 4).map((x) => x[0].replace(/\s+/g, ' ')); hops.push(`context: ${ctx.join(' ### ') || 'none'}`);
      const ttl = t.match(/<title>([^<]*)<\/title>/i)?.[1] ?? t.match(/og:title" content="([^"]*)/)?.[1]; hops.push(`title: ${ttl ?? '—'}`); }
    break;
  }
  console.log(`## ${k} ${clean ? 'no g_st' : 'as pasted'}\n  ${hops.join('\n  ')}`);
}
// shared list links (!7m4...!2s<list>) carry no pin; try the list contents
{
  const r = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': UAS.desktop } });
  const m = decodeURIComponent(r.url).match(/!2s([A-Za-z0-9_\-+/=]{10,})/);
  if (m) {
    const raw = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
    const id = raw.match(/[A-Za-z0-9_-]{20,}/)?.[0];
    console.log(`## list id ${id}`);
    for (const pb of [`!1m4!1s${id}!2e1!3m1!1e1!2e2!3e2!4i500!16b1`, `!1m4!1s${id}!2e2!3m1!1e1!2e2!3e2!4i500!16b1`]) {
      const g = await fetch(`https://www.google.com/maps/preview/entitylist/getlist?authuser=0&hl=en&gl=in&pb=${encodeURIComponent(pb)}`, { headers: { 'User-Agent': UAS.desktop } });
      const t = await g.text();
      console.log(`## getlist ${g.status} ${t.length} bytes: ${t.replace(/\s+/g, ' ').slice(0, 900)}`);
    }
  }
}
