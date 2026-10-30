-- Run against a local copy: checks the security promises in the PRD. Each block raises on failure.
\set ON_ERROR_STOP 1
insert into staff_roster (email, full_name, role, hub_name) values
 ('kavya@startuptn.in','Kavya R','staff','Chennai'),('arun@startuptn.in','Arun K','staff','Chennai') on conflict do nothing;
insert into auth.users values
 ('00000000-0000-0000-0000-000000000001','kavya@startuptn.in'),('00000000-0000-0000-0000-000000000002','arun@startuptn.in'),
 ('00000000-0000-0000-0000-0000000000a1','hr@startuptn.in'),('00000000-0000-0000-0000-0000000000c1','chairmanoffice@startuptn.in'),
 ('00000000-0000-0000-0000-0000000000f1','ai@startuptn.in');
insert into profiles (id,email,full_name,role,hub_id) values
 ('00000000-0000-0000-0000-000000000001','kavya@startuptn.in','Kavya R','staff',(select id from hubs where name='Chennai')),
 ('00000000-0000-0000-0000-000000000002','arun@startuptn.in','Arun K','staff',(select id from hubs where name='Chennai')),
 ('00000000-0000-0000-0000-0000000000a1','hr@startuptn.in','HR team','hr',null),
 ('00000000-0000-0000-0000-0000000000c1','chairmanoffice@startuptn.in','Chairman','chairman',null),
 ('00000000-0000-0000-0000-0000000000f1','ai@startuptn.in','Tech admin','tech',null)
on conflict (id) do nothing;
-- a punch for Kavya written by the server (service role bypasses RLS)
insert into punches (user_id,kind,idempotency_key,client_time,lat,lng,accuracy_m,target_type,distance_m,inside,band,place_name)
values ('00000000-0000-0000-0000-000000000001','in','k1',now(),13.08,80.27,12,'hub',40,true,'ok','Guindy, Chennai');

create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', u, false); perform set_config('role','authenticated',false); end $$;
create or replace function pg_temp.reset() returns void language plpgsql as $$
begin perform set_config('role','postgres',false); perform set_config('request.jwt.claim.sub','',false); end $$;

-- 1. staff cannot see hubs (radius), punches (distance) or flags; can see own profile and hub names
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from hubs) <> 0 then raise exception 'FAIL staff sees hubs'; end if;
  if (select count(*) from punches) <> 0 then raise exception 'FAIL staff sees punches'; end if;
  if (select count(*) from profiles) <> 1 then raise exception 'FAIL staff sees other profiles'; end if;
  if (select count(*) from hub_directory) <> 10 then raise exception 'FAIL hub_directory'; end if;
  if (select count(*) from my_punches) <> 1 then raise exception 'FAIL my_punches own'; end if;
  if (select (my_today()->'profile'->>'hub')) <> 'Chennai' then raise exception 'FAIL my_today'; end if;
  raise notice 'PASS 1 staff visibility';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin if (select count(*) from my_punches) <> 0 then raise exception 'FAIL my_punches leaks'; end if; raise notice 'PASS 1b my_punches scoped'; end $$;

-- 2. staff raises OD -> Chairman notified
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
insert into od_requests (user_id,subject,venue_name,starts_at,ends_at) values ('00000000-0000-0000-0000-000000000001','TIDCO policy meet','Guindy',now()+interval '1 day',now()+interval '1 day 2 hours');
do $$ begin
  begin insert into od_requests (user_id,subject,venue_name,starts_at,ends_at,status) values ('00000000-0000-0000-0000-000000000001','x2','v',now(),now()+interval '1 h','approved');
    raise exception 'FAIL staff self-approved'; exception when insufficient_privilege then null; end;
  begin perform decide_od((select id from od_requests limit 1),'approved'); raise exception 'FAIL staff decided OD';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 2 staff cannot approve';
end $$;
select pg_temp.reset();
do $$ begin if (select count(*) from notifications where user_id='00000000-0000-0000-0000-0000000000c1' and kind='od_new')<>1 then raise exception 'FAIL chairman not notified'; end if; raise notice 'PASS 2b chairman notified'; end $$;

