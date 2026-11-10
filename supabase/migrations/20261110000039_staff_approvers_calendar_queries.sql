-- 1. HR chooses, per staff member, who approves their leave and who approves their OD: the reporting person,
--    HR or the Chairman. Empty = follow the Approvals setting (as before).
-- 2. One calendar for everyone: staff, HR and Chairman read the same month from person_month(), so leave,
--    absent marks, holidays, office leave and timings always match.
-- 3. A staff member can raise a query on a day HR marked as leave or absent. HR answers in the same timeline
--    (ask / correct / keep); the Chairman sees it too.

-- ======================= 1. approvers per staff member =======================
alter table staff_roster add column if not exists leave_approver text check (leave_approver in ('reporting', 'hr', 'chairman'));
alter table staff_roster add column if not exists od_approver text check (od_approver in ('reporting', 'hr', 'chairman'));

create or replace function public.set_staff_approver(p_email text, p_kind text, p_value text) returns void
language plpgsql security definer set search_path = public as $$
declare v text := nullif(trim(coalesce(p_value, '')), '');
begin
  if my_role() is distinct from 'hr' then raise exception 'only HR sets approvers'; end if;
  if p_kind not in ('leave', 'od') then raise exception 'kind must be leave or od'; end if;
  if v is not null and v not in ('reporting', 'hr', 'chairman') then raise exception 'choose reporting staff, HR or Chairman'; end if;
  if p_kind = 'leave' then update staff_roster set leave_approver = v where email = lower(trim(p_email));
  else update staff_roster set od_approver = v where email = lower(trim(p_email)); end if;
  if not found then raise exception 'not on the staff list'; end if;
end $$;
revoke execute on function set_staff_approver(text, text, text) from public, anon;
grant execute on function set_staff_approver(text, text, text) to authenticated;

