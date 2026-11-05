// Diagnostic: is selfie storage on AWS working? Signs in as the Tech admin (no email sent) and asks the
// check-in server's health check, which writes and deletes a test file in the bucket. Prints names only, never keys.
const { SUPA_URL, ANON, SERVICE } = process.env;
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const techs = await (await fetch(`${SUPA_URL}/rest/v1/profiles?select=email&role=eq.tech&active=eq.true`, { headers: svc })).json();
const TECH = techs[0]?.email ?? 'ai@startuptn.in';
console.log(`AWS tech logins: ${techs.length}`);
const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email: TECH }) })).json();
const s = await (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
if (!s.access_token) { console.log('AWS could not sign in as Tech admin'); process.exit(1); }
const res = await fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' }, body: '{"action":"health"}' });
const raw = await res.text(); let r = {}; try { r = JSON.parse(raw); } catch { /* not json */ }
console.log(`AWS health HTTP ${res.status} ${raw.slice(0, 200)}`);
console.log(`AWS storage=${r.storage} bucket=${r.bucket} region=${r.region} write+delete=${r.s3_ok} error=${r.s3_error ?? '-'} face_match=${r.face_match}`);
// where today's selfies went
const since = new Date(Date.now() - 864e5).toISOString();
const ps = await (await fetch(`${SUPA_URL}/rest/v1/punches?select=selfie_key,server_time&server_time=gte.${since}&order=server_time.desc&limit=5`, { headers: svc })).json();
console.log(`AWS recent selfies: ${ps.length}`);
if (r.storage !== 's3' || r.s3_ok !== true) process.exitCode = 1;
