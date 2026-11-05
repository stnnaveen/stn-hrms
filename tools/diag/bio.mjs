// Diagnostic: live eSSL link — sync status, punches per day since the 1st, and every match (eSSL name vs staff list name).
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const get = async (q) => (await fetch(`${SUPA_URL}/rest/v1/${q}`, { headers: h })).json();
const links = await get('bio_links?select=id,name,created_at,revoked_at&order=created_at');
for (const l of links) console.log(`BIOL link ${l.name} created ${l.created_at} revoked ${l.revoked_at}`);
const st = await get('bio_status?select=link_id,last_seen,info');
for (const s of st) console.log(`BIOL status last_seen ${s.last_seen} info ${JSON.stringify(s.info)}`);
const dv = await get('bio_devices?select=essl_id,name,serial,kind,hub_id,last_ping,last_download');
for (const d of dv) console.log(`BIOL device ${JSON.stringify(d)}`);
const month = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 8) + '01T00:00:00+05:30';
let all = [], from = 0;
for (;;) { const r = await (await fetch(`${SUPA_URL}/rest/v1/bio_punches?select=essl_table,essl_log_id,essl_device_id,device_code,punched_at,direction,downloaded_at,received_at&punched_at=gte.${encodeURIComponent(month)}&order=punched_at`, { headers: { ...h, Range: `${from}-${from + 999}` } })).json(); all = all.concat(r); if (r.length < 1000) break; from += 1000; }
const day = (t) => new Date(new Date(t).getTime() + 330 * 60000).toISOString().slice(0, 10);
const byDay = {}; for (const p of all) { const k = day(p.punched_at); byDay[k] = byDay[k] || { n: 0, people: new Set() }; byDay[k].n++; byDay[k].people.add(p.device_code); }
for (const [k, v] of Object.entries(byDay)) console.log(`BIOD ${k} punches ${v.n} people ${v.people.size}`);
console.log(`BIOD total this month ${all.length}; tables ${[...new Set(all.map((p) => p.essl_table))].join(',')}; devices ${[...new Set(all.map((p) => p.essl_device_id))].join(',')}; directions ${[...new Set(all.map((p) => p.direction))].join(',')}`);
const lag = all.filter((p) => p.downloaded_at).map((p) => (new Date(p.downloaded_at) - new Date(p.punched_at)) / 1000).sort((a, b) => a - b);
if (lag.length) console.log(`BIOD device->eSSL delay s: p50 ${lag[Math.floor(lag.length / 2)]} p90 ${lag[Math.floor(lag.length * 0.9)]} max ${lag[lag.length - 1]}`);
const recent = all.slice(-5).map((p) => `${p.punched_at}->${p.received_at}`); console.log(`BIOD last 5 punch->received ${recent.join(' | ')}`);
const pp = await get('bio_people?select=device_code,essl_code,essl_name,email,matched&order=essl_name');
const ro = await get('staff_roster?select=email,full_name,employee_code,hub_name');
const rm = new Map(ro.map((r) => [r.email, r]));
const active = new Set(all.map((p) => p.device_code));
const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
let m = 0, u = 0;
for (const p of pp) {
  const r = rm.get(p.email);
  if (p.email) { m++; const sim = norm(r?.full_name).slice(0, 4) === norm(p.essl_name).slice(0, 4) ? 'ok' : 'CHECK';
    console.log(`BIOM ${sim} ${p.matched} essl[${p.device_code}|${p.essl_code}|${p.essl_name}] -> [${r?.employee_code}|${r?.full_name}|${r?.hub_name}] punchedThisMonth=${active.has(p.device_code)}`); }
  else { u++; console.log(`BIOU essl[${p.device_code}|${p.essl_code}|${p.essl_name}] punchedThisMonth=${active.has(p.device_code)}`); }
}
console.log(`BIOM matched ${m} unmatched ${u} people ${pp.length}; codes punching this month ${active.size}`);
const notOnEssl = ro.filter((r) => r.hub_name === 'Chennai' && !pp.some((p) => p.email === r.email));
console.log(`BIOR Chennai roster not linked to eSSL (${notOnEssl.length}): ${notOnEssl.map((r) => `${r.employee_code}|${r.full_name}`).join('; ')}`);
// what HR now sees: matched people per day with the 20-minute rule and the 10:00 / 10:05 colours
const rpc = async (f, b) => (await fetch(`${SUPA_URL}/rest/v1/rpc/${f}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const att = await rpc('bio_attendance', { p_from: today.slice(0, 8) + '01', p_to: today });
const sett = await get('settings?select=key,value&key=in.(office_start,late_until,bio_gap_min)');
console.log(`BIOA settings ${JSON.stringify(sett)}`);
const per = {}; for (const a of att) { const k = a.day; per[k] = per[k] || { people: 0, ok: 0, warn: 0, bad: 0, out: 0 }; per[k].people++; per[k][a.band]++; if (a.out_at) per[k].out++; }
for (const [k, v] of Object.entries(per).sort()) console.log(`BIOA ${k} matched ${v.people} · green ${v.ok} yellow ${v.warn} red ${v.bad} · out ${v.out}`);
const istT = (t) => t ? new Date(new Date(t).getTime() + 330 * 60000).toISOString().slice(11, 16) : '—';
for (const a of att.filter((x) => x.day === today).sort((x, y) => x.in_at.localeCompare(y.in_at))) console.log(`BIOT ${a.email.split('@')[0]} in ${istT(a.in_at)} ${a.band} out ${istT(a.out_at)} raw ${a.punches}`);
