-- No-location alerts only for staff who use the store app. Until a person installs it, the live map shows them as
-- 'Not started' and the 6:30 PM summary counts them, without an alert every day.
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
             -- only staff on the store app (it sent a location in the last 30 days); web-app staff show as 'Not started' on the map and in the evening summary
             and exists (select 1 from presence_samples s0 where s0.user_id = m.user_id and s0.at > now() - interval '30 days')
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

-- today's 'never started' alerts for web-app staff were noise: close them as false flags (kept, not deleted)
update flags f set status = 'false_flag', decided_at = now()
where f.kind = 'no_signal' and f.status = 'open' and f.rule like 'R-13 location never started%'
  and not exists (select 1 from presence_samples s where s.user_id = f.user_id);
