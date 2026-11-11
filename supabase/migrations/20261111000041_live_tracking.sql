-- HR and Chairman both hear about tracking events
create or replace function public.notify_admins(p_kind text, p_title text, p_body text, p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform notify_role('hr', p_kind, p_title, p_body, p_data);
  perform notify_role('chairman', p_kind, p_title, p_body, p_data);
end $$;
revoke execute on function notify_admins(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function notify_admins(text, text, text, jsonb) to service_role;

-- service key: the tracking window for one person today (fingerprint or selfie check-in)
create or replace function public.presence_window(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('in_time', m.in_time, 'out_time', m.out_time, 'status', m.status)
  from attendance_merged((now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date, (select email from profiles where id = p_user)) m
$$;
revoke execute on function presence_window(uuid) from public, anon, authenticated;
grant execute on function presence_window(uuid) to service_role;

create or replace function public.presence_day_calc(p_user uuid, p_day date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_in timestamptz; v_out timestamptz; v_status text; v_start timestamptz; v_end timestamptz; v_gap interval;
  r record; prev record; seg_from timestamptz; seg_to timestamptz; d interval; st text;
  m_in numeric := 0; m_out numeric := 0; m_od numeric := 0; m_none numeric := 0; n int := 0;
  has_prev boolean := false; trips jsonb := '[]'; t_from timestamptz; t_to timestamptz; t_max numeric := 0; last_inside boolean; last_at timestamptz;
begin
  -- the day as it counts (selfie and fingerprint merged by the hub's method): fingerprint staff are tracked too
  select m.in_time, m.out_time, m.status into v_in, v_out, v_status
  from attendance_merged(p_day, p_day, (select email from profiles where id = p_user)) m;
  if v_in is null then return jsonb_build_object('tracked', false, 'reason', coalesce(v_status, 'not_in')); end if;
  v_gap := make_interval(mins => coalesce((select (value #>> '{}')::int from settings where key = 'presence_gap_minutes'), 15));
  v_start := greatest(v_in, (p_day::text || ' ' || (select value #>> '{}' from settings where key = 'office_start'))::timestamp at time zone 'Asia/Kolkata');
  v_end := least(coalesce(v_out, now()), now(), (p_day::text || ' ' || (select value #>> '{}' from settings where key = 'office_end'))::timestamp at time zone 'Asia/Kolkata');
  if v_end <= v_start then return jsonb_build_object('tracked', true, 'inside_min', 0, 'outside_min', 0, 'od_min', 0, 'no_signal_min', 0, 'trips', '[]'::jsonb, 'samples', 0); end if;

  for r in
    select s.at, s.inside, s.target_type, s.distance_m, s.moving, s.source from presence_samples s
    where s.user_id = p_user and s.at between v_start - v_gap and v_end order by s.at
  loop
    n := n + 1;
    if not has_prev then
      if r.at > v_start then m_none := m_none + extract(epoch from (r.at - v_start)) / 60; end if;
    else
      seg_from := greatest(prev.at, v_start); seg_to := least(r.at, v_end);
      if seg_to > seg_from then
        d := seg_to - seg_from;
        -- location turned off = no signal; a long silence counts as the same place only if the phone said it was
        -- standing still (it wakes and reports again as soon as it moves), otherwise no signal
        st := case when prev.source = 'off' then 'none'
                   when r.at - prev.at > v_gap and coalesce(prev.moving, true) then 'none'
                   when prev.target_type = 'od' then 'od' when prev.inside then 'in' else 'out' end;
        if st = 'none' then m_none := m_none + extract(epoch from d) / 60;
        elsif st = 'od' then m_od := m_od + extract(epoch from d) / 60;
        elsif st = 'in' then m_in := m_in + extract(epoch from d) / 60;
        else
          m_out := m_out + extract(epoch from d) / 60;
          if t_from is null then t_from := seg_from; t_max := 0; end if;
          t_to := seg_to; t_max := greatest(t_max, coalesce(prev.distance_m, 0), coalesce(r.distance_m, 0));
        end if;
        if st <> 'out' and t_from is not null then
          trips := trips || jsonb_build_object('from', t_from, 'to', t_to, 'min', round(extract(epoch from (t_to - t_from)) / 60), 'max_m', round(t_max));
          t_from := null;
        end if;
      end if;
    end if;
    prev := r; has_prev := true; last_inside := r.inside; last_at := r.at;
  end loop;

  if not has_prev then
    m_none := extract(epoch from (v_end - v_start)) / 60;
  elsif v_end > greatest(prev.at, v_start) then
    -- after the last sample: the last state holds for up to one gap, then no signal
    seg_from := greatest(prev.at, v_start);
    seg_to := case when prev.source = 'off' then seg_from when prev.moving is false then v_end else least(v_end, prev.at + v_gap) end;
    d := seg_to - seg_from;
    if seg_to > seg_from then
      if prev.target_type = 'od' then m_od := m_od + extract(epoch from d) / 60;
      elsif prev.inside then m_in := m_in + extract(epoch from d) / 60;
      else m_out := m_out + extract(epoch from d) / 60; if t_from is null then t_from := seg_from; end if; t_to := seg_to; end if;
    end if;
    if v_end > seg_to then m_none := m_none + extract(epoch from (v_end - greatest(seg_to, seg_from))) / 60; end if;
  end if;
  if t_from is not null then
    trips := trips || jsonb_build_object('from', t_from, 'to', t_to, 'min', round(extract(epoch from (t_to - t_from)) / 60), 'max_m', round(t_max), 'ongoing', t_to >= v_end - interval '1 minute');
  end if;

  return jsonb_build_object('tracked', true, 'from', v_start, 'to', v_end, 'inside_min', round(m_in), 'outside_min', round(m_out),
    'od_min', round(m_od), 'no_signal_min', round(m_none), 'trips', trips, 'samples', n, 'last_at', last_at, 'last_inside', last_inside);
end $$;
revoke execute on function presence_day_calc(uuid, date) from public, anon, authenticated;

create or replace function public.presence_day(p_user uuid, p_day date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return presence_day_calc(p_user, p_day);
end $$;
revoke execute on function presence_day(uuid, date) from public, anon;
grant execute on function presence_day(uuid, date) to authenticated;

-- internal: everyone checked in on a day, with their tracked minutes
create or replace function public.presence_rows(p_day date)
returns table (user_id uuid, full_name text, hub text, inside_min int, outside_min int, od_min int, no_signal_min int,
               trips int, longest_trip int, last_at timestamptz, last_inside boolean, tracked boolean, samples int)
language plpgsql stable security definer set search_path = public as $$
declare a record; j jsonb;
begin
  for a in select m.user_id, p.full_name, h.name as hub
           from attendance_merged(p_day, p_day) m join profiles p on p.id = m.user_id left join hubs h on h.id = p.hub_id
           where m.in_time is not null and p.active and p.role in ('staff', 'intern') and m.status <> 'leave'
  loop
    j := presence_day_calc(a.user_id, p_day);
    user_id := a.user_id; full_name := a.full_name; hub := a.hub;
    tracked := coalesce((j ->> 'samples')::int, 0) > 0; samples := coalesce((j ->> 'samples')::int, 0);
    inside_min := coalesce((j ->> 'inside_min')::int, 0); outside_min := coalesce((j ->> 'outside_min')::int, 0);
    od_min := coalesce((j ->> 'od_min')::int, 0); no_signal_min := coalesce((j ->> 'no_signal_min')::int, 0);
    trips := jsonb_array_length(coalesce(j -> 'trips', '[]'));
    longest_trip := coalesce((select max((t ->> 'min')::int) from jsonb_array_elements(coalesce(j -> 'trips', '[]')) t), 0);
    last_at := (j ->> 'last_at')::timestamptz; last_inside := (j ->> 'last_inside')::boolean;
    return next;
  end loop;
end $$;
revoke execute on function presence_rows(date) from public, anon, authenticated;

-- HR / Chairman / Tech: who went out on a day and for how long (sorted by most time out)
create or replace function public.presence_board(p_day date default (now() at time zone 'Asia/Kolkata')::date)
returns table (user_id uuid, full_name text, hub text, inside_min int, outside_min int, od_min int, no_signal_min int,
               trips int, longest_trip int, last_at timestamptz, last_inside boolean, tracked boolean, samples int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  if p_day < (now() at time zone 'Asia/Kolkata')::date - 90 then raise exception 'too far back'; end if;
  return query select * from presence_rows(p_day) r order by r.outside_min desc, r.no_signal_min desc, r.full_name;
end $$;
revoke execute on function presence_board(date) from public, anon;
grant execute on function presence_board(date) to authenticated;

-- the old list keeps working for the HR staff list (now includes fingerprint staff)
create or replace function public.presence_today()
returns table (user_id uuid, outside_min int, no_signal_min int, trips int, last_at timestamptz, last_inside boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return query select r.user_id, r.outside_min, r.no_signal_min, r.trips, r.last_at, r.last_inside
               from presence_rows((now() at time zone 'Asia/Kolkata')::date) r where r.tracked;
end $$;
revoke execute on function presence_today() from public, anon;
grant execute on function presence_today() to authenticated;

-- HR / Chairman / Tech: where everyone is now (last location today), for the live map
create or replace function public.live_locations()
returns table (user_id uuid, full_name text, hub text, lat double precision, lng double precision, accuracy_m double precision,
               at timestamptz, inside boolean, target_type text, state text, checked_in boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
        v_gap int := greatest(coalesce((setting('presence_gap_minutes') #>> '{}')::int, 15), 10) + 5;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return query
  with m as (select x.user_id, x.in_time, x.out_time from attendance_merged(v_today, v_today) x where x.in_time is not null),
  s as (select distinct on (ps.user_id) ps.user_id, ps.lat, ps.lng, ps.accuracy_m, ps.at, ps.inside, ps.target_type
        from presence_samples ps where ps.at >= (v_today::timestamp at time zone 'Asia/Kolkata') and ps.source <> 'off'
        order by ps.user_id, ps.at desc)
  select p.id, p.full_name, h.name, s.lat, s.lng, s.accuracy_m, s.at, s.inside, s.target_type,
         case when s.at is null then 'not_started' when m.out_time is not null then 'checked_out'
              when now() - s.at > make_interval(mins => v_gap) then 'no_signal'
              when s.target_type = 'od' then 'od' when s.inside then 'inside' else 'outside' end,
         m.in_time is not null
  from profiles p left join hubs h on h.id = p.hub_id
  join m on m.user_id = p.id
  left join s on s.user_id = p.id
  where p.active and p.role in ('staff', 'intern')
  order by 10, p.full_name;
end $$;
revoke execute on function live_locations() from public, anon;
grant execute on function live_locations() to authenticated;

-- every 10 min in office hours: no location for 20+ min (or never started after check-in) -> dispute + alert
create or replace function public.presence_watch() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start timestamptz := (v_today::text || ' ' || coalesce(setting('office_start') #>> '{}', '10:00'))::timestamp at time zone 'Asia/Kolkata';
  v_end timestamptz := (v_today::text || ' ' || coalesce(setting('office_end') #>> '{}', '18:00'))::timestamp at time zone 'Asia/Kolkata';
  v_gap int := greatest(coalesce((setting('presence_gap_minutes') #>> '{}')::int, 15), 10) + 5;
  r record; v_last timestamptz; v_since timestamptz; v_min int; v_n int := 0;
begin
  if coalesce((setting('presence_enabled') #>> '{}')::boolean, true) = false then return 0; end if;
  if now() < v_start + make_interval(mins => v_gap) or now() > v_end then return 0; end if;
  for r in select m.user_id, m.in_time, p.full_name
           from attendance_merged(v_today, v_today) m join profiles p on p.id = m.user_id
           where p.active and p.role in ('staff', 'intern') and m.in_time is not null and m.out_time is null and m.status <> 'leave'
  loop
    select max(s.at) into v_last from presence_samples s where s.user_id = r.user_id and s.at >= v_start - interval '15 minutes' and s.source <> 'off';
    v_since := coalesce(v_last, greatest(r.in_time, v_start));
    if now() - v_since < make_interval(mins => v_gap) then continue; end if;
    if exists (select 1 from flags f where f.user_id = r.user_id and f.kind = 'no_signal' and f.created_at >= v_since) then continue; end if;   -- one alert per silence
    v_min := round(extract(epoch from (now() - v_since)) / 60);
    insert into flags (user_id, kind, rule, details)
    values (r.user_id, 'no_signal', case when v_last is null then 'R-13 location never started after check-in' else 'R-13 no location for ' || v_min || '+ min in work hours' end,
            jsonb_build_object('since', v_since, 'minutes', v_min, 'started', v_last is not null));
    perform notify_admins('no_signal', case when v_last is null then 'Location not on' else 'No location' end,
      r.full_name || ' · since ' || to_char(v_since at time zone 'Asia/Kolkata', 'HH12:MI AM'), jsonb_build_object('user_id', r.user_id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke execute on function presence_watch() from public, anon, authenticated;

-- 6:30 PM: one summary to HR and Chairman
create or replace function public.presence_summary(p_day date default (now() at time zone 'Asia/Kolkata')::date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out int; v_none int; v_top text; v_body text;
begin
  select count(*) filter (where outside_min > 0), count(*) filter (where no_signal_min >= 20 or not tracked),
         string_agg(full_name || ' ' || outside_min || ' min', ', ' order by outside_min desc) filter (where outside_min > 0)
    into v_out, v_none, v_top from (select * from presence_rows(p_day) order by outside_min desc) x;
  if v_out is null then return jsonb_build_object('sent', false); end if;
  v_body := case when v_out = 0 then 'Nobody went out' else 'Most out: ' || array_to_string((string_to_array(v_top, ', '))[1:3], ', ') end
            || case when v_none > 0 then ' · ' || v_none || ' with no location' else '' end;
  perform notify_admins('presence_summary', 'Today: ' || v_out || ' went out', v_body, jsonb_build_object('screen', 'outside', 'day', p_day));
  return jsonb_build_object('sent', true, 'out', v_out, 'no_location', v_none);
end $$;
revoke execute on function presence_summary(date) from public, anon, authenticated;

-- schedules (pg_cron on Supabase; skipped where it is not installed)
do $$ begin
  begin create extension if not exists pg_cron with schema pg_catalog; exception when others then raise notice 'pg_cron not available: %', sqlerrm; end;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('presence-watch', 'presence-summary');
    perform cron.schedule('presence-watch', '*/10 4-13 * * *', 'select public.presence_watch()');        -- 9:30 AM–7:20 PM IST, checks office hours itself
    perform cron.schedule('presence-summary', '0 13 * * 1-6', 'select public.presence_summary()');       -- 6:30 PM IST, Mon–Sat
  end if;
end $$;
