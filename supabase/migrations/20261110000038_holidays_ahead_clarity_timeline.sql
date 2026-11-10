-- 1. Holidays and office leave fill every staff calendar, including months ahead; today's holiday shows on the
--    staff home. Check-in (selfie and fingerprint) stays open on those days.
-- 2. Approvals: the approver (reporting person, HR or Chairman) can approve, return or ask for clarity.
--    The staff member replies; every step (created, question, reply, decision, with comments) is kept in
--    request_events. HR and Chairman see the whole timeline; the requester and the approver see their own.

-- ======================= approvals: clarity and timeline =======================
alter table od_requests add column if not exists clarify_at timestamptz;      -- set while a question waits for the staff member
alter table leave_requests add column if not exists clarify_at timestamptz;

create table if not exists request_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('od', 'leave')),
  request_id uuid not null,
  actor uuid references profiles (id) on delete set null,
  actor_role text,                          -- staff, reporting, hr, chairman, tech, system
  action text not null check (action in ('created', 'assigned', 'clarify', 'reply', 'approved', 'returned', 'cancelled', 'pending')),
  comment text check (length(comment) <= 1000),
  route text,                               -- who the request was with at that moment
  approver_name text,
  at timestamptz not null default now()
);
create index if not exists request_events_req on request_events (kind, request_id, at);
alter table request_events enable row level security;
create policy request_events_read on request_events for select to authenticated using (sees_all());   -- others read through request_timeline()
revoke insert, update, delete on request_events from anon, authenticated;

-- internal: one step of a request's timeline
create or replace function public.log_request_event(p_kind text, p_id uuid, p_action text, p_comment text, p_actor uuid default auth.uid())
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid; r record; v_role text;
begin
  if p_kind = 'od' then select user_id into v_user from od_requests where id = p_id; else select user_id into v_user from leave_requests where id = p_id; end if;
  select * into r from request_route(p_kind, v_user);
  v_role := case when p_actor is null then 'system'
                 when p_actor = v_user then 'staff'
                 when r.route = 'reporting' and r.approver_id = p_actor then 'reporting'
                 else coalesce((select role::text from profiles where id = p_actor), 'staff') end;
  insert into request_events (kind, request_id, actor, actor_role, action, comment, route, approver_name)
  values (p_kind, p_id, p_actor, v_role, p_action, nullif(left(trim(coalesce(p_comment, '')), 1000), ''), r.route, r.approver_name);
end $$;
revoke execute on function log_request_event(text, uuid, text, text, uuid) from public, anon, authenticated;

-- created / status changes are logged by trigger, so every path (staff, HR, Chairman, reporting, purge) is covered
create or replace function public.request_event_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kind text := case when tg_table_name = 'od_requests' then 'od' else 'leave' end; j jsonb := to_jsonb(new);
begin
  if tg_op = 'INSERT' then
    perform log_request_event(v_kind, new.id, case when coalesce((j ->> 'assigned_by_hr')::boolean, false) then 'assigned' else 'created' end,
                              coalesce(j ->> 'note', j ->> 'reason'), coalesce(auth.uid(), new.user_id));
  elsif new.status is distinct from old.status then
    perform log_request_event(v_kind, new.id, new.status::text,
      coalesce(nullif(current_setting('app.request_comment', true), ''), case when new.status = 'returned' then j ->> 'return_reason' end), auth.uid());
  end if;
  return new;
end $$;
revoke execute on function request_event_trg() from public, anon, authenticated;
drop trigger if exists od_events on od_requests;
create trigger od_events after insert or update of status on od_requests for each row execute function request_event_trg();
drop trigger if exists leave_events on leave_requests;
create trigger leave_events after insert or update of status on leave_requests for each row execute function request_event_trg();

-- a deleted request takes its timeline with it (staff deletion, test data purge)
create or replace function public.request_event_cleanup() returns trigger
language plpgsql security definer set search_path = public as $$
begin delete from request_events where request_id = old.id; return old; end $$;
revoke execute on function request_event_cleanup() from public, anon, authenticated;
drop trigger if exists od_events_del on od_requests;
create trigger od_events_del after delete on od_requests for each row execute function request_event_cleanup();
drop trigger if exists leave_events_del on leave_requests;
create trigger leave_events_del after delete on leave_requests for each row execute function request_event_cleanup();

