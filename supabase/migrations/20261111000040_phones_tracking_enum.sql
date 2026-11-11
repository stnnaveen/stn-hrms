-- 1. Phones never block a check-in. A new or reset phone is simply added; more than 2 changes of phone in a month
--    raise a dispute for HR (the face match still checks the person). Staff are not told.
-- 2. Live tracking, 10:00–18:00 (store app), for every checked-in staff member, selfie or fingerprint:
--    alerts to HR and Chairman (away 30+ min, no location 20+ min, location never started, fake GPS),
--    live map of where everyone is now, and a daily summary of who went out and for how long.

-- ======================= 1. phones =======================
-- service key only: how many times this person changed phone this month (punch to punch)
create or replace function public.phone_swaps(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  with b as (select (date_trunc('month', now() at time zone 'Asia/Kolkata'))::timestamp at time zone 'Asia/Kolkata' as m),
  p as (
    select pu.device_id, pu.server_time, lag(pu.device_id) over (order by pu.server_time) as prev
    from punches pu, b
    where pu.user_id = p_user and pu.device_id is not null and pu.server_time >= b.m - interval '40 days')
  select count(*)::int from p, b where p.prev is not null and p.device_id <> p.prev and p.server_time >= b.m
$$;
revoke execute on function phone_swaps(uuid) from public, anon, authenticated;
grant execute on function phone_swaps(uuid) to service_role;

-- ======================= 2. live tracking =======================
alter type flag_kind add value if not exists 'no_signal';
