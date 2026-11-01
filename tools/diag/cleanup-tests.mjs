// One-off clean-up: remove every load-test leftover, and clear the test staff's check-in history (the account stays).
// Real staff and audit_log are never touched. Prints what it removed and what is left.
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const rest = async (path, init = {}) => { const r = await fetch(`${SUPA_URL}${path}`, { ...init, headers: { ...h, ...(init.headers ?? {}) } }); const t = await r.text(); if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null; };
const LT = encodeURIComponent('naveenflop+lt%'), TS = encodeURIComponent('naveenflop+staff@gmail.com');
// 1. load-test accounts still signed up (should be none) and the test staff
const ltProfiles = await rest(`/rest/v1/profiles?select=id,email&email=like.${LT}`);
const [ts] = await rest(`/rest/v1/profiles?select=id,email&email=eq.${TS}`);
const ids = [...ltProfiles.map((p) => p.id), ...(ts ? [ts.id] : [])];
console.log(`CL load-test profiles left: ${ltProfiles.length}; test staff: ${ts ? 'found' : 'not signed up yet'}`);
if (ids.length) {
  const inList = `(${ids.join(',')})`;
  const keys = (await rest(`/rest/v1/punches?select=selfie_key&user_id=in.${inList}`)).map((p) => p.selfie_key).filter(Boolean).map((k) => k.replace(/^selfies\//, ''));
  for (let i = 0; i < keys.length; i += 100) await fetch(`${SUPA_URL}/storage/v1/object/selfies`, { method: 'DELETE', headers: h, body: JSON.stringify({ prefixes: keys.slice(i, i + 100) }) });
  console.log(`CL photos removed: ${keys.length}`);
  for (const t of ['flags', 'attendance_days', 'punches', 'notifications', 'od_requests', 'leave_requests']) {
    const r = await rest(`/rest/v1/${t}?user_id=in.${inList}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
    console.log(`CL ${t}: ${r?.length ?? 0} removed`);
  }
  for (const p of ltProfiles) await fetch(`${SUPA_URL}/auth/v1/admin/users/${p.id}`, { method: 'DELETE', headers: h });
  await rest(`/rest/v1/devices?user_id=in.(${ltProfiles.map((p) => p.id).join(',') || '00000000-0000-0000-0000-000000000000'})`, { method: 'DELETE' });
}
// 2. alerts about load-test saves sent to Tech
const al = await rest(`/rest/v1/notifications?body=like.${encodeURIComponent('Load test%')}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
console.log(`CL Tech alerts about load test: ${al?.length ?? 0} removed`);
// 3. roster rows
const ro = await rest(`/rest/v1/staff_roster?email=like.${LT}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
console.log(`CL roster rows removed: ${ro?.length ?? 0}`);
// 4. what is left: test-marked roster rows and anything named like the load test
const tests = await rest(`/rest/v1/staff_roster?select=email,full_name,is_test,test_mode&is_test=eq.true`);
const named = await rest(`/rest/v1/staff_roster?select=email&full_name=like.${encodeURIComponent('Load test%')}`);
const users = await rest(`/auth/v1/admin/users?per_page=1000`);
const ltUsers = (users.users ?? []).filter((u) => /^naveenflop\+lt/.test(u.email ?? ''));
console.log(`CL left: test accounts ${JSON.stringify(tests.map((t) => t.email))}; "Load test" roster rows ${named.length}; load-test sign-ins ${ltUsers.length}; total roster ${(await rest('/rest/v1/staff_roster?select=email')).length}`);
