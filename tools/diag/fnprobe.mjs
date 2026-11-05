// Diagnostic: which check-in actions work right now (as the test staff login; nothing is saved).
const { SUPA_URL, ANON, SERVICE } = process.env;
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
async function session(email) {
  const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email }) })).json();
  const s = await (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
  return s.access_token;
}
const tok = await session('naveenflop+staff@gmail.com');
for (const body of [{ action: 'presence_token' }, { action: 'resolve_venue', url: '13.0108, 80.2206' }, { action: 'selfie_urls', keys: [] }]) {
  const t0 = Date.now();
  const r = await fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  console.log(`PROBE ${body.action}: HTTP ${r.status} ${Date.now() - t0} ms ${(await r.text()).replace(/"token":"[^"]+"/, '"token":"…"').slice(0, 140)}`);
}
