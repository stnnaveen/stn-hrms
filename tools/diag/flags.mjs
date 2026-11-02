// Diagnostic: open disputes from the last 7 days by type (names and distances only).
const { SUPA_URL, SERVICE } = process.env;
const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
const since = new Date(Date.now() - 7 * 864e5).toISOString();
const fl = await (await fetch(`${SUPA_URL}/rest/v1/flags?select=kind,status,rule,created_at,p:profiles!flags_user_id_fkey(full_name)&created_at=gte.${since}&order=created_at.desc&limit=50`, { headers: h })).json();
for (const f of fl) console.log(`FL ${f.created_at.slice(5, 16)} ${f.kind} ${f.status} ${f.p?.full_name} · ${f.rule}`);