-- timeline for requests made before today
insert into request_events (kind, request_id, actor, actor_role, action, comment, at)
select 'od', o.id, o.user_id, 'staff', 'created', o.note, o.created_at from od_requests o
where not exists (select 1 from request_events e where e.request_id = o.id);
insert into request_events (kind, request_id, actor, actor_role, action, comment, at)
select 'leave', l.id, l.user_id, case when l.assigned_by_hr then 'hr' else 'staff' end, case when l.assigned_by_hr then 'assigned' else 'created' end, l.reason, l.created_at from leave_requests l
where not exists (select 1 from request_events e where e.request_id = l.id);
insert into request_events (kind, request_id, actor, actor_role, action, comment, route, at)
select 'od', o.id, o.decided_by, coalesce(case when o.decided_route = 'reporting' then 'reporting' end, o.decided_role::text), o.status::text, o.return_reason, o.decided_route, o.decided_at
from od_requests o where o.status in ('approved', 'returned', 'cancelled') and o.decided_at is not null
  and not exists (select 1 from request_events e where e.request_id = o.id and e.action = o.status::text);
insert into request_events (kind, request_id, actor, actor_role, action, comment, route, at)
select 'leave', l.id, l.decided_by, coalesce(case when l.decided_route = 'reporting' then 'reporting' end, (select role::text from profiles where id = l.decided_by)), l.status::text, l.return_reason, l.decided_route, l.decided_at
from leave_requests l where l.status in ('approved', 'returned', 'cancelled') and l.decided_at is not null and not l.assigned_by_hr
  and not exists (select 1 from request_events e where e.request_id = l.id and e.action = l.status::text);

-- decide: a comment is allowed on approve too; a waiting question is closed by the decision
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
  perform set_config('app.request_comment', left(coalesce(trim(p_reason), ''), 300), true);
  update od_requests set status = p_decision::request_status, decided_by = auth.uid(), decided_role = my_role(), decided_route = v_route,
    decided_at = now(), clarify_at = null, return_reason = case when p_decision = 'returned' then left(p_reason, 300) end where id = p_id;
  perform set_config('app.request_comment', '', true);
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
  perform set_config('app.request_comment', left(coalesce(trim(p_reason), ''), 300), true);
  update leave_requests set status = p_decision::request_status, decided_by = auth.uid(), decided_at = now(), decided_route = v_route,
    clarify_at = null, return_reason = case when p_decision = 'returned' then left(p_reason, 300) end where id = p_id;
  perform set_config('app.request_comment', '', true);
  insert into notifications (user_id, kind, title, body, data) values
    (r.user_id, 'leave_' || p_decision, case when p_decision = 'approved' then 'Leave approved' else 'Leave returned' end,
     initcap(r.leave_type) || ' · ' || to_char(r.starts_on, 'DD Mon') || case when p_decision = 'returned' then ' · ' || p_reason else '' end,
     jsonb_build_object('leave_id', p_id));
end $$;

-- the approver asks the staff member a question; the request stays with the approver
create or replace function public.ask_clarity(p_kind text, p_id uuid, p_question text) returns void
language plpgsql security definer set search_path = public as $$
declare q text := trim(coalesce(p_question, '')); v_user uuid; v_title text;
begin
  if p_kind not in ('od', 'leave') then raise exception 'kind must be od or leave'; end if;
  if length(q) < 2 or length(q) > 500 then raise exception 'question_length'; end if;
  if not can_decide(p_kind, p_id) then raise exception 'not allowed'; end if;
  if p_kind = 'od' then update od_requests set clarify_at = now() where id = p_id returning user_id, subject into v_user, v_title;
  else update leave_requests set clarify_at = now() where id = p_id returning user_id, initcap(leave_type) || ' leave' into v_user, v_title; end if;
  perform log_request_event(p_kind, p_id, 'clarify', q);
  insert into notifications (user_id, kind, title, body, data)
  values (v_user, 'clarify_asked', 'Question on your ' || case when p_kind = 'od' then 'OD' else 'leave' end, q,
          jsonb_build_object('kind', p_kind, 'request_id', p_id, case when p_kind = 'od' then 'od_id' else 'leave_id' end, p_id));
end $$;
revoke execute on function ask_clarity(text, uuid, text) from public, anon;
grant execute on function ask_clarity(text, uuid, text) to authenticated;

-- the staff member answers; it goes back to whoever decides it now
create or replace function public.reply_clarity(p_kind text, p_id uuid, p_reply text) returns void
language plpgsql security definer set search_path = public as $$
declare t text := trim(coalesce(p_reply, '')); v_user uuid; v_status request_status; v_ask timestamptz; r record; v_name text; v_data jsonb;
begin
  if p_kind not in ('od', 'leave') then raise exception 'kind must be od or leave'; end if;
  if length(t) < 1 or length(t) > 1000 then raise exception 'reply_length'; end if;
  if p_kind = 'od' then select user_id, status, clarify_at into v_user, v_status, v_ask from od_requests where id = p_id for update;
  else select user_id, status, clarify_at into v_user, v_status, v_ask from leave_requests where id = p_id for update; end if;
  if v_user is null or v_user <> auth.uid() then raise exception 'not allowed'; end if;
  if v_status <> 'pending' or v_ask is null then raise exception 'nothing_to_reply'; end if;
  if p_kind = 'od' then update od_requests set clarify_at = null where id = p_id; else update leave_requests set clarify_at = null where id = p_id; end if;
  perform log_request_event(p_kind, p_id, 'reply', t);
  select full_name into v_name from profiles where id = v_user;
  v_data := jsonb_build_object('kind', p_kind, 'request_id', p_id, case when p_kind = 'od' then 'od_id' else 'leave_id' end, p_id);
  select * into r from request_route(p_kind, v_user);
  if r.route = 'reporting' then
    insert into notifications (user_id, kind, title, body, data) values (r.approver_id, 'clarify_reply', 'Reply from ' || v_name, left(t, 200), v_data);
  else perform notify_role(r.route::app_role, 'clarify_reply', 'Reply from ' || v_name, left(t, 200), v_data); end if;
