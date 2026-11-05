// Diagnostic: check-in function errors and boot problems in the last hour (messages only).
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const end = new Date(), start = new Date(Date.now() - 3600e3);
const run = async (sql) => {
  const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } });
  return [r.status, await r.json()];
};
for (const q of [
  "select timestamp, event_message from function_logs order by timestamp desc limit 40",
  "select timestamp, event_message, response.status_code from function_edge_logs cross join unnest(metadata) as m cross join unnest(m.response) as response order by timestamp desc limit 30",
  "select timestamp, event_message from function_edge_logs order by timestamp desc limit 30"]) {
  const [st, j] = await run(q);
  console.log('FN --', q.slice(0, 50), st, j.error ? JSON.stringify(j.error).slice(0, 200) : '');
  for (const x of (j.result ?? [])) console.log('FN', new Date(Number(x.timestamp) / 1000).toISOString().slice(11, 19), x.status_code ?? '', String(x.event_message).replace(/\s+/g, ' ').slice(0, 260));
}
