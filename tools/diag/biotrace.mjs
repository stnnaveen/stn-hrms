// Diagnostic: why a staff member shows no fingerprint. Finds their eSSL code(s), punches under any code variant,
// and punch codes that are not linked to any eSSL person (case or format differences).
const { SUPA_URL, SERVICE, WHO = 'akila,lakshmi' } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const get = async (q) => (await fetch(`${SUPA_URL}/rest/v1/${q}`, { headers: h })).json();
const pp = await get('bio_people?select=device_code,essl_code,essl_name,email,matched,updated_at');
const ro = await get('staff_roster?select=email,full_name,employee_code,hub_name');
let all = [], from = 0;
for (;;) { const r = await (await fetch(`${SUPA_URL}/rest/v1/bio_punches?select=essl_table,essl_log_id,essl_device_id,device_code,punched_at&order=punched_at`, { headers: { ...h, Range: `${from}-${from + 999}` } })).json(); all = all.concat(r); if (r.length < 1000) break; from += 1000; }
console.log(`TR punches stored total ${all.length}; by table ${JSON.stringify(all.reduce((m, p) => (m[p.essl_table] = (m[p.essl_table] || 0) + 1, m), {}))}`);
for (const t of [...new Set(all.map((p) => p.essl_table))]) { const ids = all.filter((p) => p.essl_table === t).map((p) => p.essl_log_id).sort((a, b) => a - b); const gaps = []; for (let i = 1; i < ids.length; i++) if (ids[i] !== ids[i - 1] + 1) gaps.push(`${ids[i - 1]}..${ids[i]}`); console.log(`TR ${t} ids ${ids[0]}..${ids[ids.length - 1]} count ${ids.length} gaps ${gaps.length ? gaps.slice(0, 20).join(',') : 'none'}`); }
const codes = new Set(pp.map((p) => p.device_code));
const orphan = {}; for (const p of all) if (!codes.has(p.device_code)) orphan[p.device_code] = (orphan[p.device_code] || 0) + 1;
console.log(`TR punch codes with no eSSL person: ${JSON.stringify(orphan)}`);
const lower = {}; for (const c of codes) { const k = c.toLowerCase().replace(/^0+/, ''); (lower[k] = lower[k] || []).push(c); }
console.log(`TR people codes that differ only by case/leading zeros: ${JSON.stringify(Object.values(lower).filter((v) => v.length > 1))}`);
for (const w of WHO.split(',')) {
  console.log(`TR ---- ${w}`);
  for (const r of ro.filter((r) => r.full_name.toLowerCase().includes(w))) console.log(`TR roster ${r.employee_code} | ${r.full_name} | ${r.hub_name} | ${r.email}`);
  for (const p of pp.filter((p) => (p.essl_name ?? '').toLowerCase().includes(w) || ro.some((r) => r.email === p.email && r.full_name.toLowerCase().includes(w)))) {
    const n = all.filter((x) => x.device_code === p.device_code), ci = all.filter((x) => x.device_code.toLowerCase() === p.device_code.toLowerCase());
    console.log(`TR essl code[${p.device_code}] essl[${p.essl_code}|${p.essl_name}] -> ${p.email} (${p.matched}, ${p.updated_at}) punches exact ${n.length} any-case ${ci.length} last ${n.length ? n[n.length - 1].punched_at : '-'}`);
  }
}
