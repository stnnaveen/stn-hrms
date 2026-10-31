-- 1. Hubs: know which pins were really set. The seed pins are city centres; a hub saved with the same
--    coordinates (as happened with a short link the old editor couldn't read) still counts as not set.
alter table hubs add column if not exists pin_set_at timestamptz;
create or replace function public.hub_pin_set() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.lat is distinct from old.lat or new.lng is distinct from old.lng then new.pin_set_at := now(); end if;
  if new.radius_m not between 50 and 3000 then raise exception 'radius_out_of_range'; end if;
  return new;
end $$;
revoke execute on function hub_pin_set() from public, anon, authenticated;
create trigger hub_pin_set before insert or update on hubs for each row execute function hub_pin_set();
-- existing hubs start as not set (null) until someone saves a real pin

-- 2. Place names: the label style changed (road, area, city instead of a nearby building), so drop the cache
delete from geo_cache;

-- 3. Test staff: real staff accounts the Tech admin adds for trying the app; their records are easy to clear
alter table staff_roster add column if not exists is_test boolean not null default false;
create or replace function public.add_test_staff(p_email text, p_name text, p_hub text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if exists (select 1 from staff_roster where email = v_email and not is_test) then raise exception 'already_added'; end if;
  insert into staff_roster (email, full_name, role, hub_name, designation, is_test)
  values (v_email, coalesce(nullif(trim(p_name), ''), 'Test staff'), 'staff', p_hub, 'Test', true)
  on conflict (email) do update set full_name = excluded.full_name, hub_name = excluded.hub_name;
  update profiles set active = true where email = v_email;
end $$;

-- 4. Testing phase: the Tech admin clears records by person, hub, test staff or everyone, for a date range.
--    audit_log is never touched (CLAUDE.md rule 6): each removal is itself logged. Dry run returns counts only.
--    Returns the selfie keys of removed check-ins so the edge function can delete the photos.
create or replace function public.purge_records(
  p_scope text, p_user uuid default null, p_hub text default null,
  p_from date default null, p_to date default null,
  p_what text[] default array['checkins', 'flags', 'od', 'leave', 'notifications'],
  p_dry boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_users uuid[]; v_from timestamptz; v_to timestamptz; v_keys text[];
  n_p int := 0; n_d int := 0; n_f int := 0; n_o int := 0; n_l int := 0; n_n int := 0; n_v int := 0;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if p_scope not in ('person', 'hub', 'test', 'everyone') then raise exception 'bad_scope'; end if;
  select array_agg(p.id) into v_users from profiles p
  where p.role in ('staff', 'intern')
    and case p_scope
      when 'person' then p.id = p_user
      when 'hub' then p.hub_id = (select id from hubs where name = p_hub)
      when 'test' then p.email in (select email from staff_roster where is_test)
      else true end;
  v_users := coalesce(v_users, '{}');
  v_from := coalesce(p_from, '2000-01-01')::timestamp at time zone 'Asia/Kolkata';
  v_to := (coalesce(p_to, '2100-01-01') + 1)::timestamp at time zone 'Asia/Kolkata';

  if 'checkins' = any(p_what) then
    select count(*), array_agg(selfie_key) filter (where selfie_key is not null) into n_p, v_keys
      from punches where user_id = any(v_users) and server_time >= v_from and server_time < v_to;
    select count(*) into n_d from attendance_days where user_id = any(v_users) and day >= coalesce(p_from, '2000-01-01') and day <= coalesce(p_to, '2100-01-01');
  end if;
  if 'flags' = any(p_what) or 'checkins' = any(p_what) then
    select count(*) into n_f from flags where user_id = any(v_users) and created_at >= v_from and created_at < v_to;
  end if;
  if 'od' = any(p_what) then select count(*) into n_o from od_requests where user_id = any(v_users) and starts_at >= v_from and starts_at < v_to; end if;
  if 'leave' = any(p_what) then select count(*) into n_l from leave_requests where user_id = any(v_users) and starts_on >= coalesce(p_from, '2000-01-01') and starts_on <= coalesce(p_to, '2100-01-01'); end if;
  if 'notifications' = any(p_what) then select count(*) into n_n from notifications where user_id = any(v_users) and created_at >= v_from and created_at < v_to; end if;
  if 'devices' = any(p_what) then select count(*) into n_v from devices where user_id = any(v_users); end if;

  if not p_dry then
    if 'flags' = any(p_what) or 'checkins' = any(p_what) then delete from flags where user_id = any(v_users) and created_at >= v_from and created_at < v_to; end if;
    if 'checkins' = any(p_what) then
      delete from attendance_days where user_id = any(v_users) and day >= coalesce(p_from, '2000-01-01') and day <= coalesce(p_to, '2100-01-01');
      delete from attendance_days where in_punch in (select id from punches where user_id = any(v_users) and server_time >= v_from and server_time < v_to)
                                     or out_punch in (select id from punches where user_id = any(v_users) and server_time >= v_from and server_time < v_to);
      delete from punches where user_id = any(v_users) and server_time >= v_from and server_time < v_to;
    end if;
    if 'od' = any(p_what) then delete from od_requests where user_id = any(v_users) and starts_at >= v_from and starts_at < v_to; end if;
    if 'leave' = any(p_what) then delete from leave_requests where user_id = any(v_users) and starts_on >= coalesce(p_from, '2000-01-01') and starts_on <= coalesce(p_to, '2100-01-01'); end if;
    if 'notifications' = any(p_what) then delete from notifications where user_id = any(v_users) and created_at >= v_from and created_at < v_to; end if;
    if 'devices' = any(p_what) then delete from devices where user_id = any(v_users); end if;
    perform append_audit('purge', 'records', p_scope, null, jsonb_build_object('scope', p_scope, 'user', p_user, 'hub', p_hub, 'from', p_from, 'to', p_to,
      'what', p_what, 'people', cardinality(v_users), 'checkins', n_p, 'days', n_d, 'flags', n_f, 'od', n_o, 'leave', n_l, 'notifications', n_n, 'devices', n_v));
  end if;
  return jsonb_build_object('people', cardinality(v_users), 'checkins', n_p, 'days', n_d, 'flags', n_f, 'od', n_o, 'leave', n_l,
    'notifications', n_n, 'devices', n_v, 'selfie_keys', case when p_dry then '[]'::jsonb else to_jsonb(coalesce(v_keys, '{}')) end);
end $$;
