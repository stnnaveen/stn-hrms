-- Tech admin app (PRD TA-01..TA-09): role logins, phones, rules, audit check.
-- Everything here is Tech only and logged by the existing audit triggers.

-- 1. HR could delete a role account straight from the roster table; only Tech may (PRD TA-07)
create or replace function public.guard_roster_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and old.role in ('hr', 'chairman', 'tech') and coalesce(my_role() <> 'tech', true) then
    raise exception 'only the Tech admin can remove role accounts';
  end if;
  return old;
end $$;
create trigger roster_guard_delete before delete on staff_roster for each row execute function guard_roster_delete();

-- 2. Role logins: add (or re-activate) and remove. Never lock the last Tech admin out.
create or replace function public.add_role_login(p_email text, p_name text, p_role app_role) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email));
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if p_role not in ('hr', 'chairman', 'tech') then raise exception 'role must be hr, chairman or tech'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if exists (select 1 from staff_roster where email = v_email and role not in ('hr', 'chairman', 'tech')) then raise exception 'is_staff'; end if;
  insert into staff_roster (email, full_name, role, hub_name) values (v_email, coalesce(nullif(trim(p_name), ''), case p_role when 'hr' then 'HR' when 'chairman' then 'Chairman' else 'Tech admin' end), p_role, null)
  on conflict (email) do update set role = excluded.role, full_name = excluded.full_name;
  update profiles set role = p_role, active = true, full_name = coalesce(nullif(trim(p_name), ''), full_name) where email = v_email;
end $$;

create or replace function public.remove_role_login(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_role app_role;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if v_email = (select email from profiles where id = auth.uid()) then raise exception 'not_yourself'; end if;
  select role into v_role from staff_roster where email = v_email;
  if v_role is null or v_role not in ('hr', 'chairman', 'tech') then raise exception 'not_a_role_login'; end if;
  if v_role = 'tech' and (select count(*) from staff_roster where role = 'tech') <= 1 then raise exception 'last_tech'; end if;
  delete from staff_roster where email = v_email;
  update profiles set active = false where email = v_email;   -- my_role() ignores inactive profiles, so access ends now
end $$;

-- 3. Rules the check-in function reads, with safe ranges
create or replace function public.set_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare n numeric; t text;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if p_key in ('office_start', 'late_until', 'office_end') then
    t := p_value #>> '{}';
    if t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'bad_time'; end if;
  elsif p_key in ('face_threshold', 'same_point_days', 'offline_flag_minutes', 'clock_gap_minutes', 'jump_kmh', 'od_notice_hours') then
    n := (p_value #>> '{}')::numeric;
    if (p_key = 'face_threshold' and n not between 50 and 99) or (p_key = 'same_point_days' and n not between 2 and 30)
       or (p_key = 'offline_flag_minutes' and n not between 5 and 720) or (p_key = 'clock_gap_minutes' and n not between 1 and 60)
       or (p_key = 'jump_kmh' and n not between 60 and 1000) or (p_key = 'od_notice_hours' and n not between 0 and 168) then
      raise exception 'out_of_range';
    end if;
    p_value := to_jsonb(n);
  else
    raise exception 'unknown_setting';
  end if;
  update settings set value = p_value, updated_at = now() where key = p_key;
  if (setting('late_until') #>> '{}') < (setting('office_start') #>> '{}') then raise exception 'late_before_start'; end if;
end $$;

-- 4. Phones: allow / deny a new phone, or reset so the next phone binds on its own
create or replace function public.decide_device(p_id uuid, p_allow boolean) returns void
language plpgsql security definer set search_path = public as $$
declare d devices;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  select * into d from devices where id = p_id for update;
  if d.id is null or d.status <> 'pending' then raise exception 'not_pending'; end if;
  if p_allow then
    update devices set status = 'revoked' where user_id = d.user_id and status = 'active';
    update devices set status = 'active', approved_by = auth.uid(), approved_at = now() where id = p_id;
  else
    update devices set status = 'revoked', approved_by = auth.uid(), approved_at = now() where id = p_id;
  end if;
  insert into notifications (user_id, kind, title, body, data) values (d.user_id, 'device_' || case when p_allow then 'ok' else 'no' end,
    case when p_allow then 'New phone approved' else 'New phone not approved' end,
    case when p_allow then 'Check in from this phone.' else 'Use your usual phone, or contact HR.' end, jsonb_build_object('device_id', p_id));
end $$;

create or replace function public.reset_devices(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  update devices set status = 'revoked', approved_by = auth.uid(), approved_at = now() where user_id = p_user and status <> 'revoked';
end $$;

-- 5. Audit chain check: every row must point at the hash of the row before it
create or replace function public.verify_audit_chain() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r record; v_prev text; v_n bigint := 0;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  for r in select id, prev_hash, hash from audit_log order by id loop
    if v_n > 0 and r.prev_hash is distinct from v_prev then
      return jsonb_build_object('ok', false, 'rows', v_n + 1, 'broken_at', r.id);
    end if;
    v_prev := r.hash; v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_n);
end $$;

revoke execute on function guard_roster_delete() from public, anon, authenticated;
