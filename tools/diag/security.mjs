// Live security check: what a signed-out visitor and a signed-in staff member (the test staff) can and cannot do.
// Read-only apart from attempted writes that must be refused. Prints PASS / FAIL per check.
const { SUPA_URL, SERVICE, ANON } = process.env;
let fails = 0;
const out = (ok, what) => { if (!ok) fails++; console.log(`SEC ${ok ? 'PASS' : 'FAIL'} ${what}`); };
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const anonH = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
const TABLES = ['attendance_days', 'audit_log', 'chairman_availability', 'custom_roles', 'devices', 'flags', 'geo_cache', 'hubs', 'leave_requests', 'notifications', 'od_requests', 'profiles', 'punches', 'settings', 'staff_roster', 'hub_directory', 'my_punches', 'presence_samples', 'bio_links', 'bio_status', 'bio_devices', 'bio_people', 'bio_punches', 'bio_audit', 'bio_essl_days', 'holidays', 'day_marks'];
const RPCS = { my_today: {}, hr_today: {}, setting: { p_key: 'radius_m' }, purge_records: { p_scope: 'all', p_dry: true }, delete_staff_full: { p_email: 'x@y.z' }, add_role_login: { p_email: 'x@y.z', p_role: 'tech' }, set_setting: { p_key: 'x', p_value: '1' }, verify_audit_chain: {}, presence_day: { p_user: '00000000-0000-0000-0000-000000000000' }, presence_today: {}, ask_punch_reason: { p_punch: '00000000-0000-0000-0000-000000000000', p_kind: 'late' }, bulk_upsert_staff: { rows: [] }, set_test_mode: { p_email: 'x', p_on: false }, notify_role: { p_role: 'hr', p_kind: 'x', p_title: 'x', p_body: 'x', p_data: {} }, append_audit: {},
  bio_new_key: { p_name: 'x' }, bio_ingest: { p_link: '00000000-0000-0000-0000-000000000000', p: {} }, bio_range: { p_from: '2026-11-01', p_to: '2026-11-02' }, bio_attendance: { p_from: '2026-11-01', p_to: '2026-11-02' },
  hr_person_days: { p_email: 'x@y.z', p_from: '2026-11-01', p_to: '2026-11-02' }, person_days_merged: { p_email: 'x@y.z', p_from: '2026-11-01', p_to: '2026-11-02' },
  save_holiday: { p_day: '2026-11-20', p_name: 'x', p_kind: 'office' }, delete_holiday: { p_day: '2026-11-20' }, set_day_mark: { p_email: 'x@y.z', p_day: '2026-11-09', p_mark: 'absent' },
  set_reports_to: { p_email: 'x@y.z', p_reports_to: null }, set_approver: { p_kind: 'leave', p_value: 'hr' }, pending_routes: {}, my_approvals: {}, my_fingerprint: {}, my_month: {}, bio_verify: { p_from: '2026-11-01', p_to: '2026-11-02' } };
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
for (const t of ['presence_samples', 'audit_log', 'staff_roster', 'settings', 'geo_cache', 'custom_roles', 'bio_links', 'bio_status', 'bio_devices', 'bio_people', 'bio_punches', 'bio_audit', 'bio_essl_days', 'day_marks']) { const [c, j] = await sel(st, t); out(c >= 400 || (Array.isArray(j) && j.length === 0), `staff: ${t} hidden (${c}, ${Array.isArray(j) ? j.length : '-'})`); }
for (const t of ['devices', 'punches', 'attendance_days', 'flags', 'od_requests', 'leave_requests', 'notifications', 'profiles']) {
  const [c, j] = await sel(st, `${t}`); const others = Array.isArray(j) ? j.filter((x) => (x.user_id ?? x.id) !== me).length : 0;
  out(c >= 400 || others === 0, `staff: ${t} shows only own rows (${c}, others ${others})`);
}
{ const [c, j] = await sel(st, 'punches'); const leak = Array.isArray(j) && j.some((x) => 'distance_m' in x || 'inside' in x || 'face_similarity' in x); out(c >= 400 || !leak, `staff: no distance / inside / face score readable from punches (${c})`); }
{ const [c, j] = await sel(st, 'my_punches'); const leak = Array.isArray(j) && j.some((x) => Object.keys(x).some((k) => /distance|inside|radius|face|flag|accuracy|quality/.test(k))); out(!leak, `staff: my_punches has no hidden-check fields (${c})`); }
{ const [c, j] = await sel(st, 'hub_directory'); const leak = Array.isArray(j) && j.some((x) => Object.keys(x).some((k) => /lat|lng|radius/.test(k))); out(!leak, `staff: hub_directory has no pin or radius (${c})`); }
{ const [c, j] = await rpc(st, 'my_today', {}); out(c === 200 && !/distance|inside|radius|face_sim|flag/.test(j), `staff: my_today has no hidden-check fields (${c})`); }
for (const f of ['presence_day', 'presence_today', 'ask_punch_reason', 'hr_today', 'purge_records', 'delete_staff_full', 'add_role_login', 'set_setting', 'verify_audit_chain', 'bulk_upsert_staff', 'set_test_mode', 'decide_od', 'decide_flag']) {
  const b = RPCS[f] ?? (f === 'decide_od' ? { p_id: '00000000-0000-0000-0000-000000000000', p_decision: 'approved' } : { p_flag: '00000000-0000-0000-0000-000000000000', p_decision: 'valid' });
  const [c, t] = await rpc(st, f, b); out(c >= 400, `staff: rpc ${f} refused (${c} ${t.slice(0, 50)})`);
}
for (const f of ['bio_new_key', 'bio_ingest', 'save_holiday', 'delete_holiday', 'set_day_mark', 'set_reports_to', 'set_approver', 'hr_person_days', 'pending_routes', 'person_days_merged']) { const [c, t] = await rpc(st, f, RPCS[f] ?? {}); out(c >= 400, `staff: ${f} refused (${c} ${t.slice(0, 60)})`); }
for (const f of ['bio_range', 'bio_attendance']) { const [c, t] = await rpc(st, f, RPCS[f]); out(c >= 400 || t.trim() === '[]', `staff: ${f} returns nothing (${c})`); }
{ const [c, t] = await rpc(st, 'my_month', {}); out(c === 200 && !/radius|distance|inside|flag|face/.test(t), `staff: own calendar has no check details (${c})`); }
for (const f of ['setting', 'notify_role', 'append_audit', 'is_test_user']) { const [c] = await rpc(st, f, RPCS[f] ?? {}); out(c >= 400, `staff: internal ${f} not callable (${c})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/profiles?id=eq.${me}`, { method: 'PATCH', headers: { ...st, Prefer: 'return=representation' }, body: JSON.stringify({ role: 'tech' }) }); const j = await r.json().catch(() => null); out(r.status >= 400 || !(Array.isArray(j) && j[0]?.role === 'tech'), `staff: cannot make self Tech (${r.status})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/audit_log?id=gt.0`, { method: 'DELETE', headers: { ...st, Prefer: 'return=representation' } }); const j = await r.json().catch(() => null); out(r.status >= 400 || (Array.isArray(j) && j.length === 0), `staff: cannot delete audit log (${r.status})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/hubs?name=eq.Chennai`, { method: 'PATCH', headers: { ...st, Prefer: 'return=representation' }, body: JSON.stringify({ radius_m: 5000 }) }); const j = await r.json().catch(() => null); out(r.status >= 400 || (Array.isArray(j) && j.length === 0), `staff: cannot widen a hub radius (${r.status})`); }
for (const a of ['selfie_urls', 'purge', 'delete_person', 'remove_selfie', 'radius_test', 'health']) { const [c, t] = await fn(st, { action: a, keys: [], email: 'x@y.z', punch_id: '00000000-0000-0000-0000-000000000000', reason: 'x', scope: 'all', dry: true }); out(c >= 400, `staff: function ${a} refused (${c} ${t.slice(0, 40)})`); }
{ const r = await fetch(`${SUPA_URL}/storage/v1/object/list/selfies`, { method: 'POST', headers: st, body: JSON.stringify({ prefix: '' }) }); const j = await r.json().catch(() => null); out(r.status >= 400 || (Array.isArray(j) && j.length === 0), `staff: cannot list selfie files (${r.status})`); }
// clean refusals never mention checks
{ const [c, t] = await fn(st, { action: 'punch' }); out(!/radius|distance|inside|outside|flag|face/i.test(t), `staff: error replies never mention checks (${c} ${t.slice(0, 40)})`); }
{ const [c, t] = await fn(st, { action: 'presence', samples: [{ lat: 13.0, lng: 80.2, accuracy: 10, time: Date.now(), source: 'watch' }] }); out(c === 200 && !/inside|outside|distance|radius/i.test(t), `staff: presence reply says nothing about inside/outside (${c} ${t.slice(0, 40)})`); }
{ const [c, t] = await fn(st, { action: 'presence_token' }); const tok = (() => { try { return JSON.parse(t).token; } catch { return null; } })();
  out(c === 200 && !!tok, `staff: gets a phone token for background location (${c})`);
  const post = (token) => fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'POST', headers: { ...anonH, 'x-presence-token': token }, body: JSON.stringify({ action: 'presence', samples: [{ coords: { latitude: 13, longitude: 80.2, accuracy: 10 }, timestamp: new Date().toISOString(), is_moving: false }] }) }).then(async (r) => [r.status, (await r.text()).slice(0, 80)]);
  if (tok) {
    const [ok, okt] = await post(tok); out(ok === 200 && !/inside|outside|distance/i.test(okt), `background post with the phone token accepted, says nothing (${ok} ${okt})`);
    const bad = tok.slice(0, -3) + (tok.endsWith('AAA') ? 'BBB' : 'AAA'); const [no] = await post(bad); out(no === 401, `forged phone token refused (${no})`);
    const [no2] = await post('eyJ1IjoieCIsImUiOjk5OTk5OTk5OTl9.abc'); out(no2 === 401, `made-up phone token refused (${no2})`);
  } }
{ const [c] = await fn(anonH, { action: 'presence_token' }); out(c === 401, `signed out: no phone token (${c})`); }
// ---- 9 Nov hardening: admin list, rate limits, CORS, sign-in
for (const f of ['rate_limit', 'admin_email_ok', 'guard_admin_email']) {
  const b = f === 'rate_limit' ? { p_key: 'x', p_max: 1, p_window_s: 60 } : f === 'admin_email_ok' ? { p_email: 'x@y.z' } : {};
  const [a] = await rpc(anonH, f, b); const [c] = await rpc(st, f, b); out(a >= 400 && c >= 400, `internal ${f} not callable signed out or as staff (${a}, ${c})`);
}
{ const [a] = await sel(anonH, 'rate_hits'); const [c, j] = await sel(st, 'rate_hits'); out((a >= 400) && (c >= 400 || (Array.isArray(j) && j.length === 0)), `rate_hits unreadable (${a}, ${c})`); }
{ const [c, t] = await rpc(st, 'add_role_login', { p_email: 'evil@gmail.com', p_name: 'x', p_role: 'hr' }); out(c >= 400, `staff: cannot add an admin login (${c} ${t.slice(0, 40)})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/staff_roster?select=email&role=in.(hr,chairman,tech)`, { headers: svc }); const j = await r.json().catch(() => []);
  const ok = ['hr@startuptn.in', 'hr.ai@startuptn.in', 'chairmanoffice@startuptn.in', 'chairman.ai@startuptn.in', 'ai@startuptn.in'];
  const bad = (Array.isArray(j) ? j : []).filter((x) => !ok.includes(x.email)).length; out(r.ok && bad === 0, `only approved emails hold admin roles (${Array.isArray(j) ? j.length : '-'} admin logins, ${bad} outside the list)`); }
