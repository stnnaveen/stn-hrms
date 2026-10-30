-- StartupTN HR · helpers, audit, row-level security and RPCs

-- ---------- helpers ----------
create or replace function public.my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
$$;

create or replace function public.sees_all() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() in ('hr', 'chairman', 'tech'), false)
$$;

create or replace function public.is_hr_or_tech() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(my_role() in ('hr', 'tech'), false)
$$;

create or replace function public.setting(k text) returns jsonb
language sql stable security definer set search_path = public as $$
  select value from settings where key = k
$$;

-- great-circle distance in metres (haversine); accurate to well under 1 m at hub scale
create or replace function public.distance_m(lat1 float8, lng1 float8, lat2 float8, lng2 float8) returns float8
language sql immutable as $$
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- ---------- audit ----------
create or replace function public.append_audit(p_action text, p_entity text, p_entity_id text, p_before jsonb, p_after jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_actor uuid := auth.uid();
  v_role text;
  v_prev text;
begin
  select role::text into v_role from profiles where id = v_actor;
  if v_actor is null then v_role := 'system'; end if;
  perform pg_advisory_xact_lock(424242);
  select hash into v_prev from audit_log order by id desc limit 1;
  insert into audit_log (actor_id, actor_role, action, entity, entity_id, before, after, prev_hash, hash)
  values (v_actor, v_role, p_action, p_entity, p_entity_id, p_before, p_after, v_prev,
    encode(digest(coalesce(v_prev, '') || p_action || p_entity || coalesce(p_entity_id, '') ||
      coalesce(p_after::text, p_before::text, '') || clock_timestamp()::text, 'sha256'), 'hex'));
end $$;

create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_before jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_after jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  perform append_audit(lower(tg_op), tg_table_name,
    coalesce(v_after ->> 'id', v_before ->> 'id', v_after ->> 'key', v_before ->> 'key'), v_before, v_after);
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['hubs', 'custom_roles', 'profiles', 'settings', 'devices', 'od_requests', 'leave_requests', 'flags'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$I for each row execute function audit_row()', t);
  end loop;
end $$;
create trigger audit_punches after insert on punches for each row execute function audit_row();

create or replace function public.audit_is_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append only';
end $$;
create trigger audit_no_change before update or delete on audit_log for each row execute function audit_is_append_only();

-- app-level actions (exports, re-runs, views of sensitive data)
create or replace function public.log_action(p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}')
returns void language plpgsql security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  perform append_audit(p_action, p_entity, p_entity_id, null, p_details);
end $$;

-- ---------- guards ----------
-- only the Tech admin changes roles or role logins (PRD TA-07)
create or replace function public.guard_profile_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and (new.role is distinct from old.role or new.custom_role_id is distinct from old.custom_role_id
          or (new.email is distinct from old.email and old.role in ('hr', 'chairman', 'tech')))
     and coalesce(my_role() <> 'tech', true) then
    raise exception 'only the Tech admin can change roles or role logins';
  end if;
  return new;
end $$;
create trigger profiles_guard_role before update on profiles for each row execute function guard_profile_role();

-- ---------- notifications ----------
create or replace function public.notify_role(p_role app_role, p_kind text, p_title text, p_body text, p_data jsonb)
returns void language sql security definer set search_path = public as $$
  insert into notifications (user_id, kind, title, body, data)
  select id, p_kind, p_title, p_body, p_data from profiles where role = p_role and active
$$;

-- new OD goes to the Chairman, or to HR while the Chairman is Away (PRD CH-04)
create or replace function public.on_od_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  select full_name into v_name from profiles where id = new.user_id;
  perform notify_role(
    case when coalesce((setting('chairman_away'))::boolean, false) then 'hr'::app_role else 'chairman'::app_role end,
    'od_new', 'New OD request', v_name || ' · ' || new.subject, jsonb_build_object('od_id', new.id));
  return new;
end $$;
create trigger od_created after insert on od_requests for each row execute function on_od_created();

create or replace function public.on_leave_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if new.assigned_by_hr then return new; end if;
  select full_name into v_name from profiles where id = new.user_id;
  perform notify_role('hr', 'leave_new', 'New leave request', v_name || ' · ' || initcap(new.leave_type), jsonb_build_object('leave_id', new.id));
  return new;
end $$;
create trigger leave_created after insert on leave_requests for each row execute function on_leave_created();

-- ---------- row-level security ----------
alter table hubs enable row level security;
alter table custom_roles enable row level security;
alter table profiles enable row level security;
alter table settings enable row level security;
alter table devices enable row level security;
alter table od_requests enable row level security;
alter table leave_requests enable row level security;
alter table punches enable row level security;
alter table attendance_days enable row level security;
alter table flags enable row level security;
alter table notifications enable row level security;
alter table geo_cache enable row level security;
alter table audit_log enable row level security;

-- hubs carry the radius, so staff read hub names through hub_directory only
create policy hubs_read on hubs for select using (sees_all());
create policy hubs_write on hubs for all using (is_hr_or_tech()) with check (is_hr_or_tech());

create policy roles_read on custom_roles for select using (sees_all());
create policy roles_write on custom_roles for all using (my_role() = 'tech') with check (my_role() = 'tech');

create policy profiles_read on profiles for select using (id = auth.uid() or sees_all());
create policy profiles_write on profiles for update using (is_hr_or_tech()) with check (is_hr_or_tech());
create policy profiles_insert on profiles for insert with check (is_hr_or_tech());

create policy settings_read on settings for select using (sees_all());
create policy settings_write on settings for update using (my_role() = 'tech') with check (my_role() = 'tech');

create policy devices_read on devices for select using (user_id = auth.uid() or is_hr_or_tech());
create policy devices_write on devices for update using (my_role() = 'tech') with check (my_role() = 'tech');

create policy od_read on od_requests for select using (user_id = auth.uid() or sees_all());
create policy od_insert on od_requests for insert
  with check (user_id = auth.uid() and status = 'pending' and decided_by is null);
create policy od_cancel on od_requests for update
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'cancelled' and decided_by is null);

create policy leave_read on leave_requests for select using (user_id = auth.uid() or sees_all());
create policy leave_insert on leave_requests for insert
  with check (user_id = auth.uid() and status = 'pending' and not assigned_by_hr and decided_by is null);
create policy leave_cancel on leave_requests for update
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'cancelled' and decided_by is null);

