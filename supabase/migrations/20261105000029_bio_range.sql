-- HR fingerprint report: per person per day, first and last eSSL punch, with the app check-in beside it.
-- Read only, RLS applies (HR, Chairman, Tech see rows; staff get none). At most 62 days per call.
create or replace function public.bio_range(p_from date, p_to date)
returns table (day date, device_code text, essl_code text, essl_name text, email text, full_name text, hub text, user_id uuid,
               first_at timestamptz, last_at timestamptz, punches integer, app_in timestamptz, app_out timestamptz, app_status text)
language sql stable security invoker set search_path = public as $$
  with b as (
    select (x.punched_at at time zone 'Asia/Kolkata')::date as day, x.link_id, x.device_code,
           min(x.punched_at) as f, max(x.punched_at) as l, count(*)::int as n
    from bio_punches x
    where x.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and x.punched_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
      and p_to >= p_from and p_to - p_from <= 62
    group by 1, 2, 3)
  select b.day, b.device_code, pe.essl_code, pe.essl_name, pe.email, r.full_name, r.hub_name, pr.id,
         b.f, b.l, b.n, ad.in_time, ad.out_time, ad.status
  from b
  left join bio_people pe on pe.link_id = b.link_id and pe.device_code = b.device_code
  left join staff_roster r on r.email = pe.email
  left join profiles pr on pr.email = pe.email
  left join attendance_days ad on ad.user_id = pr.id and ad.day = b.day
  order by b.day desc, b.f
$$;
revoke execute on function bio_range(date, date) from public, anon;
grant execute on function bio_range(date, date) to authenticated;
