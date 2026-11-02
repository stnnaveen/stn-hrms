// Diagnostic: recent map-link failures recorded by the check-in function (edge logs, last 6 hours).
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const end = new Date(), start = new Date(Date.now() - 20 * 3600e3);
const run = async (sql) => {
  const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } });
  return [r.status, await r.json()];
};
for (const q of ['select * from logs limit 1', 'select timestamp, event_message from edge_logs limit 1', "select timestamp, event_message from logs where event_message like '%resolve_venue%' order by timestamp desc limit 60"]) {
  const [st, j] = await run(q); console.log('--', q.slice(0, 60), st, JSON.stringify(j).slice(0, 1500));
}
