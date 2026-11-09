-- 9 Nov: government holidays and office leave days; HR marks a person absent or on leave for a day;
-- reporting staff; who approves leave (HR picks) and OD (Chairman picks): Chairman, HR or the reporting person.

-- ======================= 1. holidays =======================
create table holidays (
  day date primary key,
  name text not null check (length(trim(name)) between 2 and 80),
  kind text not null default 'govt' check (kind in ('govt', 'office')),   -- govt = public holiday, office = office leave day declared by HR
  created_by uuid references profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
alter table holidays enable row level security;
create policy holidays_read on holidays for select to authenticated using (true);   -- everyone sees the holiday list
create trigger audit_holidays after insert or update or delete on holidays for each row execute function audit_row();

-- Tamil Nadu public holidays (Government list for 2026; 2027 as announced 23 Oct 2026 — HR can edit)
insert into holidays (day, name, kind, created_by) values
 ('2026-01-01','New Year''s Day','govt',null), ('2026-01-15','Pongal','govt',null), ('2026-01-16','Thiruvalluvar Day','govt',null),
 ('2026-01-17','Uzhavar Thirunal','govt',null), ('2026-01-26','Republic Day','govt',null), ('2026-02-01','Thai Poosam','govt',null),
 ('2026-03-19','Telugu New Year''s Day','govt',null), ('2026-03-21','Ramzan','govt',null), ('2026-03-31','Mahaveer Jayanthi','govt',null),
 ('2026-04-03','Good Friday','govt',null), ('2026-04-14','Tamil New Year''s Day / Dr. B. R. Ambedkar''s Birthday','govt',null),
 ('2026-05-01','May Day','govt',null), ('2026-05-28','Bakrid','govt',null), ('2026-06-26','Muharram','govt',null),
 ('2026-08-15','Independence Day','govt',null), ('2026-08-26','Milad-un-Nabi','govt',null), ('2026-09-04','Krishna Jayanthi','govt',null),
 ('2026-09-14','Vinayagar Chathurthi','govt',null), ('2026-10-02','Gandhi Jayanthi','govt',null), ('2026-10-19','Ayudha Poojai','govt',null),
 ('2026-10-20','Vijayadasami','govt',null), ('2026-11-08','Deepavali','govt',null), ('2026-12-25','Christmas','govt',null),
 ('2027-01-01','New Year''s Day','govt',null), ('2027-01-15','Pongal','govt',null), ('2027-01-16','Thiruvalluvar Day','govt',null),
 ('2027-01-17','Uzhavar Thirunal','govt',null), ('2027-01-22','Thai Poosam','govt',null), ('2027-01-26','Republic Day','govt',null),
 ('2027-03-10','Ramzan','govt',null), ('2027-03-26','Good Friday','govt',null), ('2027-04-07','Telugu New Year''s Day','govt',null),
 ('2027-04-14','Tamil New Year''s Day / Dr. B. R. Ambedkar''s Birthday','govt',null), ('2027-04-19','Mahaveer Jayanthi','govt',null),
 ('2027-05-01','May Day','govt',null), ('2027-05-17','Bakrid','govt',null), ('2027-06-15','Muharram','govt',null),
 ('2027-08-15','Independence Day / Milad-un-Nabi','govt',null), ('2027-08-25','Krishna Jayanthi','govt',null),
 ('2027-09-04','Vinayagar Chathurthi','govt',null), ('2027-10-02','Gandhi Jayanthi','govt',null), ('2027-10-08','Ayudha Poojai','govt',null),
 ('2027-10-09','Vijayadasami','govt',null), ('2027-10-28','Deepavali','govt',null), ('2027-12-25','Christmas','govt',null)
on conflict (day) do nothing;

create or replace function public.save_holiday(p_day date, p_name text, p_kind text default 'govt') returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'hr' then raise exception 'only HR edits holidays'; end if;
  if p_kind not in ('govt', 'office') then raise exception 'kind must be govt or office'; end if;
  if coalesce(length(trim(p_name)), 0) not between 2 and 80 then raise exception 'name 2–80 letters'; end if;
  if p_day < current_date - 400 or p_day > current_date + 800 then raise exception 'date out of range'; end if;
  insert into holidays (day, name, kind) values (p_day, trim(p_name), p_kind)
  on conflict (day) do update set name = excluded.name, kind = excluded.kind;
end $$;
create or replace function public.delete_holiday(p_day date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if my_role() is distinct from 'hr' then raise exception 'only HR edits holidays'; end if;
  delete from holidays where day = p_day;
end $$;
revoke execute on function save_holiday(date, text, text) from public, anon;
revoke execute on function delete_holiday(date) from public, anon;
grant execute on function save_holiday(date, text, text) to authenticated;
grant execute on function delete_holiday(date) to authenticated;

-- ======================= 2. HR day marks =======================
create table day_marks (
  email text not null references staff_roster (email) on update cascade on delete cascade,
  day date not null,
  mark text not null check (mark in ('absent', 'leave')),
  leave_type text check (leave_type in ('casual', 'sick', 'earned', 'other')),
  note text check (length(note) <= 200),
  marked_by uuid references profiles (id) on delete set null default auth.uid(),
  marked_at timestamptz not null default now(),
  primary key (email, day),
  check (mark = 'leave' or leave_type is null)
);
alter table day_marks enable row level security;
create policy day_marks_read on day_marks for select to authenticated
  using (sees_all() or email = (select p.email from profiles p where p.id = auth.uid()));
create trigger audit_day_marks after insert or update or delete on day_marks for each row execute function audit_row();

-- HR marks Absent or Leave for one person and day; p_mark null clears it. The person is told (if signed in).
create or replace function public.set_day_mark(p_email text, p_day date, p_mark text, p_leave_type text default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text := lower(trim(p_email)); v_uid uuid; v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if my_role() is distinct from 'hr' then raise exception 'only HR marks attendance'; end if;
  if not exists (select 1 from staff_roster where email = v_email) then raise exception 'not on the staff list'; end if;
  if p_day < v_today - 62 then raise exception 'only the last two months'; end if;
  if p_mark = 'absent' and p_day > v_today then raise exception 'absent only for today or earlier'; end if;
  if p_mark = 'leave' and p_day > v_today + 90 then raise exception 'leave up to 90 days ahead'; end if;
  select id into v_uid from profiles where email = v_email;
  if p_mark is null then
    delete from day_marks where email = v_email and day = p_day;
    return;
  end if;
  if p_mark not in ('absent', 'leave') then raise exception 'mark must be absent or leave'; end if;
  insert into day_marks (email, day, mark, leave_type, note)
  values (v_email, p_day, p_mark, case when p_mark = 'leave' then coalesce(p_leave_type, 'other') end, nullif(left(trim(coalesce(p_note, '')), 200), ''))
  on conflict (email, day) do update set mark = excluded.mark, leave_type = excluded.leave_type, note = excluded.note,
    marked_by = auth.uid(), marked_at = now();
  if v_uid is not null then
    insert into notifications (user_id, kind, title, body, data)
    values (v_uid, 'day_mark', case when p_mark = 'absent' then 'Marked absent' else 'Leave marked' end,
            to_char(p_day, 'DD Mon YYYY') || case when p_mark = 'leave' then ' · ' || initcap(coalesce(p_leave_type, 'other')) else '' end,
            jsonb_build_object('day', p_day));
  end if;
end $$;
revoke execute on function set_day_mark(text, date, text, text, text) from public, anon;
grant execute on function set_day_mark(text, date, text, text, text) to authenticated;

-- ======================= 3. reporting staff and approval routing =======================
alter table staff_roster add column if not exists reports_to text references staff_roster (email) on update cascade on delete set null;
alter table staff_roster add constraint staff_roster_reports_to_not_self check (reports_to is null or reports_to <> email);
alter table od_requests add column if not exists decided_route text;
alter table leave_requests add column if not exists decided_route text;
insert into settings (key, value) values ('leave_approver', '"hr"'), ('od_approver', '"chairman"') on conflict (key) do nothing;

create or replace function public.set_reports_to(p_email text, p_reports_to text) returns void
language plpgsql security definer set search_path = public as $$
declare v_e text := lower(trim(p_email)); v_r text := nullif(lower(trim(coalesce(p_reports_to, ''))), ''); v_x text; i int := 0;
begin
  if my_role() is distinct from 'hr' then raise exception 'only HR assigns reporting staff'; end if;
  if v_r = v_e then raise exception 'cannot report to themselves'; end if;
  if v_r is not null and not exists (select 1 from staff_roster where email = v_r) then raise exception 'reporting person not on the staff list'; end if;
  v_x := v_r;                                     -- no loops: A -> B -> ... -> A
  while v_x is not null and i < 20 loop
    if v_x = v_e then raise exception 'that would make a reporting loop'; end if;
    select reports_to into v_x from staff_roster where email = v_x; i := i + 1;
  end loop;
  update staff_roster set reports_to = v_r where email = v_e;
  if not found then raise exception 'not on the staff list'; end if;
end $$;
revoke execute on function set_reports_to(text, text) from public, anon;
grant execute on function set_reports_to(text, text) to authenticated;

-- leave approver: HR decides it. OD approver: the Chairman decides it.
create or replace function public.set_approver(p_kind text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'leave' then
    if my_role() is distinct from 'hr' then raise exception 'only HR sets who approves leave'; end if;
    if p_value not in ('hr', 'chairman', 'reporting') then raise exception 'choose HR, Chairman or reporting staff'; end if;
    update settings set value = to_jsonb(p_value), updated_at = now() where key = 'leave_approver';
  elsif p_kind = 'od' then
    if my_role() is distinct from 'chairman' then raise exception 'only the Chairman sets who approves OD'; end if;
    if p_value not in ('chairman', 'hr', 'reporting') then raise exception 'choose Chairman, HR or reporting staff'; end if;
    update settings set value = to_jsonb(p_value), updated_at = now() where key = 'od_approver';
  else raise exception 'kind must be leave or od'; end if;
end $$;
revoke execute on function set_approver(text, text) from public, anon;
grant execute on function set_approver(text, text) to authenticated;

-- who decides a request now. Reporting staff need a signed-in account; without one it falls back
-- (leave -> HR, OD -> Chairman). The Chairman being Away hands his share to HR, as before.
create or replace function public.request_route(p_kind text, p_user uuid)
returns table (route text, approver_id uuid, approver_name text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_set text := setting(case when p_kind = 'leave' then 'leave_approver' else 'od_approver' end) #>> '{}';
  v_away boolean := coalesce((setting('chairman_away'))::boolean, false);
  v_id uuid; v_name text;
begin
  v_set := coalesce(v_set, case when p_kind = 'leave' then 'hr' else 'chairman' end);
  if v_set = 'reporting' then
    select pr.id, pr.full_name into v_id, v_name
    from profiles u join staff_roster r on r.email = u.email join profiles pr on pr.email = r.reports_to and pr.active
    where u.id = p_user;
    if v_id is not null and v_id <> p_user then return query select 'reporting'::text, v_id, v_name; return; end if;
    v_set := case when p_kind = 'leave' then 'hr' else 'chairman' end;
  end if;
  if v_set = 'chairman' and v_away then v_set := 'hr'; end if;
  return query select v_set, null::uuid, case when v_set = 'hr' then 'HR' else 'Chairman' end;
end $$;
revoke execute on function request_route(text, uuid) from public, anon, authenticated;

-- may the caller decide this pending request? Exactly the route's approver; nobody decides their own.
create or replace function public.can_decide(p_kind text, p_id uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_user uuid; v_status request_status; r record; v_role app_role := my_role();
begin
  if p_kind = 'leave' then select user_id, status into v_user, v_status from leave_requests where id = p_id;
  else select user_id, status into v_user, v_status from od_requests where id = p_id; end if;
  if v_user is null or v_status <> 'pending' or v_user = auth.uid() then return false; end if;
  select * into r from request_route(p_kind, v_user);
  return (r.route = 'hr' and v_role = 'hr') or (r.route = 'chairman' and v_role = 'chairman') or (r.route = 'reporting' and r.approver_id = auth.uid());
end $$;
revoke execute on function can_decide(text, uuid) from public, anon;
grant execute on function can_decide(text, uuid) to authenticated;

create or replace function public.decide_od(p_id uuid, p_decision text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r od_requests; v_name text; v_route text;
begin
  if p_decision not in ('approved', 'returned') then raise exception 'decision must be approved or returned'; end if;
  if p_decision = 'returned' and coalesce(trim(p_reason), '') = '' then raise exception 'a reason is needed to return'; end if;
  if not can_decide('od', p_id) then raise exception 'not allowed to decide this OD'; end if;
  select * into r from od_requests where id = p_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'OD is not pending'; end if;
  select route into v_route from request_route('od', r.user_id);
  update od_requests set status = p_decision::request_status, decided_by = auth.uid(), decided_role = my_role(), decided_route = v_route,
    decided_at = now(), return_reason = left(p_reason, 300) where id = p_id;
  if p_decision = 'returned' then update attendance_days set early_out = true where leave_od_id = p_id; end if;
  select full_name into v_name from profiles where id = r.user_id;
  insert into notifications (user_id, kind, title, body, data) values
    (r.user_id, 'od_' || p_decision, case when p_decision = 'approved' then 'OD approved' else 'OD returned' end,
     case when p_decision = 'approved' then r.subject else r.subject || ' · ' || p_reason end, jsonb_build_object('od_id', p_id)),
    (auth.uid(), 'od_' || p_decision, case when p_decision = 'approved' then 'OD approved' else 'OD returned' end,
     v_name || ' · ' || r.subject, jsonb_build_object('od_id', p_id));
end $$;

create or replace function public.decide_leave(p_id uuid, p_decision text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare r leave_requests; v_route text;
begin
  if p_decision not in ('approved', 'returned') then raise exception 'decision must be approved or returned'; end if;
  if p_decision = 'returned' and coalesce(trim(p_reason), '') = '' then raise exception 'a reason is needed to return'; end if;
  if not can_decide('leave', p_id) then raise exception 'not allowed to decide this leave'; end if;
  select * into r from leave_requests where id = p_id for update;
  if r.id is null or r.status <> 'pending' then raise exception 'leave is not pending'; end if;
  select route into v_route from request_route('leave', r.user_id);
  update leave_requests set status = p_decision::request_status, decided_by = auth.uid(), decided_at = now(), decided_route = v_route,
    return_reason = left(p_reason, 300) where id = p_id;
  insert into notifications (user_id, kind, title, body, data) values
    (r.user_id, 'leave_' || p_decision, case when p_decision = 'approved' then 'Leave approved' else 'Leave returned' end,
     initcap(r.leave_type) || ' · ' || to_char(r.starts_on, 'DD Mon'), jsonb_build_object('leave_id', p_id));
end $$;

-- new requests notify whoever decides them
create or replace function public.on_od_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text; r record;
begin
  select full_name into v_name from profiles where id = new.user_id;
  select * into r from request_route('od', new.user_id);
  if r.route = 'reporting' then
    insert into notifications (user_id, kind, title, body, data) values (r.approver_id, 'od_new', 'New OD request', v_name || ' · ' || new.subject, jsonb_build_object('od_id', new.id));
  else perform notify_role(r.route::app_role, 'od_new', 'New OD request', v_name || ' · ' || new.subject, jsonb_build_object('od_id', new.id)); end if;
  return new;
end $$;
create or replace function public.on_leave_created() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text; r record;
begin
  if new.assigned_by_hr then return new; end if;
  select full_name into v_name from profiles where id = new.user_id;
  select * into r from request_route('leave', new.user_id);
  if r.route = 'reporting' then
    insert into notifications (user_id, kind, title, body, data) values (r.approver_id, 'leave_new', 'New leave request', v_name || ' · ' || initcap(new.leave_type), jsonb_build_object('leave_id', new.id));
  else perform notify_role(r.route::app_role, 'leave_new', 'New leave request', v_name || ' · ' || initcap(new.leave_type), jsonb_build_object('leave_id', new.id)); end if;
  return new;
end $$;

-- HR / Chairman lists: who each pending request is with, and whether the caller may decide it
create or replace function public.pending_routes()
returns table (kind text, id uuid, route text, approver_name text, can_decide boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return query
    select 'od'::text, o.id, rr.route, rr.approver_name, can_decide('od', o.id) from od_requests o cross join lateral request_route('od', o.user_id) rr where o.status = 'pending'
    union all
    select 'leave'::text, l.id, rr.route, rr.approver_name, can_decide('leave', l.id) from leave_requests l cross join lateral request_route('leave', l.user_id) rr where l.status = 'pending';
end $$;
revoke execute on function pending_routes() from public, anon;
grant execute on function pending_routes() to authenticated;

-- staff app: requests waiting for me as reporting staff (details needed to decide; nothing about checks)
create or replace function public.my_approvals() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  return jsonb_build_object(
    'od', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'who', p.full_name, 'subject', o.subject, 'note', o.note, 'venue', o.venue_name,
              'venue_url', o.venue_url, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'created_at', o.created_at) order by o.starts_at)
            from od_requests o join profiles p on p.id = o.user_id cross join lateral request_route('od', o.user_id) rr
            where o.status = 'pending' and rr.route = 'reporting' and rr.approver_id = v_uid), '[]'::jsonb),
    'leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'who', p.full_name, 'type', l.leave_type, 'from', l.starts_on, 'to', l.ends_on,
              'half_day', l.half_day, 'reason', l.reason, 'created_at', l.created_at) order by l.starts_on)
            from leave_requests l join profiles p on p.id = l.user_id cross join lateral request_route('leave', l.user_id) rr
            where l.status = 'pending' and rr.route = 'reporting' and rr.approver_id = v_uid), '[]'::jsonb),
    'leave_approver', setting('leave_approver') #>> '{}', 'od_approver', setting('od_approver') #>> '{}');
end $$;
revoke execute on function my_approvals() from public, anon;
grant execute on function my_approvals() to authenticated;

-- ======================= 4. HR home counts with holidays and marks =======================
create or replace function public.hr_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return (
    with staff as (
      select r.email from staff_roster r left join profiles pr on pr.email = r.email
      where r.role in ('staff', 'intern') and not coalesce(r.is_test, false) and coalesce(pr.active, true)),
    a as (
      select pr.email, d.in_time, d.out_time, d.band from attendance_days d join profiles pr on pr.id = d.user_id
      where d.day = v_today and d.in_time is not null and not is_test_user(d.user_id)),
    b as (select x.email, x.in_at, x.out_at, x.band from bio_attendance(v_today, v_today) x),
    m as (
      select s.email,
             case when a.in_time is not null and (b.in_at is null or a.in_time <= b.in_at) then a.band else b.band end as band,
             coalesce(a.in_time, b.in_at) as in_any, coalesce(a.out_time, b.out_at) as out_any
      from staff s left join a on a.email = s.email left join b on b.email = s.email),
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
      'finger', (select count(*) from b)
    ));
end $$;

-- ======================= 5. staff calendar with holidays and HR marks =======================
create or replace function public.my_month(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_email text;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date := date_trunc('month', coalesce(p_month, v_today))::date;
  v_to date := least((date_trunc('month', coalesce(p_month, v_today)) + interval '1 month - 1 day')::date, v_today + 60);
begin
  select email into v_email from profiles where id = v_uid and active;
  if v_email is null then raise exception 'not signed in'; end if;
  if v_from < (date_trunc('month', v_today) - interval '12 months')::date then raise exception 'too far back'; end if;
  return jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', m.day, 'in', m.in_time, 'out', m.out_time, 'band', m.band) order by m.day)
                      from person_days_merged(v_email, v_from, least(v_to, v_today)) m where m.in_time is not null), '[]'::jsonb),
    'od', coalesce((select jsonb_agg(jsonb_build_object('subject', o.subject, 'venue', o.venue_name, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'status', o.status) order by o.starts_at)
                    from od_requests o where o.user_id = v_uid and o.status in ('approved', 'pending')
                      and o.starts_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata') and o.ends_at >= (v_from::timestamp at time zone 'Asia/Kolkata')), '[]'::jsonb),
    'leave', coalesce((select jsonb_agg(x order by x->>'from') from (
                       select jsonb_build_object('type', l.leave_type, 'from', l.starts_on, 'to', l.ends_on, 'half_day', l.half_day, 'status', l.status) as x
                       from leave_requests l where l.user_id = v_uid and l.status in ('approved', 'pending') and l.starts_on <= v_to and l.ends_on >= v_from
                       union all
                       select jsonb_build_object('type', coalesce(dm.leave_type, 'other'), 'from', dm.day, 'to', dm.day, 'half_day', null, 'status', 'approved', 'by_hr', true)
                       from day_marks dm where dm.email = v_email and dm.mark = 'leave' and dm.day between v_from and v_to) s), '[]'::jsonb),
    'absent', coalesce((select jsonb_agg(dm.day order by dm.day) from day_marks dm where dm.email = v_email and dm.mark = 'absent' and dm.day between v_from and v_to), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('day', h.day, 'name', h.name, 'kind', h.kind) order by h.day) from holidays h where h.day between v_from and v_to), '[]'::jsonb));
end $$;
