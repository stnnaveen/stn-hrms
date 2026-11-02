// Diagnostic: get a place's exact coordinates from its Google place id (ftid / cid) instead of its name.
const link = process.env.LINK;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en' };
let url = link, final = link;
for (let i = 0; i < 6; i++) { const r = await fetch(url, { redirect: 'manual', headers: UA }); const loc = r.headers.get('location'); if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).toString(); final = url; continue; } break; }
console.log('CID final', final.slice(0, 300));
const ftid = new URL(final).searchParams.get('ftid'); console.log('CID ftid', ftid);
if (!ftid) process.exit(0);
const cid = BigInt(ftid.split(':')[1]).toString(); console.log('CID cid', cid);
const show = (label, t) => {
  const ais = t.match(/APP_INITIALIZATION_STATE=\[\[\[([-\d.]+),([-\d.]+),([-\d.]+)\]/); console.log(label, 'init', ais ? ais.slice(1).join(',') : 'none');
  for (const [nm, re] of [['3d4d', /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/], ['at', /@(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/], ['center', /center=(-?\d+\.\d+)%2C(-?\d+\.\d+)&(?:amp;)?zoom=(\d+)/], ['nullnull', /\[null,null,(-?\d+\.\d{4,}),(-?\d+\.\d{4,})\]/]]) { const m = t.match(re); console.log(label, nm, m ? m.slice(1).join(',') : 'none'); }
};
for (const u of [`https://maps.google.com/?cid=${cid}`, `https://www.google.com/maps?cid=${cid}`, `https://www.google.com/maps/place/data=!4m2!3m1!1s${ftid}`, `https://www.google.com/maps/search/?api=1&query=x&query_place_id=${ftid}`]) {
  let x = u, hops = [];
  for (let i = 0; i < 6; i++) { const r = await fetch(x, { redirect: 'manual', headers: UA }); const loc = r.headers.get('location'); hops.push(`${r.status}`); if (r.status >= 300 && r.status < 400 && loc) { x = new URL(loc, x).toString(); hops.push(x.slice(0, 200)); continue; } if (r.ok) show(`CID [${u.slice(0, 60)}]`, await r.text()); break; }
  console.log('CID hops', u.slice(0, 60), '=>', hops.join(' | ').slice(0, 600));
}