-- punches hold distance and inside/outside: never readable by staff (they use my_punches)
create policy punches_read on punches for select using (sees_all());
create policy days_read on attendance_days for select using (user_id = auth.uid() or sees_all());
-- flags are invisible to staff; they only see "add a reason" notifications
create policy flags_read on flags for select using (sees_all());

create policy notif_read on notifications for select using (user_id = auth.uid());
create policy notif_mark on notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy audit_read on audit_log for select using (my_role() = 'tech');
-- geo_cache: no policies, service role only

-- ---------- safe views for staff ----------
create view hub_directory as select id, name from hubs where active;
create view my_punches as
  select id, kind, server_time, place_name, lat, lng, band, early_out, selfie_key
  from punches where user_id = auth.uid();

-- ---------- RPCs ----------
create or replace function public.give_consent() returns void
language sql security definer set search_path = public as $$
  update profiles set consent_at = now() where id = auth.uid() and consent_at is null
$$;

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

create or replace function public.set_chairman_away(p_away boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'chairman' then raise exception 'only the Chairman sets In or Away'; end if;
  update settings set value = to_jsonb(p_away), updated_at = now() where key = 'chairman_away';
end $$;

-- Chairman decides OD; HR decides only while the Chairman is Away (PRD CH-03, CH-04, CH-07)
create or replace function public.decide_od(p_id uuid, p_decision text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_role app_role := my_role();
  r od_requests;
  v_name text;
begin
  if p_decision not in ('approved', 'returned') then raise exception 'decision must be approved or returned'; end if;
  if p_decision = 'returned' and coalesce(trim(p_reason), '') = '' then raise exception 'a reason is needed to return'; end if;
  if not (v_role = 'chairman' or (v_role = 'hr' and coalesce((setting('chairman_away'))::boolean, false))) then
    raise exception 'not allowed to decide OD now';
  end if;
  select * into r from od_requests where id = p_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'OD is not pending'; end if;
  update od_requests set status = p_decision::request_status, decided_by = auth.uid(), decided_role = v_role,
    decided_at = now(), return_reason = p_reason where id = p_id;
  select full_name into v_name from profiles where id = r.user_id;
  insert into notifications (user_id, kind, title, body, data) values
    (r.user_id, 'od_' || p_decision, case when p_decision = 'approved' then 'OD approved' else 'OD returned' end,
     case when p_decision = 'approved' then r.subject else r.subject || ' · ' || p_reason end, jsonb_build_object('od_id', p_id)),
    (auth.uid(), 'od_' || p_decision, case when p_decision = 'approved' then 'OD approved' else 'OD returned' end,
     v_name || ' · ' || r.subject, jsonb_build_object('od_id', p_id));
end $$;

create or replace function public.decide_leave(p_id uuid, p_decision text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r leave_requests;
begin
  if my_role() <> 'hr' then raise exception 'only HR decides leave'; end if;
  if p_decision not in ('approved', 'returned') then raise exception 'decision must be approved or returned'; end if;
  select * into r from leave_requests where id = p_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'leave is not pending'; end if;
  update leave_requests set status = p_decision::request_status, decided_by = auth.uid(), decided_at = now(), return_reason = p_reason
    where id = p_id;
  insert into notifications (user_id, kind, title, body, data) values
    (r.user_id, 'leave_' || p_decision, case when p_decision = 'approved' then 'Leave approved' else 'Leave returned' end,
     initcap(r.leave_type) || ' · ' || to_char(r.starts_on, 'DD Mon'), jsonb_build_object('leave_id', p_id));
end $$;

-- long leave (maternity, paternity, sabbatical) assigned directly by HR
create or replace function public.assign_long_leave(p_user uuid, p_type text, p_from date, p_to date, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if my_role() <> 'hr' then raise exception 'only HR assigns long leave'; end if;
  insert into leave_requests (user_id, leave_type, starts_on, ends_on, reason, status, assigned_by_hr, decided_by, decided_at)
  values (p_user, p_type, p_from, p_to, p_note, 'approved', true, auth.uid(), now()) returning id into v_id;
  insert into notifications (user_id, kind, title, body, data)
  values (p_user, 'leave_assigned', initcap(p_type) || ' leave added', to_char(p_from, 'DD Mon') || ' to ' || to_char(p_to, 'DD Mon YYYY'),
          jsonb_build_object('leave_id', v_id));
  return v_id;
end $$;

-- HR asks for a reason without revealing which check flagged the punch
create or replace function public.ask_flag_reason(p_flag uuid) returns void
language plpgsql security definer set search_path = public as $$
declare f flags; v_when text;
begin
  if my_role() <> 'hr' then raise exception 'only HR'; end if;
  select * into f from flags where id = p_flag for update;
  update flags set status = 'reason_asked' where id = p_flag;
  select to_char(server_time at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM') into v_when from punches where id = f.punch_id;
  insert into notifications (user_id, kind, title, body, data)
  values (f.user_id, 'reason_asked', 'Add a reason', 'For your check-in on ' || coalesce(v_when, 'a recent day'), jsonb_build_object('flag_id', p_flag));
end $$;

create or replace function public.submit_flag_reason(p_flag uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'add a reason'; end if;
  update flags set staff_reason = p_reason where id = p_flag and user_id = auth.uid() and status = 'reason_asked';
  if not found then raise exception 'nothing to answer'; end if;
end $$;

create or replace function public.decide_flag(p_flag uuid, p_decision text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'hr' then raise exception 'only HR decides disputes'; end if;
  if p_decision not in ('valid', 'violation') then raise exception 'decision must be valid or violation'; end if;
  update flags set status = p_decision::flag_status, decided_by = auth.uid(), decided_at = now() where id = p_flag;
end $$;

create or replace function public.mark_false_flag(p_flag uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() <> 'tech' then raise exception 'only the Tech admin'; end if;
  update flags set details = details || jsonb_build_object('false_flag_by', auth.uid(), 'false_flag_at', now()) where id = p_flag;
end $$;

-- grants: Supabase grants table access to anon/authenticated by default; tighten
revoke all on all tables in schema public from anon;
-- internal functions: server only (edge functions use the service role)
revoke execute on function notify_role(app_role, text, text, text, jsonb) from public, anon, authenticated;
revoke execute on function append_audit(text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function audit_row(), guard_profile_role(), on_od_created(), on_leave_created(), audit_is_append_only() from public, anon, authenticated;
grant execute on function notify_role(app_role, text, text, text, jsonb) to service_role;
grant select on hub_directory, my_punches to authenticated;
