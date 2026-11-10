-- Check-in method per hub (set by the Tech admin): fingerprint, selfie or both.
--   both:     the earliest check-in and the latest check-out from either one count.
--   bio:      fingerprint only; the selfie check-in is for OD venues only (the server refuses office selfies).
--   selfie:   selfie only; fingerprint punches are left out.
-- A selfie with an open dispute does not count when the fingerprint has a time for that day; the fingerprint
-- time is used instead. Once HR clears the dispute (genuine / false flag) the selfie counts again.
-- One server function (attendance_merged) now makes this decision for every screen: HR, Chairman, staff.
-- Also: the AI team's help contact (Tech admin sets it; staff see it on the Help button).

-- ---------- 1. hub method ----------
alter table hubs add column if not exists checkin_method text not null default 'both'
  check (checkin_method in ('bio', 'selfie', 'both'));

create or replace function public.set_hub_checkin(p_hub uuid, p_method text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if p_method not in ('bio', 'selfie', 'both') then raise exception 'bad_method'; end if;
  update hubs set checkin_method = p_method where id = p_hub;   -- logged by the hubs audit trigger
  if not found then raise exception 'no_hub'; end if;
end $$;
revoke execute on function set_hub_checkin(uuid, text) from public, anon;
grant execute on function set_hub_checkin(uuid, text) to authenticated;

-- method for one person: the hub on their profile, else the hub on the staff list; 'both' when no hub
create or replace function public.checkin_method_of(p_email text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select h.checkin_method from profiles pr join hubs h on h.id = pr.hub_id where pr.email = lower(p_email)),
    (select h.checkin_method from staff_roster r join hubs h on h.name = r.hub_name where r.email = lower(p_email)),
    'both')
$$;
revoke execute on function checkin_method_of(text) from public, anon, authenticated;

-- ---------- 2. the one merge every screen uses ----------
create or replace function public.attendance_merged(p_from date, p_to date, p_email text default null)
returns table (email text, user_id uuid, day date, method text, band time_band, status text, early_out boolean,
               in_time timestamptz, out_time timestamptz, source text, in_src text, out_src text, in_punch uuid,
               app_in timestamptz, app_out timestamptz, bio_in timestamptz, bio_out timestamptz)
