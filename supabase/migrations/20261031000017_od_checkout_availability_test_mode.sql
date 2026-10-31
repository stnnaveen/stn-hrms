-- 1. Leaving for an OD is not an early leave. The check-out remembers which OD it was for;
--    if that OD is later returned, the check-out counts as early after all.
alter table attendance_days add column if not exists leave_od_id uuid references od_requests (id) on delete set null;

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
  if p_decision = 'returned' then update attendance_days set early_out = true where leave_od_id = p_id; end if;
  select full_name into v_name from profiles where id = r.user_id;
  insert into notifications (user_id, kind, title, body, data) values
    (r.user_id, 'od_' || p_decision, case when p_decision = 'approved' then 'OD approved' else 'OD returned' end,
     case when p_decision = 'approved' then r.subject else r.subject || ' · ' || p_reason end, jsonb_build_object('od_id', p_id)),
    (auth.uid(), 'od_' || p_decision, case when p_decision = 'approved' then 'OD approved' else 'OD returned' end,
     v_name || ' · ' || r.subject, jsonb_build_object('od_id', p_id));
end $$;

-- 2. Chairman availability: optional slots when staff can meet him. Staff see today's on their home.
create table if not exists chairman_availability (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  place text,
  note text check (length(note) <= 140),
  created_by uuid not null references profiles (id) on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
alter table chairman_availability enable row level security;
create policy avail_read on chairman_availability for select to authenticated using (ends_at > now() - interval '1 day' or sees_all());
create policy avail_write on chairman_availability for all to authenticated using (my_role() = 'chairman') with check (my_role() = 'chairman');
create trigger audit_chairman_availability after insert or update or delete on chairman_availability for each row execute function audit_row();

-- 3. Test accounts: the Tech admin's test staff can check in and out again and again (each new check-in clears that
--    test person's day). Test staff are left out of HR's and the Chairman's numbers. Tech can switch this off per account.
alter table staff_roster add column if not exists test_mode boolean not null default true;
create or replace function public.is_test_user(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p join staff_roster r on r.email = p.email where p.id = p_uid and r.is_test)
$$;
create or replace function public.is_test_mode(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p join staff_roster r on r.email = p.email where p.id = p_uid and r.is_test and r.test_mode)
$$;
create or replace function public.set_test_mode(p_email text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  update staff_roster set test_mode = p_on where email = lower(trim(p_email)) and is_test;
  if not found then raise exception 'not_test_staff'; end if;
end $$;
create or replace function public.reset_my_test_day() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_today date := (now() at time zone 'Asia/Kolkata')::date; v_keys text[];
begin
  if not is_test_mode(v_uid) then raise exception 'not_test_mode'; end if;
  select array_agg(selfie_key) filter (where selfie_key is not null) into v_keys from punches
    where user_id = v_uid and server_time >= (v_today::timestamp at time zone 'Asia/Kolkata');
  delete from attendance_days where user_id = v_uid and day = v_today;
  delete from flags where user_id = v_uid and created_at >= (v_today::timestamp at time zone 'Asia/Kolkata');
  delete from punches where user_id = v_uid and server_time >= (v_today::timestamp at time zone 'Asia/Kolkata');
  return jsonb_build_object('selfie_keys', to_jsonb(coalesce(v_keys, '{}')));
end $$;
revoke execute on function reset_my_test_day() from public, anon;
grant execute on function reset_my_test_day() to authenticated;

create or replace function public.hr_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'staff', (select count(*) from profiles where role in ('staff', 'intern') and active and not is_test_user(id)),
    'checked_in', (select count(*) from attendance_days where day = v_today and in_time is not null and not is_test_user(user_id)),
    'late', (select count(*) from attendance_days where day = v_today and band in ('warn', 'bad') and not is_test_user(user_id)),
    'od', (select count(distinct user_id) from od_requests where status = 'approved' and starts_at::date <= v_today and ends_at::date >= v_today and not is_test_user(user_id)),
    'leave', (select count(distinct user_id) from leave_requests where status = 'approved' and starts_on <= v_today and ends_on >= v_today and not is_test_user(user_id)),
    'pending_leave', (select count(*) from leave_requests where status = 'pending'),
    'pending_od', (select count(*) from od_requests where status = 'pending'),
    'open_flags', (select count(*) from flags where status in ('open', 'reason_asked') and (kind <> 'late' or staff_reason is not null)),
    'chairman_away', coalesce((setting('chairman_away'))::boolean, false)
  );
end $$;

-- 4. my_today: add test mode, all of today's ODs (for "leaving for OD" at check-out) and the Chairman's slots today
create or replace function public.my_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from timestamptz := (v_today::timestamp at time zone 'Asia/Kolkata');
  v_to timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Kolkata');
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

-- 5. A ready test staff login (codes arrive in naveenflop@gmail.com; Gmail delivers +staff there). Remove before the pilot.
insert into staff_roster (email, full_name, role, hub_name, designation, is_test, test_mode)
values ('naveenflop+staff@gmail.com', 'Test Staff', 'staff', 'Chennai', 'Test', true, true)
on conflict (email) do update set is_test = true, test_mode = true;
