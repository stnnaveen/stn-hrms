// Diagnostic: ask for today's selfie links the way the HR app does (signed in as the HR test login) and check they open.
const { SUPA_URL, SERVICE, ANON } = process.env;
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const keys = (await (await fetch(`${SUPA_URL}/rest/v1/punches?select=selfie_key&selfie_key=not.is.null&server_time=gte.${day}T00:00:00%2B05:30`, { headers: svc })).json()).map((x) => x.selfie_key);
const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email: 'naveenflop@gmail.com' }) })).json();
const v = await (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
if (!v.access_token) { console.log('sign-in failed', JSON.stringify(v).slice(0, 200)); process.exit(1); }
const r = await fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${v.access_token}`, 'Content-Type': 'application/json', 'x-client-info': 'supabase-js-web/2' }, body: JSON.stringify({ action: 'selfie_urls', keys }) });
const t = await r.text();
console.log('SV status', r.status, 'keys', keys.length);
let j = {}; try { j = JSON.parse(t); } catch { console.log('SV body', t.slice(0, 300)); }
for (const [k, u] of Object.entries(j.urls ?? {})) {
  let st = 'null';
  if (u) { const x = await fetch(u); st = `${x.status} ${x.headers.get('content-type')} ${x.headers.get('content-length')}`; }
  console.log('SV', k.split('/').slice(-1)[0].slice(0, 8), st, u ? new URL(u).host + new URL(u).pathname.slice(0, 40) : '');
}
if (j.error) console.log('SV error', j.error);
