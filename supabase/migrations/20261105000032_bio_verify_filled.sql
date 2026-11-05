-- eSSL fills in the shift end (e.g. 18:00) as the out when someone did not punch out. That is not a punch:
-- count it separately ("eSSL filled") instead of as a disagreement. A real eSSL out always has a punch at that minute.
drop function if exists public.bio_verify(date, date);
create or replace function public.bio_verify(p_from date, p_to date)
returns table (day date, essl_rows integer, stored_rows integer, orphans integer, compared integer,
               in_agree integer, out_agree integer, essl_filled integer, differ jsonb, essl_reported_at timestamptz)
language sql stable security invoker set search_path = public as $$
  with d as (select generate_series(p_from, least(p_to, p_from + 62), '1 day')::date as day),
  au as (select a.at, t.value as tb from bio_audit a cross join jsonb_array_elements(a.tables) t),
  src as (select (k.key)::date as day, sum((k.value #>> '{}')::int)::int as n, max(au.at) as at
          from au cross join jsonb_each(au.tb -> 'days') k group by 1),
  st as (select (b.punched_at at time zone 'Asia/Kolkata')::date as day, count(*)::int as n,
                count(*) filter (where pe.device_code is null)::int as orphan
         from bio_punches b left join bio_people pe on pe.link_id = b.link_id and pe.device_code = b.device_code
         where b.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and b.punched_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
         group by 1),
  pts as (select b.link_id, b.device_code, (b.punched_at at time zone 'Asia/Kolkata')::date as day, b.punched_at
          from bio_punches b left join bio_devices dv on dv.link_id = b.link_id and dv.essl_id = b.essl_device_id
          where coalesce(dv.kind, 'biometric') = 'biometric'
            and b.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and b.punched_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')),
  ours as (select f.link_id, f.device_code, f.day, f.in_at,
                  (select max(x.punched_at) from pts x where x.link_id = f.link_id and x.device_code = f.device_code and x.day = f.day
                     and x.punched_at > f.in_at + make_interval(mins => bio_gap_min())) as out_at
           from (select link_id, device_code, day, min(punched_at) as in_at from pts group by 1, 2, 3) f),
  cmp as (select o.day, o.device_code, pe.essl_name, to_char(o.in_at at time zone 'Asia/Kolkata', 'HH24:MI') as our_in,
                 to_char(o.out_at at time zone 'Asia/Kolkata', 'HH24:MI') as our_out, e.in_hm, e.out_hm,
                 (e.in_hm = to_char(o.in_at at time zone 'Asia/Kolkata', 'HH24:MI')) as in_ok,
                 (case when o.out_at is not null then e.out_hm = to_char(o.out_at at time zone 'Asia/Kolkata', 'HH24:MI')
                       else e.out_hm is null or e.out_hm = e.in_hm
                         or to_timestamp(e.out_hm, 'HH24:MI')::time - to_timestamp(e.in_hm, 'HH24:MI')::time <= make_interval(mins => bio_gap_min())
                         or not exists (select 1 from pts x where x.link_id = o.link_id and x.device_code = o.device_code and x.day = o.day
                                          and to_char(x.punched_at at time zone 'Asia/Kolkata', 'HH24:MI') = e.out_hm) end) as out_ok,
                 (o.out_at is null and e.out_hm is not null and e.out_hm <> e.in_hm
                   and not exists (select 1 from pts x where x.link_id = o.link_id and x.device_code = o.device_code and x.day = o.day
                                     and to_char(x.punched_at at time zone 'Asia/Kolkata', 'HH24:MI') = e.out_hm)) as filled
          from ours o
          join bio_essl_days e on e.link_id = o.link_id and e.device_code = o.device_code and e.day = o.day
          left join bio_people pe on pe.link_id = o.link_id and pe.device_code = o.device_code)
  select d.day, src.n, coalesce(st.n, 0), coalesce(st.orphan, 0),
         (select count(*)::int from cmp where cmp.day = d.day),
         (select count(*)::int from cmp where cmp.day = d.day and cmp.in_ok),
         (select count(*)::int from cmp where cmp.day = d.day and cmp.out_ok),
         (select count(*)::int from cmp where cmp.day = d.day and cmp.filled),
         coalesce((select jsonb_agg(jsonb_build_object('code', cmp.device_code, 'name', cmp.essl_name, 'our_in', cmp.our_in, 'essl_in', cmp.in_hm,
                     'our_out', cmp.our_out, 'essl_out', cmp.out_hm) order by cmp.device_code)
                   from cmp where cmp.day = d.day and not (coalesce(cmp.in_ok, false) and coalesce(cmp.out_ok, false))), '[]'::jsonb),
         src.at
  from d left join src on src.day = d.day left join st on st.day = d.day
  order by d.day desc
$$;
revoke execute on function bio_verify(date, date) from public, anon;
grant execute on function bio_verify(date, date) to authenticated;