-- 3. HR cannot decide while Chairman is In; can while Away
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin begin perform decide_od((select id from od_requests limit 1),'approved'); raise exception 'FAIL hr decided while chairman in';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end; raise notice 'PASS 3 HR blocked while In'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select set_chairman_away(true);
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
insert into od_requests (user_id,subject,venue_name,starts_at,ends_at) values ('00000000-0000-0000-0000-000000000001','Expo','Codissia',now()+interval '3 hours',now()+interval '6 hours');
select pg_temp.reset();
do $$ begin if (select count(*) from notifications where user_id='00000000-0000-0000-0000-0000000000a1' and kind='od_new')<>1 then raise exception 'FAIL HR not notified while away'; end if; raise notice 'PASS 3b routed to HR while Away'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select decide_od((select id from od_requests where subject='Expo'),'approved');
-- 4. Chairman approves the first OD -> staff and Chairman notified
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
select set_chairman_away(false);
select decide_od((select id from od_requests where subject='TIDCO policy meet'),'approved');
select pg_temp.reset();
do $$ begin
  if (select count(*) from notifications where user_id='00000000-0000-0000-0000-000000000001' and kind='od_approved')<>2 then raise exception 'FAIL staff approval notifs'; end if;
  if (select count(*) from notifications where user_id='00000000-0000-0000-0000-0000000000c1' and kind='od_approved')<>1 then raise exception 'FAIL chairman approved list notif'; end if;
  if (select decided_role from od_requests where subject='Expo')<>'hr' then raise exception 'FAIL decided_role'; end if;
  raise notice 'PASS 4 decisions notify both sides';
end $$;

-- 5. only Tech changes roles
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin begin update profiles set role='hr' where id='00000000-0000-0000-0000-000000000002'; raise exception 'FAIL hr changed a role';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end; raise notice 'PASS 5 HR cannot change roles'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ declare n int; begin update profiles set role='tech' where id='00000000-0000-0000-0000-000000000001'; get diagnostics n = row_count;
  if n<>0 then raise exception 'FAIL staff promoted self'; end if; raise notice 'PASS 5b staff cannot change own role'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
update profiles set role='intern' where id='00000000-0000-0000-0000-000000000002';

-- 6. audit is chained and append only; only Tech reads it
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin if (select count(*) from audit_log)<>0 then raise exception 'FAIL chairman reads audit'; end if; raise notice 'PASS 6 audit hidden from chairman'; end $$;
select pg_temp.reset();
do $$ declare bad int; begin
  select count(*) into bad from (select hash, lag(hash) over (order by id) prev, prev_hash from audit_log) x where x.prev is distinct from x.prev_hash;
  if bad<>0 then raise exception 'FAIL audit chain broken'; end if;
  begin delete from audit_log; raise exception 'FAIL audit deletable'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 6b audit chained (% rows) and append only', (select count(*) from audit_log);
end $$;

-- 7. staff cannot call internal functions
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin begin perform notify_role('staff','x','spam','spam','{}'); raise exception 'FAIL staff called notify_role';
  exception when insufficient_privilege then null; end; raise notice 'PASS 7 internal functions locked'; end $$;

-- 8. roster: only listed emails can sign in; first sign-in creates the profile with the roster role
select pg_temp.reset();
do $$ begin
  begin insert into auth.users values ('00000000-0000-0000-0000-0000000000e1','stranger@gmail.com'); raise exception 'FAIL stranger signed up';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  insert into auth.users values ('00000000-0000-0000-0000-0000000000e2','Naveen@StartupTN.in');
  if (select role from profiles where id='00000000-0000-0000-0000-0000000000e2') <> 'staff'
     or (select h.name from profiles p join hubs h on h.id=p.hub_id where p.id='00000000-0000-0000-0000-0000000000e2') <> 'Chennai' then
    raise exception 'FAIL roster profile'; end if;
  raise notice 'PASS 8 roster gates sign-in and builds the profile';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin insert into staff_roster (email, full_name, role) values ('boss@startuptn.in','X','chairman'); raise exception 'FAIL hr added a role account';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  insert into staff_roster (email, full_name, role, hub_name) values ('new@startuptn.in','New Staff','staff','Erode');
  raise notice 'PASS 8b HR adds staff, not role accounts';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin if (select count(*) from staff_roster)<>0 then raise exception 'FAIL staff reads roster'; end if; raise notice 'PASS 8c roster hidden from staff'; end $$;

-- 9. HR summary: HR can read it, staff cannot
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin if (hr_today()->>'staff')::int < 1 then raise exception 'FAIL hr_today empty'; end if; raise notice 'PASS 9 HR summary works'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin begin perform hr_today(); raise exception 'FAIL staff read hr_today';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end; raise notice 'PASS 9b staff blocked from HR summary'; end $$;

-- 10. designation flows from roster to profile on first sign-in
select pg_temp.reset();
insert into staff_roster (email, full_name, role, hub_name, designation) values ('desig@startuptn.in','Desig Test','staff','Salem','Project Lead');
insert into auth.users values ('00000000-0000-0000-0000-0000000000d1','desig@startuptn.in');
do $$ begin if (select designation from profiles where email='desig@startuptn.in') <> 'Project Lead' then raise exception 'FAIL designation not copied'; end if;
  update staff_roster set designation='Hub Lead' where email='desig@startuptn.in';
  if (select designation from profiles where email='desig@startuptn.in') <> 'Hub Lead' then raise exception 'FAIL designation not synced'; end if;
  raise notice 'PASS 10 designation copied and kept in sync'; end $$;
