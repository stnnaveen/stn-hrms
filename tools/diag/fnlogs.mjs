// Diagnostic: check-in function errors and boot problems in the last hour (messages only).
const { REF, SUPABASE_ACCESS_TOKEN } = process.env;
const end = new Date(), start = new Date(Date.now() - 3600e3);
const run = async (sql) => {
  const u = `https://api.supabase.com/v1/projects/${REF}/analytics/endpoints/logs?sql=${encodeURIComponent(sql)}&iso_timestamp_start=${start.toISOString()}&iso_timestamp_end=${end.toISOString()}`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}` } });
  return [r.status, await r.json()];
};
const [st, j] = await run("select timestamp, event_message from logs where event_message not like '%resolve_venue%' order by timestamp desc limit 60");
console.log('FN status', st);
for (const x of (j.result ?? [])) console.log('FN', new Date(Number(x.timestamp) / 1000).toISOString().slice(11, 19), String(x.event_message).replace(/\s+/g, ' ').slice(0, 300));
