-- Work-hours presence (store app, v2). While a staff member is checked in (between check-in and check-out,
-- inside office hours), the app sends location samples in the background. The SERVER decides inside/outside
-- against the hub, or the OD venue during an approved OD (CLAUDE.md rule 1). Staff never read these rows
-- (rule 2); HR, Chairman and Tech do. Long time outside raises an 'away' dispute and tells HR.

insert into settings (key, value) values
  ('presence_enabled', 'true'),
  ('presence_alert_minutes', '30'),
  ('presence_gap_minutes', '15')
on conflict (key) do nothing;

create table presence_samples (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  at timestamptz not null,                     -- when the phone took the fix
  received_at timestamptz not null default now(),
  source text not null check (source in ('watch', 'beat')),   -- beat = still here, no movement
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  accuracy_m double precision,
  target_type text not null check (target_type in ('hub', 'od')),
  target_id uuid,
  distance_m double precision,
  inside boolean not null,
  edge boolean not null default false          -- beyond the radius, inside only by the GPS allowance
);
create index on presence_samples (user_id, at);
alter table presence_samples enable row level security;
create policy presence_read on presence_samples for select using (sees_all());
-- no insert/update/delete policies: only the check-in edge function (service role) writes

-- Tech setting ranges for the new keys (other keys unchanged)
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
  else
    raise exception 'unknown_setting';
  end if;
  update settings set value = p_value, updated_at = now() where key = p_key;
  if (setting('late_until') #>> '{}') < (setting('office_start') #>> '{}') then raise exception 'late_before_start'; end if;
end $$;
revoke execute on function set_setting(text, jsonb) from public, anon;
grant execute on function set_setting(text, jsonb) to authenticated;

-- One person's work day: minutes inside / outside / on OD / no signal, and each trip outside.
-- Window = check-in → check-out (or now), clipped to office hours. A silence longer than the gap setting is
-- "no signal" (phone off, app closed or location off), never counted as inside.
create or replace function public.presence_day(p_user uuid, p_day date default (now() at time zone 'Asia/Kolkata')::date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_day attendance_days; v_start timestamptz; v_end timestamptz; v_gap interval;
  r record; prev record; seg_from timestamptz; seg_to timestamptz; d interval; st text;
  m_in numeric := 0; m_out numeric := 0; m_od numeric := 0; m_none numeric := 0; n int := 0;
  has_prev boolean := false; trips jsonb := '[]'; t_from timestamptz; t_to timestamptz; t_max numeric := 0; last_inside boolean; last_at timestamptz;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  select * into v_day from attendance_days where user_id = p_user and day = p_day;
  if v_day.in_time is null then return jsonb_build_object('tracked', false, 'reason', coalesce(v_day.status, 'not_in')); end if;
  v_gap := make_interval(mins => coalesce((select (value #>> '{}')::int from settings where key = 'presence_gap_minutes'), 15));
  v_start := greatest(v_day.in_time, (p_day::text || ' ' || (select value #>> '{}' from settings where key = 'office_start'))::timestamp at time zone 'Asia/Kolkata');
  v_end := least(coalesce(v_day.out_time, now()), now(), (p_day::text || ' ' || (select value #>> '{}' from settings where key = 'office_end'))::timestamp at time zone 'Asia/Kolkata');
  if v_end <= v_start then return jsonb_build_object('tracked', true, 'inside_min', 0, 'outside_min', 0, 'od_min', 0, 'no_signal_min', 0, 'trips', '[]'::jsonb, 'samples', 0); end if;

  for r in
    select s.at, s.inside, s.target_type, s.distance_m from presence_samples s
    where s.user_id = p_user and s.at between v_start - v_gap and v_end order by s.at
  loop
    n := n + 1;
    if not has_prev then
      if r.at > v_start then m_none := m_none + extract(epoch from (r.at - v_start)) / 60; end if;
    else
      seg_from := greatest(prev.at, v_start); seg_to := least(r.at, v_end);
      if seg_to > seg_from then
        d := seg_to - seg_from;
        st := case when r.at - prev.at > v_gap then 'none' when prev.target_type = 'od' then 'od' when prev.inside then 'in' else 'out' end;
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
    seg_from := greatest(prev.at, v_start); seg_to := least(v_end, prev.at + v_gap); d := seg_to - seg_from;
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
revoke execute on function presence_day(uuid, date) from public, anon;
grant execute on function presence_day(uuid, date) to authenticated;

-- Today, everyone checked in: for HR / Chairman lists
create or replace function public.presence_today()
returns table (user_id uuid, outside_min int, no_signal_min int, trips int, last_at timestamptz, last_inside boolean)
language plpgsql stable security definer set search_path = public as $$
declare a record; j jsonb;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  for a in select d.user_id from attendance_days d join profiles p on p.id = d.user_id
           where d.day = (now() at time zone 'Asia/Kolkata')::date and d.in_time is not null and p.active
             and exists (select 1 from presence_samples s where s.user_id = d.user_id and s.at > now() - interval '20 hours')
  loop
    j := presence_day(a.user_id);
    user_id := a.user_id; outside_min := (j->>'outside_min')::int; no_signal_min := (j->>'no_signal_min')::int;
    trips := jsonb_array_length(coalesce(j->'trips', '[]')); last_at := (j->>'last_at')::timestamptz; last_inside := (j->>'last_inside')::boolean;
    return next;
  end loop;
end $$;
revoke execute on function presence_today() from public, anon;
grant execute on function presence_today() to authenticated;

-- "Add a reason" text that fits the dispute (time away has no check-in punch)
create or replace function public.ask_flag_reason(p_flag uuid) returns void
language plpgsql security definer set search_path = public as $$
declare f flags; v_when text;
begin
  if my_role() <> 'hr' then raise exception 'only HR'; end if;
  select * into f from flags where id = p_flag for update;
  update flags set status = 'reason_asked' where id = p_flag;
  if f.kind = 'away' then
    v_when := to_char(coalesce((f.details->>'since')::timestamptz, f.created_at) at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM');
    insert into notifications (user_id, kind, title, body, data)
    values (f.user_id, 'reason_asked', 'Add a reason', 'For time away from the office on ' || v_when, jsonb_build_object('flag_id', p_flag));
  else
    select to_char(server_time at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM') into v_when from punches where id = f.punch_id;
    insert into notifications (user_id, kind, title, body, data)
    values (f.user_id, 'reason_asked', 'Add a reason', 'For your check-in on ' || coalesce(v_when, 'a recent day'), jsonb_build_object('flag_id', p_flag));
  end if;
end $$;
