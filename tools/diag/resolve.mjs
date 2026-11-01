// Diagnostic: send map links to the live server's resolve_venue (signed in as the test staff account) and print the answers.
const { SUPA_URL, SERVICE, ANON, LINKS } = process.env;
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email: 'naveenflop+staff@gmail.com' }) })).json();
const v = await (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
if (!v.access_token) { console.log('sign-in failed', JSON.stringify(v).slice(0, 200)); process.exit(1); }
for (const link of LINKS.split(/\s+/).filter(Boolean)) {
  const t0 = Date.now();
  const r = await fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${v.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resolve_venue', url: link }) });
  console.log(`>> ${link}\n   ${r.status} ${Date.now() - t0} ms ${(await r.text()).slice(0, 300)}`);
}