end $$;
revoke execute on function reply_clarity(text, uuid, text) from public, anon;
grant execute on function reply_clarity(text, uuid, text) to authenticated;

-- one request with its whole timeline. HR, Chairman and Tech see every request; the staff member sees their own;
-- an approver sees what is (or was) with them. Nothing about attendance checks is in here.
create or replace function public.request_timeline(p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_user uuid; v_decided uuid; r record; v_req jsonb;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  if p_kind = 'od' then
    select o.user_id, o.decided_by, jsonb_build_object('title', o.subject, 'note', o.note, 'venue', o.venue_name, 'venue_url', o.venue_url,
             'starts_at', o.starts_at, 'ends_at', o.ends_at, 'status', o.status, 'clarify', o.clarify_at is not null, 'created_at', o.created_at, 'decided_at', o.decided_at)
      into v_user, v_decided, v_req from od_requests o where o.id = p_id;
  elsif p_kind = 'leave' then
    select l.user_id, l.decided_by, jsonb_build_object('title', initcap(l.leave_type) || ' leave', 'note', l.reason, 'from', l.starts_on, 'to', l.ends_on,
             'half_day', l.half_day, 'status', l.status, 'clarify', l.clarify_at is not null, 'created_at', l.created_at, 'decided_at', l.decided_at,
             'assigned_by_hr', l.assigned_by_hr)
      into v_user, v_decided, v_req from leave_requests l where l.id = p_id;
  else raise exception 'kind must be od or leave'; end if;
  if v_user is null then raise exception 'not found'; end if;
  select * into r from request_route(p_kind, v_user);
  if not (sees_all() or v_user = v_uid or v_decided = v_uid or (r.route = 'reporting' and r.approver_id = v_uid)
          or exists (select 1 from request_events e where e.request_id = p_id and e.actor = v_uid)) then
    raise exception 'not allowed';
  end if;
  return v_req || jsonb_build_object(
    'kind', p_kind, 'id', p_id,
    'who', (select full_name from profiles where id = v_user),
    'hub', (select h.name from profiles p join hubs h on h.id = p.hub_id where p.id = v_user),
    'with', case when v_req ->> 'status' = 'pending' then r.approver_name end,
    'route', case when v_req ->> 'status' = 'pending' then r.route end,
    'can_decide', can_decide(p_kind, p_id),
    'mine', v_user = v_uid,
    'events', coalesce((select jsonb_agg(jsonb_build_object('action', e.action, 'who', coalesce(p.full_name, case e.actor_role when 'system' then 'System' else 'Removed user' end),
                          'role', e.actor_role, 'comment', e.comment, 'at', e.at, 'with', e.approver_name) order by e.at, e.id)
                        from request_events e left join profiles p on p.id = e.actor
                        where e.kind = p_kind and e.request_id = p_id), '[]'::jsonb));
end $$;
revoke execute on function request_timeline(text, uuid) from public, anon;
grant execute on function request_timeline(text, uuid) to authenticated;

-- HR profile: where this person's leave and OD go now (follows the approver settings and the reporting person)
create or replace function public.routes_for(p_email text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid; l record; o record;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  select id into v_uid from profiles where email = lower(p_email);
  select * into l from request_route('leave', v_uid);
  select * into o from request_route('od', v_uid);
  return jsonb_build_object('leave', jsonb_build_object('route', l.route, 'name', l.approver_name),
                            'od', jsonb_build_object('route', o.route, 'name', o.approver_name),
                            'reports_to', (select r.reports_to from staff_roster r where r.email = lower(p_email)),
                            'reports_to_name', (select coalesce(pp.full_name, rr.full_name) from staff_roster r join staff_roster rr on rr.email = r.reports_to
                                                left join profiles pp on pp.email = rr.email where r.email = lower(p_email)),
                            'reports_to_signed_in', exists (select 1 from staff_roster r join profiles p on p.email = r.reports_to and p.active where r.email = lower(p_email)));
end $$;
revoke execute on function routes_for(text) from public, anon;
grant execute on function routes_for(text) to authenticated;

-- ======================= staff home, calendar and approvals =======================
create or replace function public.my_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from timestamptz := (v_today::timestamp at time zone 'Asia/Kolkata');
  v_to timestamptz := ((v_today + 1)::timestamp at time zone 'Asia/Kolkata');
  v_email text;
  v_out jsonb;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select email into v_email from profiles where id = v_uid;
  select jsonb_build_object(
    'profile', (select jsonb_build_object('full_name', p.full_name, 'employee_code', p.employee_code, 'role', p.role,
                 'hub', h.name, 'face_status', p.face_status, 'consented', p.consent_at is not null,
                 'reports_to', (select coalesce(rp.full_name, rr.full_name) from staff_roster r join staff_roster rr on rr.email = r.reports_to
                                left join profiles rp on rp.email = rr.email where r.email = p.email))
                from profiles p left join hubs h on h.id = p.hub_id where p.id = v_uid),
    'holiday', (select jsonb_build_object('name', hd.name, 'kind', hd.kind) from holidays hd where hd.day = v_today),
    'today', (select jsonb_build_object('in_time', d.in_time, 'out_time', d.out_time, 'band', d.band, 'early_out', d.early_out, 'status', d.status)
              from attendance_days d where d.user_id = v_uid and d.day = v_today),
    -- the day as it counts (selfie and fingerprint merged by the hub's method); shown on the home card
    'day', (select jsonb_build_object('in_time', m.in_time, 'out_time', m.out_time, 'band', m.band, 'early_out', m.early_out, 'in_src', m.in_src, 'out_src', m.out_src)
            from attendance_merged(v_today, v_today, v_email) m),
    'checkin', checkin_method_of(v_email),
    'help', setting('help_contact'),
    'month', (select jsonb_build_object(
                'on_time', count(*) filter (where m.band = 'ok' or m.status = 'od'),
                'late', count(*) filter (where m.band in ('warn', 'bad') and m.status <> 'od'),
                'early', count(*) filter (where m.early_out))
              from attendance_merged(date_trunc('month', v_today)::date, v_today, v_email) m
              where m.in_time is not null or m.status in ('od', 'leave')),
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
        select 'od' as type, id, subject as title, starts_at::text as starts, status, created_at, clarify_at is not null as clarify from od_requests
          where user_id = v_uid and (created_at > now() - interval '30 days' or clarify_at is not null or status = 'pending')
        union all
        select 'leave', id, initcap(leave_type) || ' leave', starts_on::text, status, created_at, clarify_at is not null from leave_requests
          where user_id = v_uid and (created_at > now() - interval '30 days' or clarify_at is not null or status = 'pending')
        order by clarify desc, created_at desc limit 6) r), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
revoke execute on function my_today() from public, anon;
grant execute on function my_today() to authenticated;

create or replace function public.my_month(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_email text;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date := date_trunc('month', coalesce(p_month, v_today))::date;
  v_to date := (date_trunc('month', coalesce(p_month, v_today)) + interval '1 month - 1 day')::date;   -- future months: holidays and office leave ahead
begin
  select email into v_email from profiles where id = v_uid and active;
  if v_email is null then raise exception 'not signed in'; end if;
  if v_from < (date_trunc('month', v_today) - interval '12 months')::date then raise exception 'too far back'; end if;
  if v_from > (date_trunc('month', v_today) + interval '12 months')::date then raise exception 'too far ahead'; end if;
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

create or replace function public.my_approvals() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  return jsonb_build_object(
    'od', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'who', p.full_name, 'subject', o.subject, 'note', o.note, 'venue', o.venue_name,
              'venue_url', o.venue_url, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'created_at', o.created_at, 'clarify', o.clarify_at is not null) order by o.starts_at)
            from od_requests o join profiles p on p.id = o.user_id cross join lateral request_route('od', o.user_id) rr
            where o.status = 'pending' and rr.route = 'reporting' and rr.approver_id = v_uid), '[]'::jsonb),
    'leave', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'who', p.full_name, 'type', l.leave_type, 'from', l.starts_on, 'to', l.ends_on,
              'half_day', l.half_day, 'reason', l.reason, 'created_at', l.created_at, 'clarify', l.clarify_at is not null) order by l.starts_on)
            from leave_requests l join profiles p on p.id = l.user_id cross join lateral request_route('leave', l.user_id) rr
            where l.status = 'pending' and rr.route = 'reporting' and rr.approver_id = v_uid), '[]'::jsonb),
    'leave_approver', setting('leave_approver') #>> '{}', 'od_approver', setting('od_approver') #>> '{}');
end $$;
revoke execute on function my_month(date) from public, anon;
grant execute on function my_month(date) to authenticated;
revoke execute on function my_approvals() from public, anon;
grant execute on function my_approvals() to authenticated;
