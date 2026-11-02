// Set the fixed test code (password) on the test and demo logins ONLY, creating the demo accounts if needed,
// then check each signs in. Refuses any other address. Remove these logins before the pilot.
const { SUPA_URL, SERVICE, ANON, CODE } = process.env;
const LOGINS = ['naveenflop+staff@gmail.com', 'naveenflop@gmail.com', 'naveenbackup7@gmail.com', 'hr.ai@startuptn.in', 'chairman.ai@startuptn.in'];
if (!/^\d{8}$/.test(CODE ?? '')) { console.log('TC code must be 8 digits'); process.exit(1); }
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const users = await (await fetch(`${SUPA_URL}/auth/v1/admin/users?per_page=1000`, { headers: h })).json();
const signIn = (email, password) => fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
for (const email of LOGINS) {
  const [ro] = await (await fetch(`${SUPA_URL}/rest/v1/staff_roster?select=email,role&email=eq.${encodeURIComponent(email)}`, { headers: h })).json();
  if (!ro) { console.log(`TC ${email}: not on the roster, skipped`); continue; }
  let u = (users.users ?? []).find((x) => x.email === email);
  if (!u) {
    const r = await fetch(`${SUPA_URL}/auth/v1/admin/users`, { method: 'POST', headers: h, body: JSON.stringify({ email, email_confirm: true, password: CODE }) });
    const j = await r.json(); if (!r.ok) { console.log(`TC ${email}: create failed ${r.status} ${JSON.stringify(j).slice(0, 120)}`); continue; }
    u = j; console.log(`TC ${email}: account created (${ro.role})`);
  } else {
    const r = await fetch(`${SUPA_URL}/auth/v1/admin/users/${u.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ password: CODE }) });
    console.log(`TC ${email}: code set ${r.status} (${ro.role})`);
  }
  const [pr] = await (await fetch(`${SUPA_URL}/rest/v1/profiles?select=role,active&id=eq.${u.id}`, { headers: h })).json();
  console.log(`TC ${email}: sign-in with code ${(await signIn(email, CODE)).status} · profile ${pr?.role ?? 'none'} ${pr?.active ? 'active' : 'inactive'}`);
}
console.log('TC wrong code refused', (await signIn('hr.ai@startuptn.in', '00000000')).status);
console.log('TC same code on a real account refused', (await signIn('naveen@startuptn.in', CODE)).status);
