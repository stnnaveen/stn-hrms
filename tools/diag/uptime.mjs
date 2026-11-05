// Uptime + speed check: the app site, sign-in service, database API, check-in server, photo storage.
// Each target is hit SAMPLES times; prints p50 / p95 / max and fails the run if anything is down.
const { SUPA_URL, ANON, SERVICE, SAMPLES = '10', APP_URL = '' } = process.env;
const n = Number(SAMPLES);
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
async function time(fn) { const t0 = performance.now(); try { const ok = await fn(); return { ms: Math.round(performance.now() - t0), ok }; } catch { return { ms: Math.round(performance.now() - t0), ok: false }; } }
// the app's address: repo variable APP_URL, else Vercel's usual production names
let site = APP_URL;
if (!site) for (const u of ['https://stn-hrms.vercel.app', 'https://stn-hrms-startuptn.vercel.app', 'https://stn-hrms-git-main-startuptn.vercel.app']) {
  try { const r = await fetch(u, { redirect: 'follow' }); const t = await r.text(); if (r.ok && /StartupTN/i.test(t)) { site = u; break; } } catch { /* next */ }
}
// staff session for the database check (test staff, read-only call)
const svc = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const g = await (await fetch(`${SUPA_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: svc, body: JSON.stringify({ type: 'magiclink', email: 'naveenflop+staff@gmail.com' }) })).json();
const s = await (await fetch(`${SUPA_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: g.hashed_token ?? g.properties?.hashed_token }) })).json();
const user = { apikey: ANON, Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' };
const targets = {
  'App site (opens the app)': site ? () => fetch(site, { cache: 'no-store' }).then((r) => r.ok) : null,
  'Sign-in service': () => fetch(`${SUPA_URL}/auth/v1/health`, { headers: { apikey: ANON } }).then((r) => r.ok),
  'Database (staff home data)': () => fetch(`${SUPA_URL}/rest/v1/rpc/my_today`, { method: 'POST', headers: user, body: '{}' }).then((r) => r.ok),
  'Check-in server (warm-up)': () => fetch(`${SUPA_URL}/functions/v1/check-in`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' }, body: '{"action":"ping"}' }).then((r) => r.ok),
  'Photo storage': () => fetch(`${SUPA_URL}/storage/v1/bucket/selfies`, { headers: svc }).then((r) => r.ok)
};
let down = 0, md = `## StartupTN HR · uptime and speed\n\nApp: ${site || 'address not found (set repo variable APP_URL)'}\n\n| Service | Up | Typical | 95% within | Slowest |\n|---|---|---|---|---|\n`;
for (const [name, fn] of Object.entries(targets)) {
  if (!fn) { md += `| ${name} | ? | | | |\n`; continue; }
  const rs = []; for (let i = 0; i < n; i++) rs.push(await time(fn));
  const ok = rs.filter((r) => r.ok).length, ms = rs.map((r) => r.ms);
  if (ok < n) down++;
  md += `| ${name} | ${ok}/${n} | ${pct(ms, 0.5)} ms | ${pct(ms, 0.95)} ms | ${Math.max(...ms)} ms |\n`;
  console.log(`UP ${name}: ${ok}/${n} up · p50 ${pct(ms, 0.5)} ms · p95 ${pct(ms, 0.95)} ms · max ${Math.max(...ms)} ms`);
}
console.log(`UP site ${site || 'not found'}`);
// eSSL sync PC: it reports every 30 s; quiet for 10+ minutes counts as down and tells the Tech admin (once in 2 hours)
try {
  const links = await (await fetch(`${SUPA_URL}/rest/v1/bio_links?select=id,name&revoked_at=is.null`, { headers: svc })).json();
  for (const l of Array.isArray(links) ? links : []) {
    const [st] = await (await fetch(`${SUPA_URL}/rest/v1/bio_status?select=last_seen,info&link_id=eq.${l.id}`, { headers: svc })).json();
    if (!st) { console.log(`UP eSSL sync (${l.name}): not installed yet`); md += `| eSSL sync PC (${l.name}) | not installed yet | | | |\n`; continue; }
    const age = Math.round((Date.now() - new Date(st.last_seen).getTime()) / 1000);
    const ok = age <= 600;
    console.log(`UP eSSL sync (${l.name}): last report ${age} s ago${st.info?.last_error ? ` · error: ${st.info.last_error}` : ''}`);
    md += `| eSSL sync PC (${l.name}) | ${ok ? 'yes' : 'NO'} | last report ${age} s ago | | |\n`;
    if (!ok) {
      down++;
      const since = new Date(Date.now() - 2 * 3600e3).toISOString();
      const recent = await (await fetch(`${SUPA_URL}/rest/v1/notifications?select=id&kind=eq.bio_down&created_at=gte.${since}&limit=1`, { headers: svc })).json();
      if (!recent.length) await fetch(`${SUPA_URL}/rest/v1/rpc/notify_role`, { method: 'POST', headers: svc, body: JSON.stringify({ p_role: 'tech', p_kind: 'bio_down', p_title: 'Biometric sync stopped', p_body: `${st.info?.pc ?? l.name} last reported ${Math.round(age / 60)} min ago`, p_data: {} }) });
    }
  }
} catch (e) { console.log(`UP eSSL sync check skipped: ${e.message}`); }
if (process.env.GITHUB_STEP_SUMMARY) (await import('node:fs')).appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
process.exit(down ? 1 : 0);
