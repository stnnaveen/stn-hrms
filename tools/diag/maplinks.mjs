// Diagnostic: follow each hub's saved map link the way the server does and print every hop (hosts and paths only).
const { SUPA_URL, SERVICE } = process.env;
const hubs = await (await fetch(`${SUPA_URL}/rest/v1/hubs?select=name,maps_url,lat,lng,pin_set_at`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } })).json();
const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'Accept-Language': 'en' };
for (const h of hubs) {
  console.log(`\n== ${h.name} · pin ${h.lat},${h.lng} · set ${h.pin_set_at ?? 'no'}\n   link: ${h.maps_url ?? '—'}`);
  let url = h.maps_url; if (!url) continue;
  for (let hop = 0; hop < 7; hop++) {
    try {
      const r = await fetch(url, { redirect: 'manual', headers: UA, signal: AbortSignal.timeout(8000) });
      const loc = r.headers.get('location');
      console.log(`   ${hop}: ${r.status} ${url.slice(0, 300)}`);
      if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); continue; }
      if (r.ok) { const t = await r.text(); const m = t.match(/center=(-?\d+\.\d+)%2C(-?\d+\.\d+)|!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)|@(-?\d+\.\d{4,}),(-?\d+\.\d{4,})|\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/); console.log(`   html ${t.length} bytes · coords ${m ? m[0].slice(0, 80) : 'none'}`); }
      break;
    } catch (e) { console.log(`   ${hop}: error ${String(e).slice(0, 120)}`); break; }
  }
}
