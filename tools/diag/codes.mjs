// Diagnostic: shape of employee codes in the roster and profiles (patterns only, no names), for eSSL matching.
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const shape = (c) => c == null ? '(none)' : c.replace(/[A-Za-z]/g, 'A').replace(/[0-9]/g, '9');
for (const [t, q] of [['staff_roster', 'employee_code,hub_name,role'], ['profiles', 'employee_code,role,active']]) {
  const rows = await (await fetch(`${SUPA_URL}/rest/v1/${t}?select=${q}&limit=1000`, { headers: h })).json();
  const by = {};
  for (const r of rows) { const k = shape(r.employee_code); by[k] = (by[k] || 0) + 1; }
  console.log(`CODES ${t} rows=${rows.length} shapes=${JSON.stringify(by)}`);
  console.log(`CODES ${t} sample=${rows.map(r => r.employee_code).filter(Boolean).slice(0, 12).join(',')}`);
  if (t === 'staff_roster') { const hubs = {}; for (const r of rows) hubs[r.hub_name] = (hubs[r.hub_name] || 0) + 1; console.log(`CODES hubs=${JSON.stringify(hubs)}`); }
}
