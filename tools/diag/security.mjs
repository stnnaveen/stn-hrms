// Live security check: what a signed-out visitor and a signed-in staff member (the test staff) can and cannot do.
// Read-only apart from attempted writes that must be refused. Prints PASS / FAIL per check.
const { SUPA_URL, SERVICE, ANON } = process.env;
let fails = 0;
const out = (ok, what) => { if (!ok) fails++; console.log(`SEC ${ok ? 'PASS' : 'FAIL'} ${what}`); };
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const anonH = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
const TABLES = ['attendance_days', 'audit_log', 'chairman_availability', 'custom_roles', 'devices', 'flags', 'geo_cache', 'hubs', 'leave_requests', 'notifications', 'od_requests', 'profiles', 'punches', 'settings', 'staff_roster', 'hub_directory', 'my_punches'];
const RPCS = { my_today: {}, hr_today: {}, setting: { p_key: 'radius_m' }, purge_records: { p_scope: 'all', p_dry: true }, delete_staff_full: { p_email: 'x@y.z' }, add_role_login: { p_email: 'x@y.z', p_role: 'tech' }, set_setting: { p_key: 'x', p_value: '1' }, verify_audit_chain: {}, bulk_upsert_staff: { rows: [] }, set_test_mode: { p_email: 'x', p_on: false }, notify_role: { p_role: 'hr', p_kind: 'x', p_title: 'x', p_body: 'x', p_data: {} }, append_audit: {} };
const sel = (h, t) => fetch(`${SUPA_URL}/rest/v1/${t}?select=*&limit=5`, { headers: h }).then(async (r) => [r.status, await r.json().catch(() => null)]);
const rpc = (h, f, b) => fetch(`${SUPA_URL}/rest/v1/rpc/${f}`, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(async (r) => [r.status, (await r.text()).slice(0, 120)]);
const fn = (h, b) => fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(async (r) => [r.status, (await r.text()).slice(0, 160)]);

// ---- signed out
for (const t of TABLES) { const [st, j] = await sel(anonH, t); out(st >= 400 || (Array.isArray(j) && j.length === 0), `signed out: ${t} shows nothing (${st}, ${Array.isArray(j) ? j.length : '-'} rows)`); }
for (const [f, b] of Object.entries(RPCS)) { const [st] = await rpc(anonH, f, b); out(st === 401 || st === 403 || st === 404, `signed out: rpc ${f} refused (${st})`); }
{ const [st] = await fn(anonH, { action: 'selfie_urls', keys: [] }); out(st === 401, `signed out: selfie links refused (${st})`); }
{ const r = await fetch(`${SUPA_URL}/storage/v1/object/public/selfies/x.jpg`); out(r.status >= 400, `signed out: selfie bucket not public (${r.status})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/staff_roster`, { method: 'POST', headers: anonH, body: JSON.stringify({ email: 'evil@x.com', full_name: 'Evil', role: 'tech' }) }); out(r.status >= 400, `signed out: cannot add to roster (${r.status})`); }

// ---- signed in as staff (test staff)
const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email: 'naveenflop+staff@gmail.com' }) })).json();
const s = await (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
const me = s.user?.id, st = { apikey: ANON, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' };
for (const t of ['audit_log', 'staff_roster', 'devices', 'settings', 'geo_cache', 'custom_roles']) { const [c, j] = await sel(st, t); out(c >= 400 || (Array.isArray(j) && j.length === 0), `staff: ${t} hidden (${c}, ${Array.isArray(j) ? j.length : '-'})`); }
for (const t of ['punches', 'attendance_days', 'flags', 'od_requests', 'leave_requests', 'notifications', 'profiles']) {
  const [c, j] = await sel(st, `${t}`); const others = Array.isArray(j) ? j.filter((x) => (x.user_id ?? x.id) !== me).length : 0;
  out(c >= 400 || others === 0, `staff: ${t} shows only own rows (${c}, others ${others})`);
}
{ const [c, j] = await sel(st, 'punches'); const leak = Array.isArray(j) && j.some((x) => 'distance_m' in x || 'inside' in x || 'face_similarity' in x); out(c >= 400 || !leak, `staff: no distance / inside / face score readable from punches (${c})`); }
{ const [c, j] = await sel(st, 'my_punches'); const leak = Array.isArray(j) && j.some((x) => Object.keys(x).some((k) => /distance|inside|radius|face|flag|accuracy|quality/.test(k))); out(!leak, `staff: my_punches has no hidden-check fields (${c})`); }
{ const [c, j] = await sel(st, 'hub_directory'); const leak = Array.isArray(j) && j.some((x) => Object.keys(x).some((k) => /lat|lng|radius/.test(k))); out(!leak, `staff: hub_directory has no pin or radius (${c})`); }
{ const [c, j] = await rpc(st, 'my_today', {}); out(c === 200 && !/distance|inside|radius|face_sim|flag/.test(j), `staff: my_today has no hidden-check fields (${c})`); }
for (const f of ['hr_today', 'purge_records', 'delete_staff_full', 'add_role_login', 'set_setting', 'verify_audit_chain', 'bulk_upsert_staff', 'set_test_mode', 'decide_od', 'decide_flag']) {
  const b = RPCS[f] ?? (f === 'decide_od' ? { p_id: '00000000-0000-0000-0000-000000000000', p_decision: 'approved' } : { p_flag: '00000000-0000-0000-0000-000000000000', p_decision: 'valid' });
  const [c, t] = await rpc(st, f, b); out(c >= 400, `staff: rpc ${f} refused (${c} ${t.slice(0, 50)})`);
}
for (const f of ['setting', 'notify_role', 'append_audit', 'is_test_user']) { const [c] = await rpc(st, f, RPCS[f] ?? {}); out(c >= 400, `staff: internal ${f} not callable (${c})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${me}`, { method: 'PATCH', headers: { ...st, Prefer: 'return=representation' }, body: JSON.stringify({ role: 'tech' }) }); const j = await r.json().catch(() => null); out(r.status >= 400 || !(Array.isArray(j) && j[0]?.role === 'tech'), `staff: cannot make self Tech (${r.status})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/audit_log?id=gt.0`, { method: 'DELETE', headers: { ...st, Prefer: 'return=representation' } }); const j = await r.json().catch(() => null); out(r.status >= 400 || (Array.isArray(j) && j.length === 0), `staff: cannot delete audit log (${r.status})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/hubs?name=eq.Chennai`, { method: 'PATCH', headers: { ...st, Prefer: 'return=representation' }, body: JSON.stringify({ radius_m: 5000 }) }); const j = await r.json().catch(() => null); out(r.status >= 400 || (Array.isArray(j) && j.length === 0), `staff: cannot widen a hub radius (${r.status})`); }
for (const a of ['selfie_urls', 'purge', 'delete_person', 'remove_selfie', 'radius_test', 'health']) { const [c, t] = await fn(st, { action: a, keys: [], email: 'x@y.z', punch_id: '00000000-0000-0000-0000-000000000000', reason: 'x', scope: 'all', dry: true }); out(c >= 400, `staff: function ${a} refused (${c} ${t.slice(0, 40)})`); }
{ const r = await fetch(`${SUPA_URL}/storage/v1/object/list/selfies`, { method: 'POST', headers: st, body: JSON.stringify({ prefix: '' }) }); const j = await r.json().catch(() => null); out(r.status >= 400 || (Array.isArray(j) && j.length === 0), `staff: cannot list selfie files (${r.status})`); }
// clean refusals never mention checks
{ const [c, t] = await fn(st, { action: 'punch' }); out(!/radius|distance|inside|outside|flag|face/i.test(t), `staff: error replies never mention checks (${c} ${t.slice(0, 40)})`); }
console.log(`SEC done: ${fails} failed`);
process.exit(fails ? 1 : 0);
