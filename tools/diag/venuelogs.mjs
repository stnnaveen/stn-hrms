// Diagnostic: recent map-link failures recorded by the check-in function (edge logs, last 6 hours).
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const end = new Date(), start = new Date(Date.now() - 6 * 3600e3);
const run = async (sql) => {
  const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } });
  return [r.status, await r.json()];
};
for (const t of ['function_logs', 'edge_function_logs', 'function_edge_logs', 'functions_logs', 'deno_logs']) {
  const [st, j] = await run(`select timestamp, event_message from ${t} where event_message like '%resolve_venue%' order by timestamp desc limit 20`);
  console.log(`-- ${t}: ${st} ${j.error ? JSON.stringify(j.error).slice(0, 200) : `${j.result?.length ?? 0} rows`}`);
  for (const x of j.result ?? []) console.log(new Date(Number(x.timestamp) / 1000).toISOString(), x.event_message);
}