-- who decides a request now, by email (works before the person signs in).
-- Order: the person's own setting, else the Approvals setting. Reporting staff need a signed-in account,
-- else leave -> HR and OD -> Chairman. The Chairman being Away hands his share to HR.
create or replace function public.request_route_email(p_kind text, p_email text)
returns table (route text, approver_id uuid, approver_name text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_set text; v_id uuid; v_name text; v_self uuid;
  v_away boolean := coalesce((setting('chairman_away'))::boolean, false);
begin
  if p_kind = 'mark' then return query select 'hr'::text, null::uuid, 'HR'::text; return; end if;   -- day-mark queries: HR
  select case when p_kind = 'leave' then r.leave_approver else r.od_approver end into v_set from staff_roster r where r.email = lower(p_email);
  v_set := coalesce(v_set, setting(case when p_kind = 'leave' then 'leave_approver' else 'od_approver' end) #>> '{}',
                    case when p_kind = 'leave' then 'hr' else 'chairman' end);
  if v_set = 'reporting' then
    select pr.id, pr.full_name into v_id, v_name
    from staff_roster r join profiles pr on pr.email = r.reports_to and pr.active
    where r.email = lower(p_email);
    select id into v_self from profiles where email = lower(p_email);
    if v_id is not null and v_id is distinct from v_self then return query select 'reporting'::text, v_id, v_name; return; end if;
    v_set := case when p_kind = 'leave' then 'hr' else 'chairman' end;
  end if;
  if v_set = 'chairman' and v_away then v_set := 'hr'; end if;
  return query select v_set, null::uuid, case when v_set = 'hr' then 'HR' else 'Chairman' end;
end $$;
revoke execute on function request_route_email(text, text) from public, anon, authenticated;

create or replace function public.request_route(p_kind text, p_user uuid)
returns table (route text, approver_id uuid, approver_name text)
language sql stable security definer set search_path = public as $$
  select * from request_route_email(p_kind, (select email from profiles where id = p_user))
$$;
revoke execute on function request_route(text, uuid) from public, anon, authenticated;

create or replace function public.routes_for(p_email text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare l record; o record; rr staff_roster;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  select * into l from request_route_email('leave', p_email);
  select * into o from request_route_email('od', p_email);
  select * into rr from staff_roster where email = lower(p_email);
  return jsonb_build_object('leave', jsonb_build_object('route', l.route, 'name', l.approver_name, 'set', rr.leave_approver),
                            'od', jsonb_build_object('route', o.route, 'name', o.approver_name, 'set', rr.od_approver),
                            'default_leave', coalesce(setting('leave_approver') #>> '{}', 'hr'),
                            'default_od', coalesce(setting('od_approver') #>> '{}', 'chairman'),
                            'reports_to', rr.reports_to,
                            'reports_to_name', (select coalesce(pp.full_name, r2.full_name) from staff_roster r2 left join profiles pp on pp.email = r2.email where r2.email = rr.reports_to),
                            'reports_to_signed_in', exists (select 1 from profiles p where p.email = rr.reports_to and p.active));
end $$;
revoke execute on function routes_for(text) from public, anon;
grant execute on function routes_for(text) to authenticated;

-- ======================= 3. queries on HR day marks =======================
create table if not exists mark_queries (
  id uuid primary key default gen_random_uuid(),
  email text not null references staff_roster (email) on update cascade on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  day date not null,
  mark text not null check (mark in ('absent', 'leave')),
  message text not null check (length(message) between 2 and 1000),
  status request_status not null default 'pending',          -- pending · approved = corrected · returned = kept
  clarify_at timestamptz,
  decided_by uuid references profiles (id),
  decided_at timestamptz,
  response text check (length(response) <= 1000),
  created_at timestamptz not null default now()
);
create unique index if not exists mark_queries_one_open on mark_queries (email, day) where status = 'pending';
alter table mark_queries enable row level security;
create policy mark_queries_read on mark_queries for select to authenticated using (sees_all() or user_id = auth.uid());
revoke insert, update, delete on mark_queries from anon, authenticated;     -- only through the functions below
create trigger audit_mark_queries after insert or update or delete on mark_queries for each row execute function audit_row();

alter table request_events drop constraint if exists request_events_kind_check;
alter table request_events add constraint request_events_kind_check check (kind in ('od', 'leave', 'mark'));

-- the timeline helpers learn the third kind
create or replace function public.request_owner(p_kind text, p_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case p_kind when 'od' then (select user_id from od_requests where id = p_id)
                     when 'leave' then (select user_id from leave_requests where id = p_id)
                     when 'mark' then (select user_id from mark_queries where id = p_id) end
$$;
revoke execute on function request_owner(text, uuid) from public, anon, authenticated;

create or replace function public.log_request_event(p_kind text, p_id uuid, p_action text, p_comment text, p_actor uuid default auth.uid())
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid := request_owner(p_kind, p_id); r record; v_role text;
begin
  select * into r from request_route(p_kind, v_user);
  v_role := case when p_actor is null then 'system'
                 when p_actor = v_user then 'staff'
                 when r.route = 'reporting' and r.approver_id = p_actor then 'reporting'
                 else coalesce((select role::text from profiles where id = p_actor), 'staff') end;
  insert into request_events (kind, request_id, actor, actor_role, action, comment, route, approver_name)
  values (p_kind, p_id, p_actor, v_role, p_action, nullif(left(trim(coalesce(p_comment, '')), 1000), ''), r.route, r.approver_name);
end $$;
revoke execute on function log_request_event(text, uuid, text, text, uuid) from public, anon, authenticated;

create or replace function public.request_event_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_kind text := case tg_table_name when 'od_requests' then 'od' when 'leave_requests' then 'leave' else 'mark' end; j jsonb := to_jsonb(new);
begin
  if tg_op = 'INSERT' then
    perform log_request_event(v_kind, new.id, case when coalesce((j ->> 'assigned_by_hr')::boolean, false) then 'assigned' else 'created' end,
                              coalesce(j ->> 'note', j ->> 'reason', j ->> 'message'), coalesce(auth.uid(), new.user_id));
  elsif new.status is distinct from old.status then
    perform log_request_event(v_kind, new.id, new.status::text,
      coalesce(nullif(current_setting('app.request_comment', true), ''), case when new.status = 'returned' then coalesce(j ->> 'return_reason', j ->> 'response') end), auth.uid());
  end if;
  return new;
end $$;
drop trigger if exists mark_events on mark_queries;
create trigger mark_events after insert or update of status on mark_queries for each row execute function request_event_trg();
drop trigger if exists mark_events_del on mark_queries;
create trigger mark_events_del after delete on mark_queries for each row execute function request_event_cleanup();

create or replace function public.can_decide(p_kind text, p_id uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare v_user uuid; v_status request_status; r record; v_role app_role := my_role();
begin
  if p_kind = 'leave' then select user_id, status into v_user, v_status from leave_requests where id = p_id;
  elsif p_kind = 'od' then select user_id, status into v_user, v_status from od_requests where id = p_id;
  elsif p_kind = 'mark' then select user_id, status into v_user, v_status from mark_queries where id = p_id;
  else return false; end if;
  if v_user is null or v_status <> 'pending' or v_user = auth.uid() then return false; end if;
  select * into r from request_route(p_kind, v_user);
  return (r.route = 'hr' and v_role = 'hr') or (r.route = 'chairman' and v_role = 'chairman') or (r.route = 'reporting' and r.approver_id = auth.uid());
end $$;
revoke execute on function can_decide(text, uuid) from public, anon;
grant execute on function can_decide(text, uuid) to authenticated;

-- staff: question a day HR marked (one open query per day)
create or replace function public.raise_mark_query(p_day date, p_message text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_email text; v_name text; v_mark text; v_id uuid; t text := trim(coalesce(p_message, ''));
begin
  select email, full_name into v_email, v_name from profiles where id = v_uid and active;
  if v_email is null then raise exception 'not signed in'; end if;
  if length(t) < 2 or length(t) > 1000 then raise exception 'message_length'; end if;
  select mark into v_mark from day_marks where email = v_email and day = p_day;
  if v_mark is null then raise exception 'no_mark'; end if;
  if exists (select 1 from mark_queries where email = v_email and day = p_day and status = 'pending') then raise exception 'already_raised'; end if;
  insert into mark_queries (email, user_id, day, mark, message) values (v_email, v_uid, p_day, v_mark, t) returning id into v_id;
  perform notify_role('hr', 'mark_query', 'Query from ' || v_name, initcap(v_mark) || ' on ' || to_char(p_day, 'DD Mon') || ' · ' || left(t, 120),
                      jsonb_build_object('kind', 'mark', 'request_id', v_id, 'mark_query_id', v_id));
  return v_id;
end $$;
revoke execute on function raise_mark_query(date, text) from public, anon;
grant execute on function raise_mark_query(date, text) to authenticated;

-- HR: correct (the mark is removed; HR can mark the day again) or keep (a reason is needed)
create or replace function public.decide_mark_query(p_id uuid, p_decision text, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare q mark_queries;
begin
  if p_decision not in ('approved', 'returned') then raise exception 'decision must be approved or returned'; end if;
  if p_decision = 'returned' and coalesce(trim(p_comment), '') = '' then raise exception 'a reason is needed to keep the mark'; end if;
  if not can_decide('mark', p_id) then raise exception 'not allowed'; end if;
  select * into q from mark_queries where id = p_id for update;
  perform set_config('app.request_comment', left(coalesce(trim(p_comment), ''), 1000), true);
  update mark_queries set status = p_decision::request_status, decided_by = auth.uid(), decided_at = now(), clarify_at = null,
    response = nullif(left(trim(coalesce(p_comment, '')), 1000), '') where id = p_id;
  perform set_config('app.request_comment', '', true);
  if p_decision = 'approved' then delete from day_marks where email = q.email and day = q.day; end if;   -- audited by trigger
  insert into notifications (user_id, kind, title, body, data) values
    (q.user_id, 'mark_' || p_decision, case when p_decision = 'approved' then 'Corrected: ' else 'Kept: ' end || initcap(q.mark) || ' on ' || to_char(q.day, 'DD Mon'),
     coalesce(nullif(trim(coalesce(p_comment, '')), ''), case when p_decision = 'approved' then 'HR removed the mark.' end),
     jsonb_build_object('kind', 'mark', 'request_id', p_id, 'mark_query_id', p_id));
end $$;
revoke execute on function decide_mark_query(uuid, text, text) from public, anon;
grant execute on function decide_mark_query(uuid, text, text) to authenticated;

-- ask / reply work for all three kinds
create or replace function public.ask_clarity(p_kind text, p_id uuid, p_question text) returns void
language plpgsql security definer set search_path = public as $$
declare q text := trim(coalesce(p_question, '')); v_user uuid; v_what text;
begin
  if p_kind not in ('od', 'leave', 'mark') then raise exception 'bad kind'; end if;
  if length(q) < 2 or length(q) > 500 then raise exception 'question_length'; end if;
  if not can_decide(p_kind, p_id) then raise exception 'not allowed'; end if;
  if p_kind = 'od' then update od_requests set clarify_at = now() where id = p_id returning user_id into v_user;
  elsif p_kind = 'leave' then update leave_requests set clarify_at = now() where id = p_id returning user_id into v_user;
  else update mark_queries set clarify_at = now() where id = p_id returning user_id into v_user; end if;
  perform log_request_event(p_kind, p_id, 'clarify', q);
  v_what := case p_kind when 'od' then 'OD' when 'leave' then 'leave' else 'query' end;
  insert into notifications (user_id, kind, title, body, data)
  values (v_user, 'clarify_asked', 'Question on your ' || v_what, q,
          jsonb_build_object('kind', p_kind, 'request_id', p_id, case p_kind when 'od' then 'od_id' when 'leave' then 'leave_id' else 'mark_query_id' end, p_id));
end $$;
revoke execute on function ask_clarity(text, uuid, text) from public, anon;
grant execute on function ask_clarity(text, uuid, text) to authenticated;

create or replace function public.reply_clarity(p_kind text, p_id uuid, p_reply text) returns void
language plpgsql security definer set search_path = public as $$
declare t text := trim(coalesce(p_reply, '')); v_user uuid; v_status request_status; v_ask timestamptz; r record; v_name text; v_data jsonb;
begin
  if p_kind not in ('od', 'leave', 'mark') then raise exception 'bad kind'; end if;
  if length(t) < 1 or length(t) > 1000 then raise exception 'reply_length'; end if;
  if p_kind = 'od' then select user_id, status, clarify_at into v_user, v_status, v_ask from od_requests where id = p_id for update;
  elsif p_kind = 'leave' then select user_id, status, clarify_at into v_user, v_status, v_ask from leave_requests where id = p_id for update;
  else select user_id, status, clarify_at into v_user, v_status, v_ask from mark_queries where id = p_id for update; end if;
  if v_user is null or v_user <> auth.uid() then raise exception 'not allowed'; end if;
  if v_status <> 'pending' or v_ask is null then raise exception 'nothing_to_reply'; end if;
  if p_kind = 'od' then update od_requests set clarify_at = null where id = p_id;
  elsif p_kind = 'leave' then update leave_requests set clarify_at = null where id = p_id;
  else update mark_queries set clarify_at = null where id = p_id; end if;
  perform log_request_event(p_kind, p_id, 'reply', t);
  select full_name into v_name from profiles where id = v_user;
  v_data := jsonb_build_object('kind', p_kind, 'request_id', p_id, case p_kind when 'od' then 'od_id' when 'leave' then 'leave_id' else 'mark_query_id' end, p_id);
  select * into r from request_route(p_kind, v_user);
  if r.route = 'reporting' then
    insert into notifications (user_id, kind, title, body, data) values (r.approver_id, 'clarify_reply', 'Reply from ' || v_name, left(t, 200), v_data);
  else perform notify_role(r.route::app_role, 'clarify_reply', 'Reply from ' || v_name, left(t, 200), v_data); end if;
end $$;
revoke execute on function reply_clarity(text, uuid, text) from public, anon;
grant execute on function reply_clarity(text, uuid, text) to authenticated;

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
  elsif p_kind = 'mark' then
    select q.user_id, q.decided_by, jsonb_build_object('title', 'Query · ' || initcap(q.mark) || ' marked by HR', 'note', q.message, 'from', q.day, 'to', q.day,
             'status', q.status, 'clarify', q.clarify_at is not null, 'created_at', q.created_at, 'decided_at', q.decided_at, 'mark', q.mark)
      into v_user, v_decided, v_req from mark_queries q where q.id = p_id;
  else raise exception 'bad kind'; end if;
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

-- ======================= 2. one calendar for everyone =======================
-- internal: one person's month exactly as everyone sees it (works before the person signs in)
create or replace function public.person_month(p_email text, p_month date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_email text := lower(trim(p_email)); v_uid uuid;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date := date_trunc('month', coalesce(p_month, v_today))::date;
  v_to date := (date_trunc('month', coalesce(p_month, v_today)) + interval '1 month - 1 day')::date;
begin
  if v_from < (date_trunc('month', v_today) - interval '12 months')::date then raise exception 'too far back'; end if;
  if v_from > (date_trunc('month', v_today) + interval '12 months')::date then raise exception 'too far ahead'; end if;
  select id into v_uid from profiles where email = v_email;
  return jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'),
    'today', v_today,
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', m.day, 'in', m.in_time, 'out', m.out_time, 'band', m.band) order by m.day)
                      from person_days_merged(v_email, v_from, least(v_to, v_today)) m where m.in_time is not null), '[]'::jsonb),
    'od', coalesce((select jsonb_agg(jsonb_build_object('subject', o.subject, 'venue', o.venue_name, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'status', o.status) order by o.starts_at)
                    from od_requests o where o.user_id = v_uid and o.status in ('approved', 'pending')
                      and o.starts_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata') and o.ends_at >= (v_from::timestamp at time zone 'Asia/Kolkata')), '[]'::jsonb),
    'leave', coalesce((select jsonb_agg(x order by x->>'from') from (
                       select jsonb_build_object('type', l.leave_type, 'from', l.starts_on, 'to', l.ends_on, 'half_day', l.half_day, 'status', l.status, 'by_hr', l.assigned_by_hr) as x
                       from leave_requests l where l.user_id = v_uid and l.status in ('approved', 'pending') and l.starts_on <= v_to and l.ends_on >= v_from
                       union all
                       select jsonb_build_object('type', coalesce(dm.leave_type, 'other'), 'from', dm.day, 'to', dm.day, 'half_day', null, 'status', 'approved', 'by_hr', true, 'mark', true)
                       from day_marks dm where dm.email = v_email and dm.mark = 'leave' and dm.day between v_from and v_to) s), '[]'::jsonb),
    'absent', coalesce((select jsonb_agg(dm.day order by dm.day) from day_marks dm where dm.email = v_email and dm.mark = 'absent' and dm.day between v_from and v_to), '[]'::jsonb),
    'holidays', coalesce((select jsonb_agg(jsonb_build_object('day', h.day, 'name', h.name, 'kind', h.kind) order by h.day) from holidays h where h.day between v_from and v_to), '[]'::jsonb),
    'queries', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'day', q.day, 'status', q.status, 'clarify', q.clarify_at is not null) order by q.created_at)
                         from mark_queries q where q.email = v_email and q.day between v_from and v_to), '[]'::jsonb));
end $$;
revoke execute on function person_month(text, date) from public, anon, authenticated;

create or replace function public.my_month(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_email text;
begin
  select email into v_email from profiles where id = auth.uid() and active;
  if v_email is null then raise exception 'not signed in'; end if;
  return person_month(v_email, p_month);
end $$;
revoke execute on function my_month(date) from public, anon;
grant execute on function my_month(date) to authenticated;

create or replace function public.hr_person_month(p_email text, p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return person_month(p_email, p_month);
end $$;
revoke execute on function hr_person_month(text, date) from public, anon;
grant execute on function hr_person_month(text, date) to authenticated;
