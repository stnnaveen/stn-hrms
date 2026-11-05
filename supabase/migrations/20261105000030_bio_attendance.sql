-- Fingerprint punches feed the HR side (home numbers, staff list, calendar) — HR only for now; staff app and
-- attendance records are unchanged. Per matched person per day:
--   in  = first punch;  out = last punch more than bio_gap_min (20) minutes after the in (double punches and
--   face + finger repeats within 20 minutes are ignored); band from the in time: <= 10:00 green, <= 10:05 yellow, later red.

insert into settings (key, value) values ('bio_gap_min', '20') on conflict (key) do nothing;
-- grace is now 5 minutes (HR, 5 Nov): on time to 10:00, slightly late to 10:05, late after. Applies to app check-ins too.
update settings set value = '"10:05"', updated_at = now() where key = 'late_until' and value <> '"10:05"';

-- the double-punch window in minutes (readable by the HR functions, which run as the caller)
create or replace function public.bio_gap_min() returns integer
language sql stable security definer set search_path = public as $$
  select coalesce((setting('bio_gap_min') #>> '{}')::int, 20)
$$;
revoke execute on function bio_gap_min() from public, anon;
grant execute on function bio_gap_min() to authenticated;

-- band for a time of day, same rule as check-in (rules.ts bandFor): whole minutes, IST
create or replace function public.band_at(p_at timestamptz) returns time_band
language sql stable security definer set search_path = public as $$
  select case
    when to_char(p_at at time zone 'Asia/Kolkata', 'HH24:MI') <= (setting('office_start') #>> '{}') then 'ok'::time_band
    when to_char(p_at at time zone 'Asia/Kolkata', 'HH24:MI') <= (setting('late_until') #>> '{}') then 'warn'::time_band
    else 'bad'::time_band end
$$;
revoke execute on function band_at(timestamptz) from public, anon;
grant execute on function band_at(timestamptz) to authenticated;

-- one row per matched person per day (fingerprint devices only; eSSL manual and mobile entries left out)
create or replace function public.bio_attendance(p_from date, p_to date)
returns table (email text, day date, in_at timestamptz, out_at timestamptz, punches integer, band time_band)
language sql stable security invoker set search_path = public as $$
  with p as (
    select pe.email, (b.punched_at at time zone 'Asia/Kolkata')::date as day, b.punched_at
    from bio_punches b
    join bio_people pe on pe.link_id = b.link_id and pe.device_code = b.device_code and pe.email is not null
    left join bio_devices d on d.link_id = b.link_id and d.essl_id = b.essl_device_id
    where coalesce(d.kind, 'biometric') = 'biometric'
      and b.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and b.punched_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
      and p_to >= p_from and p_to - p_from <= 62),
  f as (select email, day, min(punched_at) as in_at, count(*)::int as n from p group by 1, 2)
  select f.email, f.day, f.in_at,
         (select max(p.punched_at) from p where p.email = f.email and p.day = f.day
            and p.punched_at > f.in_at + make_interval(mins => bio_gap_min())),
         f.n, band_at(f.in_at)
  from f
$$;
revoke execute on function bio_attendance(date, date) from public, anon;
grant execute on function bio_attendance(date, date) to authenticated;

-- HR report: same 20-minute rule for the out, plus the band
drop function if exists public.bio_range(date, date);
create or replace function public.bio_range(p_from date, p_to date)
returns table (day date, device_code text, essl_code text, essl_name text, email text, full_name text, hub text, user_id uuid,
               first_at timestamptz, last_at timestamptz, punches integer, band time_band, app_in timestamptz, app_out timestamptz, app_status text)
language sql stable security invoker set search_path = public as $$
  with p as (
    select (x.punched_at at time zone 'Asia/Kolkata')::date as day, x.link_id, x.device_code, x.punched_at
    from bio_punches x
    left join bio_devices d on d.link_id = x.link_id and d.essl_id = x.essl_device_id
    where coalesce(d.kind, 'biometric') = 'biometric'
      and x.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and x.punched_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
      and p_to >= p_from and p_to - p_from <= 62),
  b as (select day, link_id, device_code, min(punched_at) as f, count(*)::int as n from p group by 1, 2, 3)
  select b.day, b.device_code, pe.essl_code, pe.essl_name, pe.email, r.full_name, r.hub_name, pr.id,
         b.f,
         (select max(p.punched_at) from p where p.link_id = b.link_id and p.device_code = b.device_code and p.day = b.day
            and p.punched_at > b.f + make_interval(mins => bio_gap_min())),
         b.n, band_at(b.f), ad.in_time, ad.out_time, ad.status
  from b
  left join bio_people pe on pe.link_id = b.link_id and pe.device_code = b.device_code
  left join staff_roster r on r.email = pe.email
  left join profiles pr on pr.email = pe.email
  left join attendance_days ad on ad.user_id = pr.id and ad.day = b.day
  order by b.day desc, b.f
$$;
revoke execute on function bio_range(date, date) from public, anon;
grant execute on function bio_range(date, date) to authenticated;

-- one person's month for the HR calendar, by email (works before they sign in): app days and fingerprint days merged.
-- in = earliest of the two, out = latest, band from the in; OD / leave from the app record win.
create or replace function public.hr_person_days(p_email text, p_from date, p_to date)
returns table (day date, band time_band, status text, early_out boolean, in_time timestamptz, out_time timestamptz, source text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return query
  with a as (
    select d.day, d.band, d.status, d.early_out, d.in_time, d.out_time
    from attendance_days d join profiles pr on pr.id = d.user_id
    where pr.email = lower(p_email) and d.day between p_from and p_to),
  b as (select * from bio_attendance(p_from, p_to) x where x.email = lower(p_email))
  select coalesce(a.day, b.day),
         case when a.status in ('od', 'leave') then a.band
              when a.in_time is not null and (b.in_at is null or a.in_time <= b.in_at) then a.band
              else b.band end,
         coalesce(a.status, 'present'),
         coalesce(a.early_out, false),
         least(a.in_time, b.in_at),
         greatest(a.out_time, b.out_at),
         case when a.day is not null and b.day is not null then 'both' when b.day is not null then 'bio' else 'app' end
  from a full join b on b.day = a.day
  order by 1;
end $$;
revoke execute on function hr_person_days(text, date, date) from public, anon;
grant execute on function hr_person_days(text, date, date) to authenticated;

-- HR home: staff = everyone on the staff list (signed in or not); checked in / late include fingerprint punches.
create or replace function public.hr_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return (
    with staff as (
      select r.email from staff_roster r left join profiles pr on pr.email = r.email
      where r.role in ('staff', 'intern') and not coalesce(r.is_test, false) and coalesce(pr.active, true)),
    a as (
      select pr.email, d.in_time, d.out_time, d.band from attendance_days d join profiles pr on pr.id = d.user_id
      where d.day = v_today and d.in_time is not null and not is_test_user(d.user_id)),
    b as (select x.email, x.in_at, x.out_at, x.band from bio_attendance(v_today, v_today) x),
    m as (
      select s.email,
             case when a.in_time is not null and (b.in_at is null or a.in_time <= b.in_at) then a.band else b.band end as band,
             coalesce(a.in_time, b.in_at) as in_any, coalesce(a.out_time, b.out_at) as out_any
      from staff s left join a on a.email = s.email left join b on b.email = s.email)
    select jsonb_build_object(
      'staff', (select count(*) from staff),
      'checked_in', (select count(*) from m where in_any is not null),
      'late', (select count(*) from m where in_any is not null and band in ('warn', 'bad')),
      'checked_out', (select count(*) from m where out_any is not null),
      'od', (select count(distinct user_id) from od_requests where status = 'approved' and starts_at::date <= v_today and ends_at::date >= v_today and not is_test_user(user_id)),
      'leave', (select count(distinct user_id) from leave_requests where status = 'approved' and starts_on <= v_today and ends_on >= v_today and not is_test_user(user_id)),
      'pending_leave', (select count(*) from leave_requests where status = 'pending'),
      'pending_od', (select count(*) from od_requests where status = 'pending'),
      'open_flags', (select count(*) from flags where status in ('open', 'reason_asked') and (kind <> 'late' or staff_reason is not null)),
      'chairman_away', coalesce((setting('chairman_away'))::boolean, false),
      'finger', (select count(*) from b)
    ));
end $$;

-- one person's fingerprint days by email (HR person card; works before they sign in)
create or replace function public.bio_person_days(p_email text, p_days integer default 7)
returns table (day date, in_at timestamptz, out_at timestamptz, punches integer, band time_band)
language sql stable security invoker set search_path = public as $$
  select x.day, x.in_at, x.out_at, x.punches, x.band
  from bio_attendance(((now() at time zone 'Asia/Kolkata')::date - least(greatest(p_days, 1), 62) + 1), (now() at time zone 'Asia/Kolkata')::date) x
  where x.email = lower(p_email)
  order by x.day desc
$$;
revoke execute on function bio_person_days(text, integer) from public, anon;
grant execute on function bio_person_days(text, integer) to authenticated;
