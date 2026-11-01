// Set the fixed test code (password) on the test staff login only, then check it signs in. Refuses any other account.
const { SUPA_URL, SERVICE, ANON, CODE } = process.env;
const EMAIL = 'naveenflop+staff@gmail.com';
if (!/^\d{8}$/.test(CODE ?? '')) { console.log('TC code must be 8 digits'); process.exit(1); }
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const [ro] = await (await fetch(`${SUPA_URL}/rest/v1/staff_roster?select=email,is_test&email=eq.${encodeURIComponent(EMAIL)}`, { headers: h })).json();
if (!ro?.is_test) { console.log('TC refused: not a test account'); process.exit(1); }
const users = await (await fetch(`${SUPA_URL}/auth/v1/admin/users?per_page=1000`, { headers: h })).json();
const u = (users.users ?? []).find((x) => x.email === EMAIL);
if (!u) { console.log('TC test staff has not signed up'); process.exit(1); }
const r = await fetch(`${SUPA_URL}/auth/v1/admin/users/${u.id}`, { method: 'PUT', headers: h, body: JSON.stringify({ password: CODE }) });
console.log('TC set code', r.status, r.ok ? '' : (await r.text()).slice(0, 200));
const s = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: CODE }) });
console.log('TC sign-in with code', s.status);
const bad = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: '00000000' }) });
console.log('TC wrong code refused', bad.status);
const other = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'naveen@startuptn.in', password: CODE }) });
console.log('TC same code on a real account refused', other.status);
