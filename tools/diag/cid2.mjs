const ftid = process.env.FTID;
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en' };
for (const pb of [`!1m2!1s${ftid}`, `!1m14!1s${ftid}!3m9!1m3!1d1!2d0!3d0!2m0!3m2!1i1!2i1!4f13.1`, `!1m17!1s${ftid}!3m12!1m3!1d4000!2d80.2!3d13!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!12m4!2m3!1i360!2i120!4i8`]) {
  const r = await fetch(`https://www.google.com/maps/preview/place?authuser=0&hl=en&gl=in&pb=${encodeURIComponent(pb)}`, { headers: UA });
  const t = await r.text();
  const m = [...t.matchAll(/\[null,null,(-?\d{1,2}\.\d{4,}),(-?\d{1,3}\.\d{4,})\]/g)].slice(0, 3).map((x) => `${x[1]},${x[2]}`);
  console.log('PB', r.status, t.length, 'coords', m.join(' | ') || 'none', t.slice(0, 120).replace(/\s+/g, ' '));
}