for (const [origin, want] of [['https://stn-hrms.vercel.app', true], ['https://evil.example.com', false]]) {
  const r = await fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
  const acao = r.headers.get('access-control-allow-origin'); out(want ? acao === origin : !acao || acao !== origin && acao !== '*', `CORS ${want ? 'allows the app' : 'refuses other sites'} (${acao ?? 'none'})`);
}
{ const r = await fetch(`${SUPA_URL}/functions/v1/bio-sync`, { method: 'POST', headers: { 'x-bio-key': 'stnbio_' + '0'.repeat(64), 'Content-Type': 'application/json' }, body: '{}' }); out(r.status === 401, `fingerprint sync refuses a wrong key (${r.status})`); }
{ const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'hr.ai@startuptn.in', password: '00000000' }) }); out(r.status === 400 || r.status === 429, `wrong test code refused (${r.status})`); }
// ---- 10 Nov: check-in method per hub, merged board, help contact
for (const [f, b] of [['hr_board', { p_from: '2026-11-01', p_to: '2026-11-02' }], ['set_hub_checkin', { p_hub: '00000000-0000-0000-0000-000000000000', p_method: 'selfie' }], ['attendance_merged', { p_from: '2026-11-01', p_to: '2026-11-02' }], ['checkin_context', { p_email: 'x@y.z' }], ['checkin_method_of', { p_email: 'x@y.z' }]]) {
  const [a] = await rpc(anonH, f, b); const [c] = await rpc(st, f, b); out(a >= 400 && c >= 400, `${f} refused signed out and for staff (${a}, ${c})`);
}
{ const [c, t] = await rpc(st, 'my_today', {}); let j = null; try { j = JSON.parse(t.length >= 120 ? '{}' : t); } catch { /* long */ }
  const [c2, full] = await fetch(`${SUPA_URL}/rest/v1/rpc/my_today`, { method: 'POST', headers: st, body: '{}' }).then(async (r) => [r.status, await r.text()]);
  void c; void j; out(c2 === 200 && /"checkin"/.test(full) && !/radius|distance|inside|flag|face_sim/i.test(full), `staff: my_today has the method and help, no check details (${c2})`); }
{ const [c] = await rpc(st, 'set_setting', { p_key: 'help_contact', p_value: { email: 'evil@x.com', whatsapp: '', phone: '' } }); out(c >= 400, `staff: cannot change the help contact (${c})`); }
// ---- 10 Nov: approvals timeline and clarity
{ const [a] = await sel(anonH, 'request_events'); const [c, j] = await sel(st, 'request_events'); out(a >= 400 && (c >= 400 || (Array.isArray(j) && j.length === 0)), `request_events unreadable directly (${a}, ${c})`); }
for (const [f, b] of [['request_timeline', { p_kind: 'leave', p_id: '00000000-0000-0000-0000-000000000000' }], ['ask_clarity', { p_kind: 'leave', p_id: '00000000-0000-0000-0000-000000000000', p_question: 'test?' }],
  ['reply_clarity', { p_kind: 'leave', p_id: '00000000-0000-0000-0000-000000000000', p_reply: 'x' }], ['routes_for', { p_email: 'x@y.z' }], ['log_request_event', { p_kind: 'leave', p_id: '00000000-0000-0000-0000-000000000000', p_action: 'approved', p_comment: null }]]) {
  const [a] = await rpc(anonH, f, b); const [c] = await rpc(st, f, b); out(a >= 400 && c >= 400, `${f} refused signed out and for staff on others' requests (${a}, ${c})`);
}
{ const r = await fetch(`${SUPA_URL}/rest/v1/request_events`, { method: 'POST', headers: st, body: JSON.stringify({ kind: 'leave', request_id: '00000000-0000-0000-0000-000000000000', action: 'approved' }) }); out(r.status >= 400, `staff cannot write a timeline step (${r.status})`); }
// ---- 10 Nov: per-staff approvers, one calendar, queries on HR marks
{ const [a] = await sel(anonH, 'mark_queries'); const [c, j] = await sel(st, 'mark_queries'); const others = Array.isArray(j) ? j.filter((x) => x.user_id !== me).length : 0; out(a >= 400 && (c >= 400 || others === 0), `mark_queries: only own rows (${a}, ${c}, others ${others})`); }
for (const [f, b] of [['set_staff_approver', { p_email: 'naveenflop+staff@gmail.com', p_kind: 'leave', p_value: 'hr' }], ['hr_person_month', { p_email: 'x@y.z', p_month: '2026-11-01' }], ['person_month', { p_email: 'x@y.z', p_month: '2026-11-01' }],
  ['decide_mark_query', { p_id: '00000000-0000-0000-0000-000000000000', p_decision: 'approved', p_comment: null }], ['request_route_email', { p_kind: 'leave', p_email: 'x@y.z' }]]) {
  const [a] = await rpc(anonH, f, b); const [c] = await rpc(st, f, b); out(a >= 400 && c >= 400, `${f} refused signed out and for staff (${a}, ${c})`);
}
{ const [c, t] = await fetch(`${SUPA_URL}/rest/v1/rpc/my_month`, { method: 'POST', headers: st, body: JSON.stringify({ p_month: '2026-11-01' }) }).then(async (r) => [r.status, await r.text()]); out(c === 200 && /"queries"/.test(t) && !/radius|distance|inside|flag|face/i.test(t), `staff: own calendar has queries, no check details (${c})`); }
{ const [c] = await rpc(st, 'raise_mark_query', { p_day: '2020-01-01', p_message: 'test' }); out(c >= 400, `staff: no query on an unmarked day (${c})`); }
{ const r = await fetch(`${SUPA_URL}/rest/v1/mark_queries`, { method: 'POST', headers: st, body: JSON.stringify({ email: 'x@y.z', user_id: me, day: '2026-11-01', mark: 'absent', message: 'x' }) }); out(r.status >= 400, `staff cannot write a query directly (${r.status})`); }
// ---- 11 Nov: phones never blocked, live tracking
{ const Z = '00000000-0000-0000-0000-000000000000';
  for (const [f, b] of [['phone_swaps', { p_user: Z }], ['notify_admins', { p_kind: 'x', p_title: 'x', p_body: 'x', p_data: {} }], ['presence_window', { p_user: Z }], ['presence_day_calc', { p_user: Z, p_day: '2026-11-01' }], ['presence_rows', { p_day: '2026-11-01' }], ['presence_watch', {}], ['presence_summary', { p_day: '2026-11-01' }]]) {
    const [a] = await rpc(anonH, f, b); const [c] = await rpc(st, f, b); out(a >= 400 && c >= 400, `internal ${f} not callable signed out or as staff (${a}, ${c})`);
  }
  for (const [f, b] of [['live_locations', {}], ['presence_board', { p_day: '2026-11-01' }]]) {
    const [a] = await rpc(anonH, f, b); const [c] = await rpc(st, f, b); out(a >= 400 && c >= 400, `${f}: HR and Chairman only (${a}, ${c})`);
  }
}
console.log(`SEC done: ${fails} failed`);
process.exit(fails ? 1 : 0);
