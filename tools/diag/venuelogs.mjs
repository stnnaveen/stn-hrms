// Diagnostic: recent map-link failures recorded by the check-in function (edge logs, last 6 hours).
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const end = new Date(), start = new Date(Date.now() - 6 * 3600e3);
const run = async (sql) => {
  const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } });
  return [r.status, await r.json()];
};
{ const [st, j] = await run(`select source_name, count() as n from logs group by source_name`); console.log('-- sources', st, JSON.stringify(j).slice(0, 400)); }
{ const [st, j] = await run(`select timestamp, source_name, event_message from logs where event_message like '%resolve_venue%' order by timestamp desc limit 20`);
  console.log(`-- venue: ${st} ${j.error ? JSON.stringify(j.error).slice(0, 200) : `${j.result?.length ?? 0} rows`}`);
  for (const x of j.result ?? []) console.log(String(x.timestamp), x.source_name, x.event_message); }
