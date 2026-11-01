// Diagnostic: recent map-link failures recorded by the check-in function (edge logs, last 6 hours).
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const end = new Date(), start = new Date(Date.now() - 6 * 3600e3);
const sql = "select timestamp, event_message from function_logs where event_message like '%resolve_venue%' order by timestamp desc limit 20";
const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs.all?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}`;
const r = await fetch(u, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } });
const j = await r.json();
console.log(r.status);
for (const x of j.result ?? []) console.log(new Date(Number(x.timestamp) / 1000).toISOString(), x.event_message);
if (!j.result) console.log(JSON.stringify(j).slice(0, 500));
