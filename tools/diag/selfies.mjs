// Diagnostic: today's check-ins and whether each selfie file exists where the punch says it is.
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const ps = await (await fetch(`${SUPA_URL}/rest/v1/punches?select=id,user_id,kind,server_time,selfie_key,selfie_store,selfie_removed,timings&server_time=gte.${day}T00:00:00%2B05:30&order=server_time`, { headers: h })).json();
const profs = await (await fetch(`${SUPA_URL}/rest/v1/profiles?select=id,email&id=in.(${[...new Set(ps.map((p) => p.user_id))].join(',') || '00000000-0000-0000-0000-000000000000'})`, { headers: h })).json();
const em = new Map(profs.map((p) => [p.id, p.email]));
for (const p of ps) {
  let exists = '—';
  if (p.selfie_key) {
    const path = p.selfie_key.replace(/^selfies\//, ''), dir = path.split('/').slice(0, -1).join('/'), file = path.split('/').pop();
    const l = await (await fetch(`${SUPA_URL}/storage/v1/object/list/selfies`, { method: 'POST', headers: h, body: JSON.stringify({ prefix: dir, search: file }) })).json();
    exists = Array.isArray(l) ? (l.some((x) => x.name === file) ? `in Supabase (${l.find((x) => x.name === file)?.metadata?.size} B)` : 'NOT in Supabase') : JSON.stringify(l).slice(0, 100);
  }
  console.log(`${p.server_time.slice(11, 19)} ${p.kind} ${em.get(p.user_id)} store=${p.selfie_store} key=${p.selfie_key ? 'yes' : 'no'} ${exists} removed=${!!p.selfie_removed} timings=${JSON.stringify(p.timings)}`);
}
const st = await (await fetch(`${SUPA_URL}/storage/v1/bucket/selfies`, { headers: h })).json();
console.log('bucket', JSON.stringify(st).slice(0, 300));
