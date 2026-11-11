-- Everyone checked in shows on the live map and the out-of-office list, including fingerprint staff who have not
-- signed in to the app yet (roster only, no account): state 'no_app', never tracked.
create or replace function public.presence_rows(p_day date)
returns table (user_id uuid, full_name text, hub text, inside_min int, outside_min int, od_min int, no_signal_min int,
               trips int, longest_trip int, last_at timestamptz, last_inside boolean, tracked boolean, samples int)
language plpgsql stable security definer set search_path = public as $$
declare a record; j jsonb;
begin
  for a in select m.user_id, coalesce(p.full_name, r.full_name) as full_name, coalesce(h.name, r.hub_name) as hub
           from attendance_merged(p_day, p_day) m
           left join profiles p on p.id = m.user_id left join hubs h on h.id = p.hub_id
           left join staff_roster r on r.email = m.email
           where m.in_time is not null and m.status <> 'leave'
             and coalesce(p.role, r.role) in ('staff', 'intern') and coalesce(p.active, true)
  loop
    j := case when a.user_id is null then '{}'::jsonb else presence_day_calc(a.user_id, p_day) end;
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

create or replace function public.live_locations()
returns table (user_id uuid, full_name text, hub text, lat double precision, lng double precision, accuracy_m double precision,
               at timestamptz, inside boolean, target_type text, state text, checked_in boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
        v_gap int := greatest(coalesce((setting('presence_gap_minutes') #>> '{}')::int, 15), 10) + 5;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return query
  with m as (select x.email, x.user_id, x.in_time, x.out_time from attendance_merged(v_today, v_today) x where x.in_time is not null and x.status <> 'leave'),
  s as (select distinct on (ps.user_id) ps.user_id, ps.lat, ps.lng, ps.accuracy_m, ps.at, ps.inside, ps.target_type
        from presence_samples ps where ps.at >= (v_today::timestamp at time zone 'Asia/Kolkata') and ps.source <> 'off'
        order by ps.user_id, ps.at desc)
  select m.user_id, coalesce(p.full_name, r.full_name), coalesce(h.name, r.hub_name), s.lat, s.lng, s.accuracy_m, s.at, s.inside, s.target_type,
         case when m.user_id is null then 'no_app' when s.at is null then 'not_started' when m.out_time is not null then 'checked_out'
              when now() - s.at > make_interval(mins => v_gap) then 'no_signal'
              when s.target_type = 'od' then 'od' when s.inside then 'inside' else 'outside' end,
         true
  from m left join profiles p on p.id = m.user_id left join hubs h on h.id = p.hub_id
  left join staff_roster r on r.email = m.email
  left join s on s.user_id = m.user_id
  where coalesce(p.role, r.role) in ('staff', 'intern') and coalesce(p.active, true)
  order by 10, 2;
end $$;
revoke execute on function live_locations() from public, anon;
grant execute on function live_locations() to authenticated;
