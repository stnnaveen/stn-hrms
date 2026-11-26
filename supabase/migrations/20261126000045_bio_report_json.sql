-- The API returns at most 1,000 rows per call; a month of the fingerprint report is ~1,600 rows (62 people x 26 days).
-- Return the whole report as one JSON array instead. Same rows, same rules, same access (sees_all via bio_report).
create or replace function public.bio_report_json(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.day desc, coalesce(r.full_name, r.essl_name, r.device_code)), '[]'::jsonb)
  from bio_report(p_from, p_to) r
$$;
revoke execute on function bio_report_json(date, date) from public, anon;
grant execute on function bio_report_json(date, date) to authenticated;