language sql stable security definer set search_path = public as $$
  with ppl as (
    select coalesce(pr.email, r.email) as email, pr.id as user_id,
           coalesce(h1.checkin_method, h2.checkin_method, 'both') as method
    from profiles pr
    full join staff_roster r on r.email = pr.email
    left join hubs h1 on h1.id = pr.hub_id
    left join hubs h2 on h2.name = r.hub_name
    where p_email is null or coalesce(pr.email, r.email) = lower(p_email)),
  a as (
    select pp.email, pp.user_id, d.day, d.band, d.status, d.early_out, d.in_time, d.out_time, d.in_punch,
           exists (select 1 from flags f where f.punch_id = d.in_punch and f.status in ('open', 'reason_asked', 'violation')
                     and f.kind::text not in ('late', 'early_out', 'away', 'radius_edge')) as in_disp,
           exists (select 1 from flags f where f.punch_id = d.out_punch and f.status in ('open', 'reason_asked', 'violation')
                     and f.kind::text not in ('late', 'early_out', 'away', 'radius_edge')) as out_disp
    from attendance_days d join ppl pp on pp.user_id = d.user_id
    where d.day between p_from and p_to),
  b as (
    select x.email, x.day, x.in_at, x.out_at, x.band from bio_attendance(p_from, p_to) x
    where p_email is null or x.email = lower(p_email)),
  j as (
    select coalesce(a.email, b.email) as email,
           coalesce(a.user_id, (select pp.user_id from ppl pp where pp.email = b.email limit 1)) as user_id,
           coalesce(a.day, b.day) as day,
           coalesce((select pp.method from ppl pp where pp.email = coalesce(a.email, b.email) limit 1), 'both') as method,
           a.band as a_band, a.status as a_status, a.early_out as a_early, a.in_time as a_in, a.out_time as a_out, a.in_punch,
           coalesce(a.in_disp, false) as in_disp, coalesce(a.out_disp, false) as out_disp,
           b.in_at as b_in, b.out_at as b_out, b.band as b_band
    from a full join b on b.email = a.email and b.day = a.day),
  u as (
    select j.*,
           -- app time counts: not on a fingerprint-only hub (except an OD day), and not a disputed selfie when the fingerprint has a time
           (a_in is not null and (method <> 'bio' or a_status = 'od') and not (in_disp and b_in is not null)) as use_ai,
           (a_out is not null and (method <> 'bio' or a_status = 'od') and not (out_disp and b_out is not null)) as use_ao,
           (b_in is not null and method <> 'selfie') as use_bi,
           (b_out is not null and method <> 'selfie') as use_bo
    from j),
  v as (
    select u.*,
           least(case when use_ai then a_in end, case when use_bi then b_in end) as m_in,
           greatest(case when use_ao then a_out end, case when use_bo then b_out end) as m_out
    from u)
  select v.email, v.user_id, v.day, v.method,
         case when v.m_in is null then (case when v.a_status in ('od', 'leave') then v.a_band end)
              when v.use_ai and v.a_in = v.m_in then v.a_band else v.b_band end,
         coalesce(v.a_status, 'present'),
         case when v.m_out is null then false
              when v.use_ao and v.a_out = v.m_out then coalesce(v.a_early, false)
              else coalesce(v.a_status, 'present') <> 'od'
                   and to_char(v.m_out at time zone 'Asia/Kolkata', 'HH24:MI') < coalesce(setting('office_end') #>> '{}', '18:00') end,
         v.m_in, v.m_out,
         case when (v.use_ai or v.use_ao) and (v.use_bi or v.use_bo) then 'both' when v.use_bi or v.use_bo then 'bio' else 'app' end,
         case when v.m_in is null then null when v.use_ai and v.a_in = v.m_in then 'app' else 'bio' end,
         case when v.m_out is null then null when v.use_ao and v.a_out = v.m_out then 'app' else 'bio' end,
         case when v.use_ai and v.a_in = v.m_in then v.in_punch end,
         v.a_in, v.a_out, case when v.use_bi then v.b_in end, case when v.use_bo then v.b_out end
  from v
  where v.a_status is not null or v.use_bi or v.use_bo
$$;
revoke execute on function attendance_merged(date, date, text) from public, anon, authenticated;

-- same columns as before; every caller (HR person page, staff calendar, staff month) now gets the hub rule
create or replace function public.person_days_merged(p_email text, p_from date, p_to date)
returns table (day date, band time_band, status text, early_out boolean, in_time timestamptz, out_time timestamptz, source text)
language sql stable security definer set search_path = public as $$
  select m.day, m.band, m.status, m.early_out, m.in_time, m.out_time, m.source
  from attendance_merged(p_from, p_to, p_email) m order by m.day
$$;
revoke execute on function person_days_merged(text, date, date) from public, anon, authenticated;

-- HR / Chairman / Tech: everyone's merged days for a date range (lists, filters, trend)
create or replace function public.hr_board(p_from date, p_to date)
returns table (email text, user_id uuid, day date, method text, band time_band, status text, early_out boolean,
               in_time timestamptz, out_time timestamptz, source text, in_src text, out_src text, in_punch uuid,
               bio_in timestamptz, bio_out timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  if p_to < p_from or p_to - p_from > 62 then raise exception 'bad_range'; end if;
  return query select m.email, m.user_id, m.day, m.method, m.band, m.status, m.early_out, m.in_time, m.out_time,
                      m.source, m.in_src, m.out_src, m.in_punch, m.bio_in, m.bio_out
               from attendance_merged(p_from, p_to) m order by m.day, m.email;
end $$;
revoke execute on function hr_board(date, date) from public, anon;
grant execute on function hr_board(date, date) to authenticated;

-- check-in function (service key): the method and today's fingerprint for one person
create or replace function public.checkin_context(p_email text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('method', checkin_method_of(p_email),
    'bio_in', (select x.in_at from bio_attendance((now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date) x where x.email = lower(p_email)))
$$;
revoke execute on function checkin_context(text) from public, anon, authenticated;
grant execute on function checkin_context(text) to service_role;

-- ---------- 3. HR home counts on the same merge ----------
create or replace function public.hr_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return (
    with staff as (
      select r.email from staff_roster r left join profiles pr on pr.email = r.email
      where r.role in ('staff', 'intern') and not coalesce(r.is_test, false) and coalesce(pr.active, true)),
    m as (
      select s.email, x.band, x.in_time as in_any, x.out_time as out_any
      from staff s join attendance_merged(v_today, v_today) x on x.email = s.email),
    lv as (
      select pr.email from leave_requests l join profiles pr on pr.id = l.user_id
      where l.status = 'approved' and l.starts_on <= v_today and l.ends_on >= v_today and not is_test_user(l.user_id)
      union select email from day_marks where day = v_today and mark = 'leave')
    select jsonb_build_object(
      'staff', (select count(*) from staff),
      'checked_in', (select count(*) from m where in_any is not null),
      'late', (select count(*) from m where in_any is not null and band in ('warn', 'bad')),
      'checked_out', (select count(*) from m where out_any is not null),
      'od', (select count(distinct user_id) from od_requests where status = 'approved' and starts_at::date <= v_today and ends_at::date >= v_today and not is_test_user(user_id)),
      'leave', (select count(*) from lv where email in (select email from staff)),
      'absent', (select count(*) from day_marks where day = v_today and mark = 'absent' and email in (select email from staff)),
      'holiday', (select jsonb_build_object('name', h.name, 'kind', h.kind) from holidays h where h.day = v_today),
      'pending_leave', (select count(*) from leave_requests where status = 'pending'),
      'pending_od', (select count(*) from od_requests where status = 'pending'),
      'open_flags', (select count(*) from flags where status in ('open', 'reason_asked') and (kind <> 'late' or staff_reason is not null)),
      'chairman_away', coalesce((setting('chairman_away'))::boolean, false),
      'leave_approver', setting('leave_approver') #>> '{}',
      'od_approver', setting('od_approver') #>> '{}',
      'finger', (select count(*) from bio_attendance(v_today, v_today))
    ));
end $$;

-- ---------- 4. help contact ----------
insert into settings (key, value) values ('help_contact', '{"email": "ai@startuptn.in", "whatsapp": "", "phone": ""}')
on conflict (key) do nothing;

create or replace function public.set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare n numeric; t text;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if p_key in ('office_start', 'late_until', 'office_end') then
    t := p_value #>> '{}';
    if t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'bad_time'; end if;
  elsif p_key in ('face_threshold', 'same_point_days', 'offline_flag_minutes', 'clock_gap_minutes', 'jump_kmh', 'od_notice_hours', 'presence_alert_minutes', 'presence_gap_minutes') then
    n := (p_value #>> '{}')::numeric;
    if (p_key = 'face_threshold' and n not between 50 and 99) or (p_key = 'same_point_days' and n not between 2 and 30)
       or (p_key = 'offline_flag_minutes' and n not between 5 and 720) or (p_key = 'clock_gap_minutes' and n not between 1 and 60)
       or (p_key = 'jump_kmh' and n not between 60 and 1000) or (p_key = 'od_notice_hours' and n not between 0 and 168)
       or (p_key = 'presence_alert_minutes' and n not between 10 and 240) or (p_key = 'presence_gap_minutes' and n not between 5 and 60) then
      raise exception 'out_of_range';
    end if;
    p_value := to_jsonb(n);
  elsif p_key = 'presence_enabled' then
    if jsonb_typeof(p_value) <> 'boolean' then raise exception 'bad_value'; end if;
  elsif p_key = 'help_contact' then
    -- only these three fields; phone numbers digits with an optional +, email a plain address
    if jsonb_typeof(p_value) <> 'object' or exists (select 1 from jsonb_object_keys(p_value) k where k not in ('email', 'whatsapp', 'phone')) then raise exception 'bad_value'; end if;
    if coalesce(p_value ->> 'whatsapp', '') !~ '^(\+?[0-9]{10,15})?$' or coalesce(p_value ->> 'phone', '') !~ '^(\+?[0-9]{10,15})?$'
       or coalesce(p_value ->> 'email', '') !~ '^([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\.[A-Za-z]{2,24})?$' then raise exception 'bad_value'; end if;
    if coalesce(p_value ->> 'email', '') = '' and coalesce(p_value ->> 'whatsapp', '') = '' and coalesce(p_value ->> 'phone', '') = '' then raise exception 'bad_value'; end if;
    p_value := jsonb_build_object('email', coalesce(p_value ->> 'email', ''), 'whatsapp', coalesce(p_value ->> 'whatsapp', ''), 'phone', coalesce(p_value ->> 'phone', ''));
    insert into settings (key, value) values ('help_contact', p_value) on conflict (key) do nothing;
  else
    raise exception 'unknown_setting';
  end if;
  update settings set value = p_value, updated_at = now() where key = p_key;
  if (setting('late_until') #>> '{}') < (setting('office_start') #>> '{}') then raise exception 'late_before_start'; end if;
end $$;
revoke execute on function set_setting(text, jsonb) from public, anon;
grant execute on function set_setting(text, jsonb) to authenticated;

-- ---------- 5. staff home: method, merged day and help contact ----------
create or replace function public.my_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from timestamptz := (v_today::timestamp at time zone 'Asia/Kolkata');
  v_to timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Kolkata');
  v_email text;
  v_out jsonb;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select email into v_email from profiles where id = v_uid;
  select jsonb_build_object(
    'profile', (select jsonb_build_object('full_name', p.full_name, 'employee_code', p.employee_code, 'role', p.role,
                 'hub', h.name, 'face_status', p.face_status, 'consented', p.consent_at is not null)
                from profiles p left join hubs h on h.id = p.hub_id where p.id = v_uid),
    'today', (select jsonb_build_object('in_time', d.in_time, 'out_time', d.out_time, 'band', d.band, 'early_out', d.early_out, 'status', d.status)
              from attendance_days d where d.user_id = v_uid and d.day = v_today),
    -- the day as it counts (selfie and fingerprint merged by the hub's method); shown on the home card
    'day', (select jsonb_build_object('in_time', m.in_time, 'out_time', m.out_time, 'band', m.band, 'early_out', m.early_out, 'in_src', m.in_src, 'out_src', m.out_src)
            from attendance_merged(v_today, v_today, v_email) m),
    'checkin', checkin_method_of(v_email),
    'help', setting('help_contact'),
    'month', (select jsonb_build_object(
                'on_time', count(*) filter (where m.band = 'ok' or m.status = 'od'),
                'late', count(*) filter (where m.band in ('warn', 'bad') and m.status <> 'od'),
                'early', count(*) filter (where m.early_out))
              from attendance_merged(date_trunc('month', v_today)::date, v_today, v_email) m
              where m.in_time is not null or m.status in ('od', 'leave')),
    'office', jsonb_build_object('start', setting('office_start'), 'end', setting('office_end')),
    'test_mode', is_test_mode(v_uid),
    'od_today', (select jsonb_build_object('id', o.id, 'subject', o.subject, 'venue_name', o.venue_name, 'venue_place', o.venue_place,
                   'venue_url', o.venue_url, 'starts_at', o.starts_at, 'ends_at', o.ends_at,
                   'visited_at', (select min(pu.server_time) from punches pu where pu.user_id = v_uid and pu.target_type = 'od' and pu.target_id = o.id))
                 from od_requests o where o.user_id = v_uid and o.status = 'approved' and o.starts_at < v_to and o.ends_at > v_from
                 order by o.starts_at limit 1),
    'ods_today', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'subject', o.subject, 'venue_name', o.venue_name,
                   'starts_at', o.starts_at, 'ends_at', o.ends_at, 'status', o.status) order by o.starts_at)
                 from od_requests o where o.user_id = v_uid and o.status in ('approved', 'pending') and o.starts_at < v_to and o.ends_at > v_from), '[]'::jsonb),
    'chairman_available', coalesce((select jsonb_agg(jsonb_build_object('starts_at', a.starts_at, 'ends_at', a.ends_at, 'place', a.place, 'note', a.note) order by a.starts_at)
                 from chairman_availability a where a.ends_at > now() and a.starts_at < v_to), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(r order by r.created_at desc) from (
        select 'od' as type, id, subject as title, starts_at::text as starts, status, created_at from od_requests
          where user_id = v_uid and created_at > now() - interval '30 days'
        union all
        select 'leave', id, initcap(leave_type) || ' leave', starts_on::text, status, created_at from leave_requests
          where user_id = v_uid and created_at > now() - interval '30 days'
        order by created_at desc limit 5) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke execute on function my_today() from public, anon;
grant execute on function my_today() to authenticated;

-- my_fingerprint 'today': nothing on a selfie-only hub
create or replace function public.my_fingerprint() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_email text; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  select email into v_email from profiles where id = auth.uid() and active;
  if v_email is null then raise exception 'not signed in'; end if;
  if checkin_method_of(v_email) = 'selfie' then return jsonb_build_object('today', null, 'month', null); end if;
  return jsonb_build_object(
    'today', (select jsonb_build_object('in_at', x.in_at, 'out_at', x.out_at, 'band', x.band)
              from bio_attendance(v_today, v_today) x where x.email = v_email),
    'month', (select jsonb_build_object(
                'on_time', count(*) filter (where m.band = 'ok' or m.status = 'od'),
                'late', count(*) filter (where m.band in ('warn', 'bad') and m.status <> 'od'),
                'early', count(*) filter (where m.early_out),
                'finger_days', count(*) filter (where m.source in ('bio', 'both')))
              from person_days_merged(v_email, date_trunc('month', v_today)::date, v_today) m
              where m.in_time is not null or m.status in ('od', 'leave')));
end $$;
revoke execute on function my_fingerprint() from public, anon;
grant execute on function my_fingerprint() to authenticated;
