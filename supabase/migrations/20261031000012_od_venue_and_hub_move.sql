-- 1. OD venue must be a map pin (Google or Apple Maps link), resolved on the server to coordinates and a place name.
alter table od_requests add column if not exists venue_url text, add column if not exists venue_place text;

create or replace function public.od_require_pin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.venue_lat is null or new.venue_lng is null or coalesce(trim(new.venue_url), '') = ''
     or new.venue_lat not between -90 and 90 or new.venue_lng not between -180 and 180 then
    raise exception 'venue_pin_needed';
  end if;
  if new.venue_url !~* '^https://([a-z0-9-]+\.)*(google\.[a-z.]+|goo\.gl|maps\.app\.goo\.gl|apple\.com|maps\.apple)(/|$)' then
    raise exception 'venue_link_not_maps';
  end if;
  return new;
end $$;
revoke execute on function od_require_pin() from public, anon, authenticated;
create trigger od_require_pin before insert on od_requests for each row execute function od_require_pin();

-- 2. my_today: add today's approved OD and whether the venue check-in is done (time only; never distance or match)
create or replace function public.my_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_out jsonb;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select jsonb_build_object(
    'profile', (select jsonb_build_object('full_name', p.full_name, 'employee_code', p.employee_code, 'role', p.role,
                 'hub', h.name, 'face_status', p.face_status, 'consented', p.consent_at is not null)
                from profiles p left join hubs h on h.id = p.hub_id where p.id = v_uid),
    'today', (select jsonb_build_object('in_time', d.in_time, 'out_time', d.out_time, 'band', d.band, 'early_out', d.early_out, 'status', d.status)
              from attendance_days d where d.user_id = v_uid and d.day = v_today),
    'month', (select jsonb_build_object(
                'on_time', count(*) filter (where band = 'ok' or status = 'od'),
                'late', count(*) filter (where band in ('warn', 'bad')),
                'early', count(*) filter (where early_out))
              from attendance_days where user_id = v_uid and day >= date_trunc('month', v_today)::date),
    'office', jsonb_build_object('start', setting('office_start'), 'end', setting('office_end')),
    'od_today', (select jsonb_build_object('id', o.id, 'subject', o.subject, 'venue_name', o.venue_name, 'venue_place', o.venue_place,
                   'venue_url', o.venue_url, 'starts_at', o.starts_at, 'ends_at', o.ends_at,
                   'visited_at', (select min(pu.server_time) from punches pu where pu.user_id = v_uid and pu.target_type = 'od' and pu.target_id = o.id))
                 from od_requests o
                 where o.user_id = v_uid and o.status = 'approved'
                   and o.starts_at < ((v_today + 1)::timestamp at time zone 'Asia/Kolkata') and o.ends_at > (v_today::timestamp at time zone 'Asia/Kolkata')
                 order by o.starts_at limit 1),
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

-- 3. HR moves a person to another hub from the roster; the profile follows and the person is told
create or replace function public.sync_roster_to_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if new.hub_name is not null and not exists (select 1 from hubs where name = new.hub_name) then raise exception 'unknown_hub'; end if;
  update profiles set designation = new.designation, phone = new.phone, employee_code = new.employee_code,
    full_name = new.full_name, hub_id = (select id from hubs where name = new.hub_name)
  where email = new.email returning id into v_id;
  if v_id is not null and new.hub_name is distinct from old.hub_name and new.hub_name is not null then
    insert into notifications (user_id, kind, title, body, data)
    values (v_id, 'hub_changed', 'Hub changed', new.hub_name || ' hub from today.', jsonb_build_object('hub', new.hub_name));
  end if;
  return new;
end $$;
revoke execute on function sync_roster_to_profile() from public, anon, authenticated;
