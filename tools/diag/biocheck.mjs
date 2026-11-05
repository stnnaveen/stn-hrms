// Independent check of the HR fingerprint figures (second implementation, plain JS, from raw rows):
// recompute in / out per eSSL code per day with the same rules and compare with what the database gives HR
// (bio_range per code, bio_attendance per person). Then print the eSSL comparison (bio_verify). Any mismatch is listed.
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const get = async (q) => (await fetch(`${SUPA_URL}/rest/v1/${q}`, { headers: h })).json();
const rpc = async (f, b) => (await fetch(`${SUPA_URL}/rest/v1/rpc/${f}`, { method: 'POST', headers: h, body: JSON.stringify(b) })).json();
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10), first = today.slice(0, 8) + '01';
const ist = (t) => new Date(new Date(t).getTime() + 330 * 60000).toISOString();
let raw = [], from = 0;
for (;;) { const r = await (await fetch(`${SUPA_URL}/rest/v1/bio_punches?select=device_code,essl_device_id,punched_at&punched_at=gte.${encodeURIComponent(first + 'T00:00:00+05:30')}&order=punched_at`, { headers: { ...h, Range: `${from}-${from + 999}` } })).json(); raw = raw.concat(r); if (r.length < 1000) break; from += 1000; }
const devs = await get('bio_devices?select=essl_id,kind'); const kind = new Map(devs.map((d) => [d.essl_id, d.kind]));
const gap = Number((await get('settings?select=value&key=eq.bio_gap_min'))[0]?.value ?? 20);
const people = await get('bio_people?select=device_code,email');
const emailOf = new Map(people.map((p) => [p.device_code, p.email]));
// --- JS recomputation
const g = new Map();
for (const p of raw) { if ((kind.get(p.essl_device_id) ?? 'biometric') !== 'biometric') continue; const k = `${ist(p.punched_at).slice(0, 10)}|${p.device_code}`; (g.get(k) ?? g.set(k, []).get(k)).push(new Date(p.punched_at).getTime()); }
const js = new Map();
for (const [k, ts] of g) { ts.sort((a, b) => a - b); const inT = ts[0]; const outs = ts.filter((t) => t > inT + gap * 60000); js.set(k, { in: inT, out: outs.length ? outs[outs.length - 1] : null, n: ts.length }); }
// --- database (what HR sees)
const db = await rpc('bio_range', { p_from: first, p_to: today });
let same = 0, diff = [];
for (const r of db) {
  const k = `${r.day}|${r.device_code}`, j = js.get(k);
  const ok = j && j.in === new Date(r.first_at).getTime() && (j.out ?? null) === (r.last_at ? new Date(r.last_at).getTime() : null) && j.n === r.punches;
  if (ok) same++; else diff.push({ k, db: [r.first_at, r.last_at, r.punches], js: j && [new Date(j.in).toISOString(), j.out && new Date(j.out).toISOString(), j.n] });
}
const missing = [...js.keys()].filter((k) => !db.some((r) => `${r.day}|${r.device_code}` === k));
console.log(`CHK 1 report per eSSL code: ${same}/${db.length} identical to the independent recomputation; differences ${diff.length}; missing in report ${missing.length}`);
for (const d of diff.slice(0, 20)) console.log(`CHK   DIFF ${JSON.stringify(d)}`);
// --- per person (home numbers, staff list, calendar use this)
const att = await rpc('bio_attendance', { p_from: first, p_to: today });
const byPerson = new Map();
for (const [k, v] of js) { const [day, code] = k.split('|'); const em = emailOf.get(code); if (!em) continue; const kk = `${day}|${em}`; const cur = byPerson.get(kk); const all = [...(cur?.all ?? []), ...g.get(k)]; byPerson.set(kk, { all }); }
let pSame = 0, pDiff = [];
for (const a of att) {
  const b = byPerson.get(`${a.day}|${a.email}`); if (!b) { pDiff.push({ a, js: null }); continue; }
  const ts = b.all.sort((x, y) => x - y), inT = ts[0], outs = ts.filter((t) => t > inT + gap * 60000), outT = outs.length ? outs[outs.length - 1] : null;
  const hm = Number(ist(new Date(inT).toISOString()).slice(11, 13)) * 60 + Number(ist(new Date(inT).toISOString()).slice(14, 16));
  const band = hm <= 600 ? 'ok' : hm <= 605 ? 'warn' : 'bad';
  if (inT === new Date(a.in_at).getTime() && outT === (a.out_at ? new Date(a.out_at).getTime() : null) && band === a.band) pSame++; else pDiff.push({ a, js: [inT, outT, band] });
}
console.log(`CHK 2 per person (home, lists, calendar): ${pSame}/${att.length} identical; differences ${pDiff.length}; persons in recomputation ${byPerson.size}`);
for (const d of pDiff.slice(0, 20)) console.log(`CHK   PDIFF ${JSON.stringify(d)}`);
const orphan = raw.filter((p) => !emailOf.has(p.device_code) && !people.some((x) => x.device_code === p.device_code)).length;
console.log(`CHK 3 punches with no eSSL person: ${orphan}`);
// --- against eSSL itself
const v = await rpc('bio_verify', { p_from: first, p_to: today });
for (const c of v.filter((c) => c.stored_rows > 0)) console.log(`CHK eSSL ${c.day}: eSSL rows ${c.essl_rows ?? 'not reported yet'} · stored ${c.stored_rows} · orphans ${c.orphans} · compared ${c.compared} · in agree ${c.in_agree} · out agree ${c.out_agree}${c.differ.length ? ' · DIFFER ' + JSON.stringify(c.differ.slice(0, 8)) : ''}`);
for (const w of ['akila', 'lakshmi']) { const em = (await get(`staff_roster?select=email&full_name=ilike.*${w}*`)).map((r) => r.email); for (const a of att.filter((x) => em.includes(x.email))) console.log(`CHK ${w}: ${a.day} in ${ist(a.in_at).slice(11, 16)} ${a.band} out ${a.out_at ? ist(a.out_at).slice(11, 16) : '—'} (${a.punches} punches)`); }
if (diff.length || pDiff.length || orphan) process.exitCode = 1;
