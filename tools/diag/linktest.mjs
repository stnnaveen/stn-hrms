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
    if (r.ok) { const t = await r.text(); const m = t.match(/https:\/\/(?:www\.)?google\.[a-z.]+\/maps[^"'\s<>\\]*/); hops.push(`html ${t.length} · maps url in page: ${m ? m[0].slice(0, 160) : 'none'}`); }
    break;
  }
  console.log(`## ${k} ${clean ? 'no g_st' : 'as pasted'}\n  ${hops.join('\n  ')}`);
}
