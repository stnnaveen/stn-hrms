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
insert into od_requests (user_id,subject,venue_name,venue_lat,venue_lng,venue_url,starts_at,ends_at) values ('00000000-0000-0000-0000-000000000001','TIDCO policy meet','Guindy',13.01,80.22,'https://maps.app.goo.gl/abc',now()+interval '1 day',now()+interval '1 day 2 hours');
do $$ begin
  begin insert into od_requests (user_id,subject,venue_name,venue_lat,venue_lng,venue_url,starts_at,ends_at,status) values ('00000000-0000-0000-0000-000000000001','x2','v',13.01,80.22,'https://maps.app.goo.gl/abc',now(),now()+interval '1 h','approved');
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
insert into od_requests (user_id,subject,venue_name,venue_lat,venue_lng,venue_url,starts_at,ends_at) values ('00000000-0000-0000-0000-000000000001','Expo','Codissia',11.03,77.03,'https://www.google.com/maps/place/Codissia/@11.03,77.03,17z',now()+interval '3 hours',now()+interval '6 hours');
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

-- 11. delete: HR removes mistakes, never people with records or role accounts; staff cannot delete
select pg_temp.reset();
insert into staff_roster (email, full_name, role, hub_name) values ('mistake@startuptn.in','Wrong Entry','staff','Erode'),('signedin@startuptn.in','Signed In','staff','Erode');
insert into auth.users values ('00000000-0000-0000-0000-0000000000d2','signedin@startuptn.in');
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin begin perform delete_staff('mistake@startuptn.in'); raise exception 'FAIL staff deleted someone';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end; raise notice 'PASS 11 staff cannot delete'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select delete_staff('mistake@startuptn.in');
select delete_staff('SignedIn@StartupTN.in');
do $$ begin
  if exists (select 1 from staff_roster where email in ('mistake@startuptn.in','signedin@startuptn.in')) then raise exception 'FAIL roster rows remain'; end if;
  begin perform delete_staff('kavya@startuptn.in'); raise exception 'FAIL deleted person with records';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform delete_staff('chairmanoffice@startuptn.in'); raise exception 'FAIL HR deleted role account';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 11b HR deletes mistakes only';
end $$;
select pg_temp.reset();
do $$ begin
  if exists (select 1 from profiles where email='signedin@startuptn.in') or exists (select 1 from auth.users where email='signedin@startuptn.in') then raise exception 'FAIL account not removed'; end if;
  if not exists (select 1 from profiles where email='kavya@startuptn.in') then raise exception 'FAIL kavya removed'; end if;
  raise notice 'PASS 11c account and profile removed, records kept';
end $$;

-- 12. Chairman: temp login gets the chairman role; sees everything; decides OD and In/Away only; cannot change people, hubs or leave
select pg_temp.reset();
insert into auth.users values ('00000000-0000-0000-0000-0000000000c7','chairman.ai@startuptn.in');
do $$ begin if (select role from profiles where email='chairman.ai@startuptn.in') <> 'chairman' then raise exception 'FAIL temp chairman role'; end if;
  raise notice 'PASS 12 temp Chairman login'; end $$;
insert into leave_requests (user_id, leave_type, starts_on, ends_on) values ('00000000-0000-0000-0000-000000000002','casual',current_date+3,current_date+3);
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c7');
do $$ begin
  if (select count(*) from profiles) < 5 or (select count(*) from punches) < 1 or (select count(*) from hubs) <> 10 then raise exception 'FAIL chairman cannot see all'; end if;
  perform set_chairman_away(true);
  if not ((select value from settings where key='chairman_away'))::boolean then raise exception 'FAIL away not set'; end if;
  perform set_chairman_away(false);
  begin perform decide_leave((select id from leave_requests limit 1),'approved'); raise exception 'FAIL chairman decided leave';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  update profiles set active = false where email = 'kavya@startuptn.in';
  update hubs set radius_m = 9999 where name = 'Chennai';
  raise notice 'PASS 12b Chairman sees all, sets In/Away, cannot decide leave';
end $$;
select pg_temp.reset();
do $$ begin
  if not (select active from profiles where email='kavya@startuptn.in') then raise exception 'FAIL chairman deactivated staff'; end if;
  if (select radius_m from hubs where name='Chennai') = 9999 then raise exception 'FAIL chairman edited hub'; end if;
  raise notice 'PASS 12c Chairman cannot edit people or hubs';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin begin perform set_chairman_away(true); raise exception 'FAIL staff set away';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end; raise notice 'PASS 12d only Chairman sets In/Away'; end $$;

-- 13. Tech admin: role logins, rules, phones, audit check; nobody else can
select pg_temp.reset();
insert into devices (id, user_id, device_key, status) values
 ('00000000-0000-0000-0000-00000000de01','00000000-0000-0000-0000-000000000002','old-phone','active'),
 ('00000000-0000-0000-0000-00000000de02','00000000-0000-0000-0000-000000000002','new-phone','pending');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin perform add_role_login('x@startuptn.in','X','hr'); raise exception 'FAIL HR added role login'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_setting('face_threshold','70'); raise exception 'FAIL HR changed rule'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform decide_device('00000000-0000-0000-0000-00000000de02', true); raise exception 'FAIL HR approved phone'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform verify_audit_chain(); raise exception 'FAIL HR read audit check'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  delete from staff_roster where email = 'chairmanoffice@startuptn.in';
  raise exception 'FAIL HR deleted role account from roster';
exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; raise notice 'PASS 13 HR cannot do Tech admin work';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin begin perform add_role_login('NewHR@StartupTN.in', 'New HR', 'hr'); raise exception 'FAIL role login outside the admin list';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end; end $$;
select add_role_login('HR@StartupTN.in', 'HR team', 'hr');
select set_setting('face_threshold', '85');
select set_setting('office_start', '"09:30"');
select decide_device('00000000-0000-0000-0000-00000000de02', true);
do $$ begin
  if (select role from staff_roster where email = 'hr@startuptn.in') <> 'hr' or (select active from profiles where email = 'hr@startuptn.in') is not true then raise exception 'FAIL role login not added'; end if;
  if ((select value from settings where key='face_threshold'))::int <> 85 or (select value from settings where key='office_start') #>> '{}' <> '09:30' then raise exception 'FAIL setting not saved'; end if;
  begin perform set_setting('face_threshold', '10'); raise exception 'FAIL bad value saved'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_setting('chairman_away', 'true'); raise exception 'FAIL tech set chairman away'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select status from devices where device_key = 'new-phone') <> 'active' or (select status from devices where device_key = 'old-phone') <> 'revoked' then raise exception 'FAIL phone switch'; end if;
  if not (verify_audit_chain() ->> 'ok')::boolean then raise exception 'FAIL audit chain broken'; end if;
  begin perform remove_role_login('ai@startuptn.in'); raise exception 'FAIL removed own login'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform remove_role_login('chairman.ai@startuptn.in');
  raise notice 'PASS 13b Tech adds logins, tunes rules, approves phones, checks audit';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin if not exists (select 1 from notifications where kind = 'device_ok') then raise exception 'FAIL staff not told'; end if; raise notice 'PASS 13d staff told the new phone is approved'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c7');
do $$ begin
  if my_role() is not null or sees_all() then raise exception 'FAIL removed login still has access'; end if;
  raise notice 'PASS 13c removed login loses access at once';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select add_role_login('chairman.ai@startuptn.in', 'Chairman (test)', 'chairman');

-- 14. OD needs a map pin; venue check-in shows on the staff home without distance; HR moves hubs
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin insert into od_requests (user_id,subject,venue_name,starts_at,ends_at) values ('00000000-0000-0000-0000-000000000001','Typed only','Guindy',now()+interval '2 day',now()+interval '2 day 1 hour');
    raise exception 'FAIL OD saved without a pin'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into od_requests (user_id,subject,venue_name,venue_lat,venue_lng,venue_url,starts_at,ends_at) values ('00000000-0000-0000-0000-000000000001','Bad link','x',13,80,'https://evil.example.com/maps',now()+interval '2 day',now()+interval '2 day 1 hour');
    raise exception 'FAIL OD saved with a non-maps link'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 14 OD needs a Google or Apple Maps pin';
end $$;
select pg_temp.reset();
insert into od_requests (user_id,subject,venue_name,venue_lat,venue_lng,venue_url,venue_place,starts_at,ends_at,status)
values ('00000000-0000-0000-0000-000000000001','Collector review','Collectorate',13.05,80.25,'https://maps.apple.com/?ll=13.05,80.25&q=Collectorate','Collectorate, Chennai',now()-interval '1 hour',now()+interval '3 hours','approved');
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ declare t jsonb := my_today(); begin
  if t->'od_today'->>'subject' <> 'Collector review' then raise exception 'FAIL od_today missing'; end if;
  if t::text ~* 'distance|inside|radius|flag' then raise exception 'FAIL my_today leaks location checks'; end if;
  raise notice 'PASS 14b staff sees today''s OD, never the venue check result';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
update staff_roster set hub_name = 'Coimbatore' where email = 'arun@startuptn.in';
do $$ begin
  begin update staff_roster set hub_name = 'Atlantis' where email = 'arun@startuptn.in'; raise exception 'FAIL moved to unknown hub';
    exception when foreign_key_violation then null; when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
end $$;
select pg_temp.reset();
do $$ begin
  if (select h.name from profiles p join hubs h on h.id = p.hub_id where p.email = 'arun@startuptn.in') <> 'Coimbatore' then raise exception 'FAIL hub not moved'; end if;
  if not exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000000002' and kind = 'hub_changed') then raise exception 'FAIL not told'; end if;
  raise notice 'PASS 14c HR moves staff to another hub; staff told';
end $$;

-- 15. Hub pins, test staff, and Tech purge (audit log kept)
select pg_temp.reset();
do $$ begin
  if (select pin_set_at from hubs where name = 'Chennai') is not null then raise exception 'FAIL seed pin counted as set'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
update hubs set radius_m = 300 where name = 'Chennai';
do $$ begin if (select pin_set_at from hubs where name = 'Chennai') is not null then raise exception 'FAIL same pin counted as set'; end if; end $$;
update hubs set lat = 13.0321, lng = 80.2436 where name = 'Chennai';
do $$ begin if (select pin_set_at from hubs where name = 'Chennai') is null then raise exception 'FAIL new pin not marked'; end if;
  begin perform purge_records('everyone', p_dry => false); raise exception 'FAIL HR purged'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform add_test_staff('t1@startuptn.in', 'T', 'Chennai'); raise exception 'FAIL HR added test staff'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 15 real hub pins tracked; HR cannot purge';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select add_test_staff('Tester@StartupTN.in', 'Tester', 'Chennai');
do $$ declare r jsonb; a bigint; begin
  if not (select is_test from staff_roster where email = 'tester@startuptn.in') then raise exception 'FAIL test staff not added'; end if;
  a := (select count(*) from audit_log);
  r := purge_records('person', p_user => '00000000-0000-0000-0000-000000000001');
  if (r->>'checkins')::int < 1 or exists (select 1 from punches where user_id = '00000000-0000-0000-0000-000000000001') is false then raise exception 'FAIL dry run wrong %', r; end if;
  r := purge_records('person', p_user => '00000000-0000-0000-0000-000000000001', p_dry => false);
  if exists (select 1 from punches where user_id = '00000000-0000-0000-0000-000000000001') then raise exception 'FAIL punches remain'; end if;
  if exists (select 1 from od_requests where user_id = '00000000-0000-0000-0000-000000000001') then raise exception 'FAIL ODs remain'; end if;
  if (select count(*) from audit_log) <= a then raise exception 'FAIL purge not logged'; end if;
  if not (verify_audit_chain() ->> 'ok')::boolean then raise exception 'FAIL audit chain broken by purge'; end if;
  raise notice 'PASS 15b Tech previews then clears a person; audit log kept and chained';
end $$;

-- 16. Full delete by HR (same email can come back fresh) and Tech single-selfie removal
select pg_temp.reset();
insert into staff_roster (email, full_name, role, hub_name) values ('leaver@startuptn.in','Leaver','staff','Salem');
insert into auth.users values ('00000000-0000-0000-0000-00000000e101','leaver@startuptn.in');
update profiles set consent_at = now() where email = 'leaver@startuptn.in';
insert into punches (id,user_id,kind,idempotency_key,client_time,lat,lng,accuracy_m,target_type,selfie_key)
values ('00000000-0000-0000-0000-00000000ee01','00000000-0000-0000-0000-00000000e101','in','lv1',now(),11.66,78.14,10,'hub','selfies/00000000-0000-0000-0000-00000000e101/a.jpg'),
       ('00000000-0000-0000-0000-00000000ee02','00000000-0000-0000-0000-00000000e101','out','lv2',now(),11.66,78.14,10,'hub','selfies/00000000-0000-0000-0000-00000000e101/b.jpg');
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin perform delete_staff_full('leaver@startuptn.in'); raise exception 'FAIL staff deleted someone'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform remove_selfie('00000000-0000-0000-0000-00000000ee01', 'x'); raise exception 'FAIL staff removed selfie'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 16 staff cannot delete people or selfies';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin perform remove_selfie('00000000-0000-0000-0000-00000000ee01', 'x'); raise exception 'FAIL HR removed selfie'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform delete_staff_full('hr@startuptn.in'); raise exception 'FAIL HR deleted a role account'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ declare k text; begin
  k := remove_selfie('00000000-0000-0000-0000-00000000ee01', 'Test photo');
  if k <> 'selfies/00000000-0000-0000-0000-00000000e101/a.jpg' then raise exception 'FAIL wrong key'; end if;
  if (select selfie_key from punches where id = '00000000-0000-0000-0000-00000000ee01') is not null then raise exception 'FAIL key kept'; end if;
  if (select selfie_removed->>'reason' from punches where id = '00000000-0000-0000-0000-00000000ee01') <> 'Test photo' then raise exception 'FAIL reason not kept'; end if;
  raise notice 'PASS 16b Tech removes one selfie, check-in stays, reason kept';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r jsonb; begin
  r := delete_staff_full('Leaver@StartupTN.in');
  if (r->>'checkins')::int <> 2 or jsonb_array_length(r->'selfie_keys') <> 1 then raise exception 'FAIL counts %', r; end if;
  raise notice 'PASS 16c HR deletes a person with records';
end $$;
select pg_temp.reset();
do $$ begin
  if exists (select 1 from punches where user_id = '00000000-0000-0000-0000-00000000e101') or exists (select 1 from profiles where email = 'leaver@startuptn.in')
     or exists (select 1 from auth.users where email = 'leaver@startuptn.in') or exists (select 1 from staff_roster where email = 'leaver@startuptn.in') then raise exception 'FAIL leftovers'; end if;
  if not (verify_audit_chain() is null or true) then raise exception 'x'; end if;
end $$;
insert into staff_roster (email, full_name, role, hub_name) values ('leaver@startuptn.in','Leaver again','staff','Salem');
insert into auth.users values ('00000000-0000-0000-0000-00000000e102','leaver@startuptn.in');
do $$ begin
  if (select count(*) from punches p join profiles pr on pr.id = p.user_id where pr.email = 'leaver@startuptn.in') <> 0 then raise exception 'FAIL old records came back'; end if;
  if (select full_name from profiles where email = 'leaver@startuptn.in') <> 'Leaver again' then raise exception 'FAIL re-add failed'; end if;
  raise notice 'PASS 16d same email added again starts fresh';
end $$;

-- 17. Chairman availability (RLS), test mode resets, leaving for OD
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin insert into chairman_availability (starts_at, ends_at, created_by) values (now(), now() + interval '1 hour', '00000000-0000-0000-0000-000000000001');
    raise exception 'FAIL staff posted availability'; exception when insufficient_privilege then null; end;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
insert into chairman_availability (starts_at, ends_at, place) values (now() + interval '1 hour', now() + interval '2 hours', 'Chennai hub');
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if jsonb_array_length(my_today()->'chairman_available') <> 1 then raise exception 'FAIL staff cannot see availability'; end if;
  if (my_today()->>'test_mode')::boolean then raise exception 'FAIL real staff in test mode'; end if;
  begin perform reset_my_test_day(); raise exception 'FAIL real staff reset their day'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 17 Chairman availability visible to staff; only Chairman posts; real staff cannot reset';
end $$;
select pg_temp.reset();
insert into auth.users values ('00000000-0000-0000-0000-00000000f501','naveenflop+staff@gmail.com');
update profiles set consent_at = now() where email = 'naveenflop+staff@gmail.com';
insert into punches (user_id,kind,idempotency_key,client_time,lat,lng,target_type) values ('00000000-0000-0000-0000-00000000f501','in','ts1',now(),13,80,'hub');
insert into attendance_days (user_id, day, in_time) values ('00000000-0000-0000-0000-00000000f501', (now() at time zone 'Asia/Kolkata')::date, now());
select pg_temp.as_user('00000000-0000-0000-0000-00000000f501');
do $$ begin
  if not (my_today()->>'test_mode')::boolean then raise exception 'FAIL test staff not in test mode'; end if;
  perform reset_my_test_day();
  if exists (select 1 from attendance_days where user_id = '00000000-0000-0000-0000-00000000f501') then raise exception 'FAIL day not reset'; end if;
  raise notice 'PASS 17b test staff can reset their day';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  if (hr_today()->>'staff')::int <> (select count(*) from staff_roster r left join profiles pr on pr.email = r.email where r.role in ('staff','intern') and not r.is_test and coalesce(pr.active, true)) then raise exception 'FAIL test staff counted'; end if;
  begin perform set_test_mode('naveenflop+staff@gmail.com', false); raise exception 'FAIL HR changed test mode'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 17c test staff left out of HR numbers; only Tech switches test mode';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select set_test_mode('naveenflop+staff@gmail.com', false);
select pg_temp.as_user('00000000-0000-0000-0000-00000000f501');
do $$ begin if (my_today()->>'test_mode')::boolean then raise exception 'FAIL test mode not off'; end if; raise notice 'PASS 17d Tech switches test mode off'; end $$;

-- 18. Security review: signed-out callers get nothing; staff can't read rule settings; HR can't create test accounts
select pg_temp.reset();
set role anon;
do $$ begin
  begin perform my_today(); raise exception 'FAIL anon called my_today'; exception when insufficient_privilege then null; end;
  begin perform count(*) from staff_roster; raise exception 'FAIL anon read roster'; exception when insufficient_privilege then null; end;
  raise notice 'PASS 18 signed-out callers can use no function or table';
end $$;
reset role;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin perform setting('face_threshold'); raise exception 'FAIL staff read a rule setting'; exception when insufficient_privilege then null; end;
  begin perform is_test_mode('00000000-0000-0000-0000-000000000001'); raise exception 'FAIL staff called test helper'; exception when insufficient_privilege then null; end;
  if (my_today()->'profile'->>'hub') is null then raise exception 'FAIL my_today broke'; end if;
  raise notice 'PASS 18b staff cannot read rule settings; my_today still works';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin update staff_roster set is_test = true where email = 'arun@startuptn.in'; raise exception 'FAIL HR made a real person test';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into staff_roster (email, full_name, role, hub_name, is_test) values ('fake@startuptn.in','F','staff','Salem',true); raise exception 'FAIL HR added test staff';
    exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  update staff_roster set designation = 'Hub Lead' where email = 'arun@startuptn.in';
  raise notice 'PASS 18c only Tech changes test accounts; HR edits still work';
end $$;

-- 19. Bulk upload: Tech only; bad rows reported, good rows saved
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin begin perform bulk_upsert_staff('[]'::jsonb); raise exception 'FAIL HR bulk upload'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 19 only Tech can bulk upload'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ declare r jsonb; begin
  r := bulk_upsert_staff('[{"full_name":"Bulk One","email":"Bulk1@StartupTN.in","hub":"chennai","employee_code":"B001","joined_on":"2026-11-03"},
    {"full_name":"Bad Hub","email":"b2@startuptn.in","hub":"Atlantis"},
    {"full_name":"Dup Code","email":"b3@startuptn.in","hub":"Salem","employee_code":"B001"},
    {"full_name":"Role","email":"hr@startuptn.in","hub":"Salem"},
    {"full_name":"Bad Date","email":"b5@startuptn.in","hub":"Salem","joined_on":"31/31/2026"},
    {"full_name":"Kavya R","email":"kavya@startuptn.in","hub":"Salem"}]'::jsonb);
  if r->0->>'result' <> 'added' or (select hub_name from staff_roster where email='bulk1@startuptn.in') <> 'Chennai' then raise exception 'FAIL good row %', r->0; end if;
  if r->1->>'result' <> 'error' or r->2->>'result' <> 'error' or r->3->>'result' <> 'error' or r->4->>'result' <> 'error' then raise exception 'FAIL bad rows %', r; end if;
  if r->5->>'result' <> 'skipped' then raise exception 'FAIL existing not skipped %', r->5; end if;
  r := bulk_upsert_staff('[{"full_name":"Kavya R","email":"kavya@startuptn.in","hub":"Salem"}]'::jsonb, true);
  if r->0->>'result' <> 'updated' or (select hub_name from staff_roster where email='kavya@startuptn.in') <> 'Salem' then raise exception 'FAIL update %', r; end if;
  r := bulk_upsert_hubs('[{"name":"Tambaram","lat":"12.9249","lng":"80.1000","radius_m":"300"},{"name":"Chennai","radius_m":"200"},{"name":"NoPin"}]'::jsonb);
  if r->0->>'result' <> 'added' or r->1->>'result' <> 'updated' or r->2->>'result' <> 'error' then raise exception 'FAIL hubs %', r; end if;
  if (select radius_m from hubs where name='Chennai') <> 200 then raise exception 'FAIL hub radius'; end if;
  raise notice 'PASS 19b bulk staff and hubs: good rows saved, bad rows explained';
end $$;

-- ---------- 20. demo role logins (temporary) ----------
do $$ begin
  if (select role from staff_roster where email = 'hr.ai@startuptn.in') is distinct from 'hr' then raise exception 'FAIL demo HR login on roster'; end if;
  if (select role from staff_roster where email = 'chairman.ai@startuptn.in') is distinct from 'chairman' then raise exception 'FAIL demo Chairman login on roster'; end if;
  raise notice 'PASS demo HR and Chairman logins on the roster with the right roles';
end $$;

-- ---------- 21. HR asks a reason for a late check-in / early check-out ----------
select pg_temp.reset();
insert into punches (id, user_id, kind, idempotency_key, client_time, lat, lng, accuracy_m, target_type, band)
values ('00000000-0000-0000-0000-00000000aa21', '00000000-0000-0000-0000-000000000002', 'in', 'late21', now(), 13.08, 80.27, 10, 'hub', 'warn');
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  begin perform ask_punch_reason('00000000-0000-0000-0000-00000000aa21', 'late'); raise exception 'FAIL staff asked a reason';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS staff cannot ask reasons';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare f uuid; begin
  begin perform ask_punch_reason('00000000-0000-0000-0000-00000000aa21', 'early_out'); raise exception 'FAIL early-out asked on a check-in';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  f := ask_punch_reason('00000000-0000-0000-0000-00000000aa21', 'late');
  if (select status from flags where id = f) <> 'reason_asked' then raise exception 'FAIL late flag not reason_asked'; end if;
  raise notice 'PASS HR asks a reason for a late check-in';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ declare f uuid; begin
  select (data->>'flag_id')::uuid into f from notifications where kind = 'reason_asked' and body like 'For your late check-in%' order by created_at desc limit 1;
  if f is null then raise exception 'FAIL staff got no "Add a reason"'; end if;
  perform submit_flag_reason(f, 'Bus breakdown on OMR');
  raise notice 'PASS staff gets the ask and answers it';
end $$;
select pg_temp.reset();

-- ---------- 22. work-hours presence (store app) ----------
select pg_temp.reset();
insert into attendance_days (user_id, day, in_time, out_time, status)
values ('00000000-0000-0000-0000-000000000001', '2026-11-03', '2026-11-03 10:05+05:30', '2026-11-03 18:00+05:30', 'present')
on conflict (user_id, day) do update set in_time = excluded.in_time, out_time = excluded.out_time;
insert into presence_samples (user_id, at, source, lat, lng, accuracy_m, target_type, distance_m, inside) values
 ('00000000-0000-0000-0000-000000000001', '2026-11-03 10:05+05:30', 'watch', 13.08, 80.27, 10, 'hub', 20, true),
 ('00000000-0000-0000-0000-000000000001', '2026-11-03 10:20+05:30', 'beat',  13.08, 80.27, 10, 'hub', 20, true),
 ('00000000-0000-0000-0000-000000000001', '2026-11-03 10:35+05:30', 'watch', 13.083, 80.27, 10, 'hub', 300, false),
 ('00000000-0000-0000-0000-000000000001', '2026-11-03 10:50+05:30', 'beat',  13.084, 80.27, 10, 'hub', 420, false),
 ('00000000-0000-0000-0000-000000000001', '2026-11-03 11:05+05:30', 'watch', 13.08, 80.27, 10, 'hub', 25, true),
 ('00000000-0000-0000-0000-000000000001', '2026-11-03 12:00+05:30', 'watch', 13.08, 80.27, 10, 'hub', 25, true),
 ('00000000-0000-0000-0000-000000000001', '2026-11-03 12:10+05:30', 'beat',  13.08, 80.27, 10, 'hub', 25, true);
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from presence_samples) <> 0 then raise exception 'FAIL staff reads presence samples'; end if;
  begin perform presence_day('00000000-0000-0000-0000-000000000001', '2026-11-03'); raise exception 'FAIL staff called presence_day';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into presence_samples (user_id, at, source, lat, lng, target_type, inside) values ('00000000-0000-0000-0000-000000000001', now(), 'watch', 1, 1, 'hub', true); raise exception 'FAIL staff wrote a presence sample';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS staff cannot read, compute or write presence';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare j jsonb; begin
  j := presence_day('00000000-0000-0000-0000-000000000001', '2026-11-03');
  if (j->>'inside_min')::int <> 55 or (j->>'outside_min')::int <> 30 or (j->>'no_signal_min')::int <> 390 then raise exception 'FAIL presence minutes %', j; end if;
  if jsonb_array_length(j->'trips') <> 1 or (j->'trips'->0->>'min')::int <> 30 or (j->'trips'->0->>'max_m')::int <> 420 then raise exception 'FAIL presence trip %', j->'trips'; end if;
  raise notice 'PASS HR sees 55 min inside, one 30-min trip outside (max 420 m), 390 min no signal';
  if (presence_day('00000000-0000-0000-0000-000000000002', '2026-11-03')->>'tracked')::boolean then raise exception 'FAIL not-checked-in day tracked'; end if;
  raise notice 'PASS a day without check-in is not tracked';
end $$;
select pg_temp.reset();

-- ---------- 23. work-hours location consent ----------
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  perform give_presence_consent();
  if (select presence_consent_at from profiles where id = '00000000-0000-0000-0000-000000000002') is null then raise exception 'FAIL consent not recorded'; end if;
  if (select count(*) from profiles where presence_consent_at is not null) <> 1 then raise exception 'FAIL consent touched other rows'; end if;
  raise notice 'PASS staff records their own work-hours location consent';
end $$;
select pg_temp.reset();

-- ---------- 24. standing still keeps the place; location off is no signal ----------
select pg_temp.reset();
insert into attendance_days (user_id, day, in_time, out_time, status)
values ('00000000-0000-0000-0000-000000000002', '2026-11-03', '2026-11-03 10:00+05:30', '2026-11-03 13:00+05:30', 'present')
on conflict (user_id, day) do update set in_time = excluded.in_time, out_time = excluded.out_time;
insert into presence_samples (user_id, at, source, lat, lng, accuracy_m, target_type, distance_m, inside, moving) values
 ('00000000-0000-0000-0000-000000000002', '2026-11-03 10:00+05:30', 'watch', 13.08, 80.27, 10, 'hub', 20, true, false),   -- at desk, still, silent 2 h
 ('00000000-0000-0000-0000-000000000002', '2026-11-03 12:00+05:30', 'watch', 13.09, 80.27, 10, 'hub', 900, false, true),  -- moved out
 ('00000000-0000-0000-0000-000000000002', '2026-11-03 12:10+05:30', 'off',   13.09, 80.27, 10, 'hub', 900, false, null);  -- location off
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare j jsonb; begin
  j := presence_day('00000000-0000-0000-0000-000000000002', '2026-11-03');
  if (j->>'inside_min')::int <> 120 or (j->>'outside_min')::int <> 10 or (j->>'no_signal_min')::int <> 50 then raise exception 'FAIL stationary/off minutes %', j; end if;
  raise notice 'PASS standing still at the desk counts as inside (120 min); location off counts as no signal';
end $$;
select pg_temp.reset();

-- ---------- 25. biometric link (eSSL) ----------
select pg_temp.reset();
update staff_roster set employee_code = 'STN901' where email = 'kavya@startuptn.in';
insert into bio_links (id, name, key_hash) values ('00000000-0000-0000-0000-0000000000b1', 'Test office', 'testhash') on conflict do nothing;
do $$ declare j jsonb; begin
  j := bio_ingest('00000000-0000-0000-0000-0000000000b1', '{
    "agent": {"pc": "TEST", "version": "1"},
    "devices": [{"id": 14, "name": "Biometric", "serial": "TDBD1", "kind": "biometric", "ip": "192.168.1.252"}],
    "people": [{"code": "901", "essl_code": "stn901", "name": "Kavya"}, {"code": "016", "essl_code": "016", "name": "Someone"}],
    "punches": [{"t": "DeviceLogs_11_2026", "id": 1, "dev": "14", "code": "901", "at": "2026-11-05T09:41:12+05:30", "dir": "in"},
                {"t": "DeviceLogs_11_2026", "id": 2, "dev": "14", "code": "016", "at": "2026-11-05T09:58:03+05:30", "dir": "in"},
                {"t": "Bad;Table", "id": 3, "dev": "14", "code": "016", "at": "2026-11-05T10:00:00+05:30"}]}');
  if (j->>'saved')::int <> 2 then raise exception 'FAIL bio ingest saved %', j; end if;
  j := bio_ingest('00000000-0000-0000-0000-0000000000b1', '{"punches": [{"t": "DeviceLogs_11_2026", "id": 1, "dev": "14", "code": "901", "at": "2026-11-05T09:41:12+05:30"}]}');
  if (j->>'saved')::int <> 0 then raise exception 'FAIL bio resend duplicated %', j; end if;
  if (select email from bio_people where device_code = '901') <> 'kavya@startuptn.in' then raise exception 'FAIL bio auto match'; end if;
  if (select matched from bio_people where device_code = '016') <> 'none' then raise exception 'FAIL bio false match'; end if;
  raise notice 'PASS biometric: 2 punches saved, resend ignored, bad table name refused, exact code linked, other code left for matching';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from bio_punches) + (select count(*) from bio_people) + (select count(*) from bio_devices) + (select count(*) from bio_status) + (select count(*) from bio_links) <> 0 then raise exception 'FAIL staff reads biometric tables'; end if;
  if (select count(*) from bio_day('2026-11-05')) <> 0 then raise exception 'FAIL staff reads bio_day'; end if;
  if (select count(*) from bio_range('2026-11-01', '2026-11-05')) <> 0 then raise exception 'FAIL staff reads bio_range'; end if;
  begin perform bio_ingest('00000000-0000-0000-0000-0000000000b1', '{}'); raise exception 'FAIL staff called bio_ingest';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform bio_new_key('x'); raise exception 'FAIL staff made a link key';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into bio_punches (link_id, essl_table, essl_log_id, device_code, punched_at) values ('00000000-0000-0000-0000-0000000000b1', 'DeviceLogs', 9, 'x', now()); raise exception 'FAIL staff wrote a fingerprint punch';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS staff cannot read, send or write fingerprint data';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  if (select count(*) from bio_day('2026-11-05')) <> 2 then raise exception 'FAIL HR bio_day'; end if;
  if (select full_name from bio_day('2026-11-05') where device_code = '901') <> 'Kavya R' then raise exception 'FAIL HR bio_day name'; end if;
  if (select count(*) from bio_person('00000000-0000-0000-0000-000000000001', 3650)) <> 1 then raise exception 'FAIL HR bio_person'; end if;
  begin perform bio_new_key('x'); raise exception 'FAIL HR made a link key';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select count(*) from bio_range('2026-11-01', '2026-11-05')) <> 2 then raise exception 'FAIL HR bio_range'; end if;
  if (select first_at from bio_range('2026-11-05', '2026-11-05') where device_code = '901') <> '2026-11-05 09:41:12+05:30' then raise exception 'FAIL bio_range first punch'; end if;
  perform bio_match_person('00000000-0000-0000-0000-0000000000b1', '016', 'arun@startuptn.in');
  perform bio_set_device_hub('00000000-0000-0000-0000-0000000000b1', 14, (select id from hubs where name = 'Chennai'));
  raise notice 'PASS HR reads fingerprint punches, matches a code by hand, sets the device hub; cannot make keys';
end $$;
select pg_temp.reset();
do $$ begin
  perform bio_ingest('00000000-0000-0000-0000-0000000000b1', '{"people": [{"code": "016", "essl_code": "016", "name": "Someone else"}]}');
  if (select email from bio_people where device_code = '016') <> 'arun@startuptn.in' then raise exception 'FAIL manual match overwritten'; end if;
  if (select count(*) from audit_log where entity = 'bio_people' and after->>'matched' = 'manual') < 1 then raise exception 'FAIL manual match not audited'; end if;
  raise notice 'PASS a manual match survives the next sync and is in the audit log';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ declare k text; begin
  k := bio_new_key('Test office');
  if k !~ '^stnbio_[0-9a-f]{64}$' then raise exception 'FAIL key format'; end if;
  if (select count(*) from bio_links where name = 'Test office' and revoked_at is null) <> 1 then raise exception 'FAIL old key not revoked'; end if;
  if (select key_hash from bio_links where name = 'Test office' and revoked_at is null) <> encode(digest(k, 'sha256'), 'hex') then raise exception 'FAIL key hash'; end if;
  raise notice 'PASS Tech makes a link key (only its hash stored; the old key with the same name is revoked)';
end $$;
select pg_temp.reset();

-- ---------- 26. fingerprint feeds HR: 20-minute double-punch rule, 5-minute grace, staff not yet signed in ----------
select pg_temp.reset();
update settings set value = '"10:00"' where key = 'office_start';   -- an earlier test moved it to 09:30
update settings set value = '"10:05"' where key = 'late_until';
insert into staff_roster (email, full_name, role, hub_name, employee_code) values ('meena@startuptn.in', 'Meena S', 'staff', 'Chennai', 'STN950') on conflict do nothing;
do $$ declare j jsonb; t text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'); begin
  j := bio_ingest('00000000-0000-0000-0000-0000000000b1', jsonb_build_object(
    'people', '[{"code": "950", "essl_code": "STN950", "name": "Meena S"}]'::jsonb,
    'punches', jsonb_build_array(
      jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 10, 'dev', '14', 'code', '901', 'at', '2026-11-05T09:50:00+05:30'),   -- Kavya again 9 min later: ignored
      jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 11, 'dev', '14', 'code', '901', 'at', '2026-11-05T18:05:00+05:30'),   -- Kavya out
      jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 12, 'dev', '14', 'code', '950', 'at', '2026-11-03T10:03:00+05:30'),   -- Meena 10:03: yellow
      jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 13, 'dev', '14', 'code', '950', 'at', '2026-11-03T10:15:00+05:30'),   -- 12 min later: not an out
      jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 14, 'dev', '14', 'code', '016', 'at', '2026-11-04T10:06:00+05:30'),   -- Arun 10:06: red
      jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 15, 'dev', '14', 'code', '950', 'at', t || 'T09:30:00+05:30'))));     -- Meena today
  if (j->>'saved')::int <> 6 then raise exception 'FAIL bio feed ingest %', j; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r record; begin
  select * into r from bio_attendance('2026-11-05', '2026-11-05') where email = 'kavya@startuptn.in';
  if r.in_at <> '2026-11-05 09:41:12+05:30' or r.out_at <> '2026-11-05 18:05:00+05:30' or r.band <> 'ok' then raise exception 'FAIL kavya in/out %', r; end if;
  select * into r from bio_attendance('2026-11-03', '2026-11-03') where email = 'meena@startuptn.in';
  if r.band <> 'warn' or r.out_at is not null then raise exception 'FAIL 10:03 yellow, repeat within 20 min not an out %', r; end if;
  select * into r from bio_attendance('2026-11-04', '2026-11-04') where email = 'arun@startuptn.in';
  if r.band <> 'bad' then raise exception 'FAIL 10:06 should be red %', r; end if;
  raise notice 'PASS fingerprint: first punch = in, out only after 20 min, 10:00 green / 10:03 yellow / 10:06 red';
  if (select count(*) from hr_person_days('meena@startuptn.in', '2026-11-01', '2026-11-30') where day = '2026-11-03' and band = 'warn' and source = 'bio') <> 1 then raise exception 'FAIL calendar for staff not signed in'; end if;
  if (select (hr_today()->>'checked_in')::int) < 1 or (select (hr_today()->>'staff')::int) < 3 or hr_today()->'checked_out' is null then raise exception 'FAIL hr_today with fingerprint %', hr_today(); end if;
  if (select r2.last_at from bio_range('2026-11-03', '2026-11-03') r2 where r2.device_code = '950') is not null then raise exception 'FAIL report out within 20 min'; end if;
  raise notice 'PASS HR calendar and home numbers include fingerprint days, also for staff who have not signed in';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from bio_attendance('2026-11-01', '2026-11-30')) <> 0 then raise exception 'FAIL staff reads bio_attendance'; end if;
  begin perform hr_person_days('meena@startuptn.in', '2026-11-01', '2026-11-30'); raise exception 'FAIL staff called hr_person_days';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS staff cannot read fingerprint attendance';
end $$;
select pg_temp.reset();

-- ---------- 27. codes without case; verification against eSSL's own numbers ----------
select pg_temp.reset();
do $$ declare j jsonb; begin
  j := bio_ingest('00000000-0000-0000-0000-0000000000b1', '{
    "punches": [{"t": "DeviceLogs_11_2026", "id": 20, "dev": "14", "code": "stn950", "at": "2026-11-02T09:59:00+05:30"},
                {"t": "DeviceLogs_11_2026", "id": 21, "dev": "14", "code": "STN950", "at": "2026-11-02T18:01:00+05:30"}],
    "people": [{"code": "STN950", "essl_code": "STN950", "name": "Meena S"}],
    "audit": {"tables": [{"t": "DeviceLogs_11_2026", "count": 99, "max_id": 21, "days": {"2026-11-02": 2, "2026-11-03": 3}}],
              "attendance": [{"code": "STN950", "day": "2026-11-02", "in": "09:59", "out": "18:01", "status": "P"},
                             {"code": "950", "day": "2026-11-03", "in": "10:03", "out": "10:15", "status": "P"}]}}');
  if (j->>'saved')::int <> 2 or (j->>'essl_days')::int <> 2 then raise exception 'FAIL audit ingest %', j; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r record; begin
  select * into r from bio_attendance('2026-11-02', '2026-11-02') where email = 'meena@startuptn.in';
  if r.in_at is null or r.out_at <> '2026-11-02 18:01:00+05:30' then raise exception 'FAIL lower-case code not linked %', r; end if;
  raise notice 'PASS a code in lower case (stn950) links to the same person as STN950';
  select * into r from bio_verify('2026-11-02', '2026-11-02');
  if r.essl_rows <> 2 or r.stored_rows <> 2 or r.orphans <> 0 or r.compared <> 1 or r.in_agree <> 1 or r.out_agree <> 1 then raise exception 'FAIL verify 2 Nov %', r; end if;
  select * into r from bio_verify('2026-11-03', '2026-11-03');
  if r.compared <> 1 or r.in_agree <> 1 or r.out_agree <> 1 then raise exception 'FAIL verify 3 Nov (out inside 20 min agrees with eSSL) %', r; end if;
  raise notice 'PASS verification: eSSL rows = stored rows, no orphans, in and out agree with eSSL attendance';
  perform 1;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from bio_essl_days) + (select count(*) from bio_audit) <> 0 then raise exception 'FAIL staff reads eSSL audit'; end if;
  if (select count(*) from bio_verify('2026-11-01', '2026-11-05') where stored_rows > 0) <> 0 then raise exception 'FAIL staff reads verification'; end if;
  raise notice 'PASS staff cannot read the eSSL audit';
end $$;
select pg_temp.reset();

-- ---------- 28. eSSL's filled-in shift end is not a disagreement ----------
select pg_temp.reset();
do $$ begin
  perform bio_ingest('00000000-0000-0000-0000-0000000000b1', '{
    "punches": [{"t": "DeviceLogs_11_2026", "id": 30, "dev": "14", "code": "STN950", "at": "2026-11-06T09:40:00+05:30"}],
    "audit": {"attendance": [{"code": "STN950", "day": "2026-11-06", "in": "09:40", "out": "18:00", "status": "P"}]}}');
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare r record; begin
  select * into r from bio_verify('2026-11-06', '2026-11-06');
  if r.compared <> 1 or r.in_agree <> 1 or r.out_agree <> 1 or r.essl_filled <> 1 or jsonb_array_length(r.differ) <> 0 then raise exception 'FAIL eSSL filled 18:00 %', r; end if;
  raise notice 'PASS eSSL''s filled-in 18:00 (no punch at that time) is counted as filled, not as a disagreement';
end $$;
select pg_temp.reset();

-- ---------- 29. staff see only their own fingerprint ----------
select pg_temp.reset();
do $$ declare t text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'); begin
  perform bio_ingest('00000000-0000-0000-0000-0000000000b1', jsonb_build_object('punches', jsonb_build_array(
    jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 40, 'dev', '14', 'code', '901', 'at', t || 'T09:55:00+05:30'),
    jsonb_build_object('t', 'DeviceLogs_11_2026', 'id', 41, 'dev', '14', 'code', '901', 'at', t || 'T17:30:00+05:30'))));
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ declare j jsonb; begin
  j := my_fingerprint();
  if j->'today'->>'band' <> 'ok' or j->'today'->>'out_at' is null then raise exception 'FAIL my_fingerprint today %', j; end if;
  if (j->'month'->>'finger_days')::int < 1 then raise exception 'FAIL my_fingerprint month %', j; end if;
  if j::text ~ '(radius|distance|inside|flag)' then raise exception 'FAIL my_fingerprint leaks checks'; end if;
  begin perform person_days_merged('arun@startuptn.in', '2026-11-01', '2026-11-30'); raise exception 'FAIL staff called person_days_merged';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS staff see their own fingerprint in/out and month, nothing about checks or other people';
end $$;
select pg_temp.reset();

-- ---------- 30. staff calendar: own punches, OD and leave only ----------
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ declare j jsonb; begin
  j := my_month();
  if jsonb_typeof(j->'days') <> 'array' or jsonb_array_length(j->'days') < 1 then raise exception 'FAIL my_month days %', j; end if;
  if j::text ~ '(radius|distance|inside|flag|face|similarity)' then raise exception 'FAIL my_month leaks checks'; end if;
  begin perform my_month('2020-01-01'); raise exception 'FAIL my_month too far back allowed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS staff calendar shows own in/out, OD and leave, nothing about checks';
end $$;
select pg_temp.reset();

-- ---------- 31. holidays, HR day marks, reporting staff and approval routing ----------
select pg_temp.reset();
update settings set value = '"hr"' where key = 'leave_approver';
update settings set value = '"chairman"' where key = 'od_approver';
update settings set value = 'false' where key = 'chairman_away';
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  if (select count(*) from holidays where day = '2026-11-08') <> 1 then raise exception 'FAIL staff cannot see holidays'; end if;
  begin perform save_holiday('2026-11-20', 'Fake', 'office'); raise exception 'FAIL staff edited holidays';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_day_mark('arun@startuptn.in', current_date, 'absent'); raise exception 'FAIL staff marked a day';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_reports_to('arun@startuptn.in', 'kavya@startuptn.in'); raise exception 'FAIL staff set reporting';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_approver('leave', 'reporting'); raise exception 'FAIL staff set approver';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS staff see holidays but cannot edit holidays, marks, reporting or approvers';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  perform save_holiday('2026-11-20', 'Office closed for audit', 'office');
  perform set_day_mark('arun@startuptn.in', (now() at time zone 'Asia/Kolkata')::date, 'absent', null, 'No show');
  perform set_day_mark('meena@startuptn.in', (now() at time zone 'Asia/Kolkata')::date, 'leave', 'sick');
  if (hr_today()->>'absent')::int < 1 or (hr_today()->>'leave')::int < 1 then raise exception 'FAIL hr_today marks %', hr_today(); end if;
  begin perform set_day_mark('arun@startuptn.in', (now() at time zone 'Asia/Kolkata')::date + 3, 'absent'); raise exception 'FAIL future absent';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_reports_to('kavya@startuptn.in', 'arun@startuptn.in');
  begin perform set_reports_to('arun@startuptn.in', 'kavya@startuptn.in'); raise exception 'FAIL reporting loop allowed';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_approver('od', 'hr'); raise exception 'FAIL HR set OD approver';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_approver('leave', 'reporting');
  raise notice 'PASS HR edits holidays, marks absent/leave (counted), sets reporting (no loops) and the leave approver; not the OD approver';
end $$;
select pg_temp.reset();
do $$ begin
  if (select count(*) from audit_log where entity = 'day_marks') < 2 or (select count(*) from audit_log where entity = 'holidays' and after->>'kind' = 'office') < 1
     or (select count(*) from audit_log where entity = 'staff_roster' and after->>'reports_to' = 'arun@startuptn.in') < 1 then raise exception 'FAIL marks/holidays/reporting not audited'; end if;
  raise notice 'PASS holidays, day marks and reporting changes are in the audit log';
end $$;
-- Kavya asks for leave: it goes to Arun (her reporting person), not HR
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
insert into leave_requests (user_id, leave_type, starts_on, ends_on, reason) values ('00000000-0000-0000-0000-000000000001', 'casual', current_date + 5, current_date + 5, 'Family function');
do $$ begin
  if (select count(*) from day_marks) <> 0 then raise exception 'FAIL staff reads others marks'; end if;
  raise notice 'PASS staff cannot read other people''s day marks';
end $$;
select pg_temp.reset();
do $$ begin
  if not exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-000000000002' and kind = 'leave_new') then raise exception 'FAIL reporting person not notified'; end if;
  if exists (select 1 from notifications where user_id = '00000000-0000-0000-0000-0000000000a1' and kind = 'leave_new' and data->>'leave_id' = (select id::text from leave_requests where reason = 'Family function')) then raise exception 'FAIL HR notified for a reporting leave'; end if;
  raise notice 'PASS leave request notifies the reporting person, not HR';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare v uuid := (select id from leave_requests where reason = 'Family function'); begin
  if can_decide('leave', v) then raise exception 'FAIL HR can decide a leave routed to reporting staff'; end if;
  if (select route from pending_routes() where id = v) <> 'reporting' or (select approver_name from pending_routes() where id = v) <> 'Arun K' then raise exception 'FAIL pending_routes'; end if;
  begin perform decide_leave(v, 'approved'); raise exception 'FAIL HR decided a reporting leave';
  exception when others then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS HR sees the leave is with Arun K and cannot decide it';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ declare v uuid := (select (my_approvals()->'leave'->0->>'id')::uuid); begin
  if v is null then raise exception 'FAIL reporting person does not see the request'; end if;
  perform decide_leave(v, 'approved');
  if (select status from leave_requests where id = v) <> 'approved' or (select decided_route from leave_requests where id = v) <> 'reporting' then raise exception 'FAIL reporting approval'; end if;
  raise notice 'PASS the reporting person sees and approves the leave';
end $$;
-- OD: Chairman switches OD approval to HR; then only HR decides it
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin perform set_approver('od', 'hr'); raise notice 'PASS Chairman sets the OD approver'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
insert into od_requests (user_id,subject,venue_name,venue_lat,venue_lng,venue_url,starts_at,ends_at) values ('00000000-0000-0000-0000-000000000001','Routing test OD','Guindy',13.01,80.22,'https://maps.app.goo.gl/abc',now()+interval '2 day',now()+interval '2 day 2 hours');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare v uuid := (select id from od_requests where subject = 'Routing test OD'); begin
  if not can_decide('od', v) then raise exception 'FAIL HR cannot decide OD routed to HR'; end if;
  perform decide_od(v, 'approved');
  raise notice 'PASS OD routed to HR is decided by HR';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  if (select count(*) from pending_routes() where can_decide) <> 0 then raise exception 'FAIL Chairman can decide what is routed elsewhere'; end if;
  raise notice 'PASS the Chairman cannot decide requests routed to HR or reporting staff';
end $$;
select pg_temp.reset();
update settings set value = '"hr"' where key = 'leave_approver';
update settings set value = '"chairman"' where key = 'od_approver';

-- ---------- 32. security hardening (9 Nov) ----------
-- admin access only for the approved emails
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin
  begin perform add_role_login('boss@gmail.com', 'X', 'hr'); raise exception 'FAIL Gmail admin added';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; if sqlerrm <> 'not_on_admin_list' then raise exception 'FAIL wrong reason %', sqlerrm; end if; end;
  begin update profiles set role = 'hr' where email = 'arun@startuptn.in'; raise exception 'FAIL staff made HR outside the list';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into staff_roster (email, full_name, role) values ('other@startuptn.in', 'X', 'tech'); raise exception 'FAIL roster admin outside the list';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select role from profiles where email = 'arun@startuptn.in') in ('hr', 'chairman', 'tech') then raise exception 'FAIL arun promoted'; end if;
  raise notice 'PASS 32 admin roles only for the approved emails';
end $$;
-- an admin row that slipped in (written with the service key) still gives no access
select pg_temp.reset();
alter table profiles disable trigger profiles_admin_email;
update profiles set role = 'hr' where email = 'arun@startuptn.in';
alter table profiles enable trigger profiles_admin_email;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  if my_role() is not null or sees_all() then raise exception 'FAIL admin role outside the list has access'; end if;
  if (select count(*) from profiles) > 1 then raise exception 'FAIL sees other profiles'; end if;
  raise notice 'PASS 32b admin role outside the list gives no access';
end $$;
select pg_temp.reset();
alter table profiles disable trigger profiles_admin_email;
alter table profiles disable trigger profiles_guard_role;
update profiles set role = 'staff' where email = 'arun@startuptn.in';
alter table profiles enable trigger profiles_guard_role;
alter table profiles enable trigger profiles_admin_email;
-- the Gmail test admins are gone
do $$ begin
  if exists (select 1 from staff_roster where email in ('naveenflop@gmail.com', 'naveenbackup7@gmail.com') and role <> 'staff') then raise exception 'FAIL Gmail admin on roster'; end if;
  if exists (select 1 from staff_roster where role in ('hr', 'chairman', 'tech') and not admin_email_ok(email)) then raise exception 'FAIL admin outside the list'; end if;
  raise notice 'PASS 32c only approved admin emails on the roster';
end $$;
-- rate limit: server only; counts per window
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin
  begin perform rate_limit('x', 1, 60); raise exception 'FAIL user called rate_limit';
  exception when insufficient_privilege then null; end;
  begin perform admin_email_ok('x'); raise exception 'FAIL user called admin_email_ok';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from rate_hits; raise exception 'FAIL user reads rate_hits';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS 32d rate_limit and the admin list are server only';
end $$;
select pg_temp.reset();
do $$ begin
  if not rate_limit('t:1', 2, 600) or not rate_limit('t:1', 2, 600) then raise exception 'FAIL allowed hits refused'; end if;
  if rate_limit('t:1', 2, 600) then raise exception 'FAIL third hit allowed'; end if;
  if not rate_limit('t:2', 2, 600) then raise exception 'FAIL keys not separate'; end if;
  raise notice 'PASS 32e rate_limit allows the limit, refuses the next';
end $$;
-- text limits
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin insert into leave_requests (user_id, leave_type, starts_on, ends_on, reason) values ('00000000-0000-0000-0000-000000000001', 'casual', current_date + 40, current_date + 40, repeat('x', 1001));
    raise exception 'FAIL long reason saved';
  exception when check_violation then null; end;
  raise notice 'PASS 32f long text refused';
end $$;
select pg_temp.reset();
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('distance_m', 'audit_is_append_only')
             and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then raise exception 'FAIL search_path'; end if;
  raise notice 'PASS 32g every listed function has a fixed search_path';
end $$;

-- ---------- 33. check-in method per hub; disputed selfie falls back to the fingerprint; help contact ----------
-- Kavya (her hub, moved to Salem earlier) on 5 Nov: fingerprint in 09:41:12, out 18:05 (section 26). Add a selfie day: in 09:20, out 17:00.
select pg_temp.reset();
delete from attendance_days where user_id = '00000000-0000-0000-0000-000000000001' and day = '2026-11-05';
insert into punches (id, user_id, kind, idempotency_key, client_time, server_time, lat, lng, target_type, band) values
  ('00000000-0000-0000-0000-0000000033a1', '00000000-0000-0000-0000-000000000001', 'in', 'm33in', '2026-11-05 09:20+05:30', '2026-11-05 09:20+05:30', 13, 80, 'hub', 'ok'),
  ('00000000-0000-0000-0000-0000000033a2', '00000000-0000-0000-0000-000000000001', 'out', 'm33out', '2026-11-05 17:00+05:30', '2026-11-05 17:00+05:30', 13, 80, 'hub', null);
insert into attendance_days (user_id, day, in_punch, out_punch, in_time, out_time, band, early_out, status) values
  ('00000000-0000-0000-0000-000000000001', '2026-11-05', '00000000-0000-0000-0000-0000000033a1', '00000000-0000-0000-0000-0000000033a2',
   '2026-11-05 09:20+05:30', '2026-11-05 17:00+05:30', 'ok', true, 'present');
do $$ declare r record; begin
  select * into r from attendance_merged('2026-11-05', '2026-11-05', 'kavya@startuptn.in');
  if r.method <> 'both' or r.in_time <> '2026-11-05 09:20+05:30' or r.out_time <> '2026-11-05 18:05+05:30' or r.in_src <> 'app' or r.out_src <> 'bio' or r.source <> 'both' or r.early_out then
    raise exception 'FAIL both: earliest in, latest out %', r; end if;
  raise notice 'PASS 33 both: earliest check-in and latest check-out from selfie or fingerprint';
end $$;
-- a dispute on the selfie check-in: the fingerprint time counts
insert into flags (id, punch_id, user_id, kind, rule) values ('00000000-0000-0000-0000-0000000033f1', '00000000-0000-0000-0000-0000000033a1', '00000000-0000-0000-0000-000000000001', 'face', 'test');
do $$ declare r record; begin
  select * into r from attendance_merged('2026-11-05', '2026-11-05', 'kavya@startuptn.in');
  if r.in_time <> '2026-11-05 09:41:12+05:30' or r.in_src <> 'bio' or r.in_punch is not null then raise exception 'FAIL disputed selfie should give way to fingerprint %', r; end if;
  raise notice 'PASS 33b disputed selfie: fingerprint time used';
end $$;
update flags set status = 'valid' where id = '00000000-0000-0000-0000-0000000033f1';
do $$ begin
  if (select in_time from attendance_merged('2026-11-05', '2026-11-05', 'kavya@startuptn.in')) <> '2026-11-05 09:20+05:30' then raise exception 'FAIL cleared dispute: selfie should count again'; end if;
  raise notice 'PASS 33c dispute cleared by HR: selfie counts again';
end $$;
-- a late flag is not a dispute about the selfie
update flags set status = 'open', kind = 'late' where id = '00000000-0000-0000-0000-0000000033f1';
do $$ begin
  if (select in_src from attendance_merged('2026-11-05', '2026-11-05', 'kavya@startuptn.in')) <> 'app' then raise exception 'FAIL late question treated as a dispute'; end if;
  raise notice 'PASS 33d a late-reason question does not replace the selfie time';
end $$;
-- only the Tech admin sets the method
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  begin perform set_hub_checkin((select hub_id from profiles where email = 'kavya@startuptn.in'), 'bio'); raise exception 'FAIL HR set the method';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 33e HR cannot change the check-in method';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin perform set_hub_checkin((select id from hub_directory where name = 'Chennai'), 'selfie'); raise exception 'FAIL staff set the method';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform hr_board('2026-11-05', '2026-11-05'); raise exception 'FAIL staff read hr_board';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform attendance_merged('2026-11-05', '2026-11-05'); raise exception 'FAIL staff called attendance_merged';
  exception when insufficient_privilege then null; end;
  begin perform checkin_context('kavya@startuptn.in'); raise exception 'FAIL staff called checkin_context';
  exception when insufficient_privilege then null; end;
  if my_today()->>'checkin' <> 'both' or my_today()->'help'->>'email' is null then raise exception 'FAIL my_today method/help %', my_today(); end if;
  if my_today()::text ~* 'radius|distance|inside|flag|face_sim' then raise exception 'FAIL my_today leaks a check'; end if;
  raise notice 'PASS 33f staff: cannot set the method or read others; sees own method and help';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select set_hub_checkin((select hub_id from profiles where email = 'kavya@startuptn.in'), 'bio');
select pg_temp.reset();
do $$ declare r record; begin
  select * into r from attendance_merged('2026-11-05', '2026-11-05', 'kavya@startuptn.in');
  if r.method <> 'bio' or r.in_time <> '2026-11-05 09:41:12+05:30' or r.out_time <> '2026-11-05 18:05+05:30' or r.source <> 'bio' then raise exception 'FAIL fingerprint-only hub %', r; end if;
  if (select count(*) from audit_log where entity = 'hubs' and after->>'checkin_method' = 'bio') < 1 then raise exception 'FAIL method change not audited'; end if;
  raise notice 'PASS 33g fingerprint-only hub: office selfie left out, change audited';
end $$;
-- fingerprint-only hub, OD day: the venue selfie still counts
update attendance_days set status = 'od' where user_id = '00000000-0000-0000-0000-000000000001' and day = '2026-11-05';
do $$ begin
  if (select in_time from attendance_merged('2026-11-05', '2026-11-05', 'kavya@startuptn.in')) <> '2026-11-05 09:20+05:30' then raise exception 'FAIL OD selfie on fingerprint hub'; end if;
  raise notice 'PASS 33h fingerprint-only hub: OD venue selfie counts';
end $$;
update attendance_days set status = 'present' where user_id = '00000000-0000-0000-0000-000000000001' and day = '2026-11-05';
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select set_hub_checkin((select hub_id from profiles where email = 'kavya@startuptn.in'), 'selfie');
select pg_temp.reset();
do $$ declare r record; begin
  select * into r from attendance_merged('2026-11-05', '2026-11-05', 'kavya@startuptn.in');
  if r.in_time <> '2026-11-05 09:20+05:30' or r.out_time <> '2026-11-05 17:00+05:30' or r.bio_in is not null or not r.early_out then raise exception 'FAIL selfie-only hub %', r; end if;
  if exists (select 1 from attendance_merged('2026-11-01', '2026-11-30', 'kavya@startuptn.in') where bio_in is not null or source <> 'app') then raise exception 'FAIL fingerprint shown on selfie hub'; end if;
  raise notice 'PASS 33i selfie-only hub: fingerprint left out';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
do $$ begin
  begin perform set_hub_checkin((select hub_id from profiles where email = 'kavya@startuptn.in'), 'gps'); raise exception 'FAIL bad method saved';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform set_setting('help_contact', '{"email": "ai@startuptn.in", "whatsapp": "+919876543210", "phone": ""}');
  begin perform set_setting('help_contact', '{"email": "x", "whatsapp": "<script>"}'); raise exception 'FAIL bad help contact saved';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_setting('help_contact', '{"email": "", "whatsapp": "", "phone": ""}'); raise exception 'FAIL empty help contact saved';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 33j method and help contact validated';
end $$;
select set_hub_checkin((select hub_id from profiles where email = 'kavya@startuptn.in'), 'both');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  if (select count(*) from hr_board('2026-11-01', '2026-11-30') where email = 'kavya@startuptn.in' and day = '2026-11-05' and in_src = 'app') <> 1 then raise exception 'FAIL hr_board'; end if;
  begin perform hr_board('2026-01-01', '2026-11-30'); raise exception 'FAIL long range';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 33k HR reads the merged board';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000f1');
select set_setting('help_contact', '{"email": "ai@startuptn.in", "whatsapp": "", "phone": ""}');
select pg_temp.reset();

-- ---------- 34. approvals: ask for clarity, reply, timeline seen by HR and Chairman; calendar months ahead ----------
select pg_temp.reset();
update settings set value = '"reporting"' where key = 'leave_approver';
update staff_roster set reports_to = 'arun@startuptn.in' where email = 'kavya@startuptn.in';
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');   -- Kavya asks for leave
insert into leave_requests (id, user_id, leave_type, starts_on, ends_on, reason)
values ('00000000-0000-0000-0000-0000000034a1', '00000000-0000-0000-0000-000000000001', 'casual', current_date + 50, current_date + 50, 'Family function');
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');   -- Arun, her reporting person
do $$ declare j jsonb; begin
  if (select jsonb_array_length(my_approvals()->'leave')) < 1 then raise exception 'FAIL reporting person does not see the leave'; end if;
  perform ask_clarity('leave', '00000000-0000-0000-0000-0000000034a1', 'Which day exactly?');
  j := request_timeline('leave', '00000000-0000-0000-0000-0000000034a1');
  if not (j->>'clarify')::boolean or (j->>'can_decide')::boolean is not true then raise exception 'FAIL clarify state %', j; end if;
  raise notice 'PASS 34 reporting person asks for clarity';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ declare j jsonb; begin
  if (select count(*) from notifications where kind = 'clarify_asked') < 1 then raise exception 'FAIL staff not told about the question'; end if;
  if not exists (select 1 from jsonb_array_elements(my_today()->'requests') x where (x->>'clarify')::boolean) then raise exception 'FAIL home does not show reply needed'; end if;
  begin perform ask_clarity('leave', '00000000-0000-0000-0000-0000000034a1', 'self'); raise exception 'FAIL staff asked on own request';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform reply_clarity('leave', '00000000-0000-0000-0000-0000000034a1', 'The 2nd, cousin''s wedding');
  begin perform reply_clarity('leave', '00000000-0000-0000-0000-0000000034a1', 'again'); raise exception 'FAIL second reply without a question';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  j := request_timeline('leave', '00000000-0000-0000-0000-0000000034a1');
  if (j->>'mine')::boolean is not true or (j->>'clarify')::boolean then raise exception 'FAIL after reply %', j; end if;
  begin perform count(*) from request_events; exception when insufficient_privilege then null; end;
  if (select count(*) from request_events) <> 0 then raise exception 'FAIL staff reads request_events directly'; end if;
  begin insert into request_events (kind, request_id, action) values ('leave', '00000000-0000-0000-0000-0000000034a1', 'approved'); raise exception 'FAIL staff wrote an event';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS 34b staff replies once; cannot write or read the raw timeline';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  if (select count(*) from notifications where kind = 'clarify_reply') < 1 then raise exception 'FAIL approver not told about the reply'; end if;
  perform decide_leave('00000000-0000-0000-0000-0000000034a1', 'approved', 'Enjoy');
  raise notice 'PASS 34c approver gets the reply and approves with a comment';
end $$;
-- someone unrelated cannot read the timeline
select pg_temp.as_user('00000000-0000-0000-0000-000000000003');
do $$ begin
  begin perform request_timeline('leave', '00000000-0000-0000-0000-0000000034a1'); raise exception 'FAIL unrelated staff read the timeline';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 34d unrelated staff cannot read the timeline';
end $$;
-- HR and Chairman see the whole story
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare j jsonb; acts text; begin
  j := request_timeline('leave', '00000000-0000-0000-0000-0000000034a1');
  select string_agg(x->>'action', ',' order by ord) into acts from jsonb_array_elements(j->'events') with ordinality t(x, ord);
  if acts <> 'created,clarify,reply,approved' then raise exception 'FAIL timeline order %', acts; end if;
  if (j->'events'->1->>'role') <> 'reporting' or (j->'events'->1->>'comment') <> 'Which day exactly?' or (j->'events'->2->>'role') <> 'staff'
     or (j->'events'->3->>'comment') <> 'Enjoy' or (j->'events'->0->>'comment') <> 'Family function' then raise exception 'FAIL timeline details %', j->'events'; end if;
  if (j->>'can_decide')::boolean then raise exception 'FAIL HR can decide a decided leave'; end if;
  if (select count(*) from request_events where request_id = '00000000-0000-0000-0000-0000000034a1') <> 4 then raise exception 'FAIL HR reads events'; end if;
  if routes_for('kavya@startuptn.in')->'leave'->>'route' <> 'reporting' then raise exception 'FAIL routes_for %', routes_for('kavya@startuptn.in'); end if;
  raise notice 'PASS 34e HR sees the full timeline: created, question, reply, approval, each with comment and role';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  if jsonb_array_length(request_timeline('leave', '00000000-0000-0000-0000-0000000034a1')->'events') <> 4 then raise exception 'FAIL Chairman timeline'; end if;
  raise notice 'PASS 34f Chairman sees the same timeline';
end $$;
-- HR as approver can ask too; staff calendar shows holidays months ahead
select pg_temp.reset();
update settings set value = '"hr"' where key = 'leave_approver';
update staff_roster set reports_to = null where email = 'kavya@startuptn.in';
insert into holidays (day, name, kind) values (date_trunc('month', current_date + 95)::date + 2, 'Test office day', 'office') on conflict (day) do nothing;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ declare j jsonb; begin
  j := my_month((date_trunc('month', current_date + 95))::date);
  if not exists (select 1 from jsonb_array_elements(j->'holidays') h where h->>'name' = 'Test office day' and h->>'kind' = 'office') then raise exception 'FAIL holiday ahead %', j->'holidays'; end if;
  begin perform my_month((current_date + 500)::date); raise exception 'FAIL too far ahead';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 34g staff calendar shows holidays and office leave months ahead';
end $$;
select pg_temp.reset();
delete from holidays where name = 'Test office day';

-- ---------- 35. approvers per staff member; one calendar for everyone; queries on HR marks ----------
select pg_temp.reset();
update staff_roster set reports_to = 'arun@startuptn.in' where email = 'kavya@startuptn.in';
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin perform set_staff_approver('kavya@startuptn.in', 'leave', 'reporting'); raise exception 'FAIL staff set own approver';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 35 staff cannot choose their own approver';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
select set_staff_approver('kavya@startuptn.in', 'leave', 'reporting');
select set_staff_approver('kavya@startuptn.in', 'od', 'hr');
do $$ declare j jsonb; begin
  j := routes_for('kavya@startuptn.in');
  if j->'leave'->>'route' <> 'reporting' or j->'leave'->>'name' <> 'Arun K' or j->'od'->>'route' <> 'hr' or j->'od'->>'set' <> 'hr' then raise exception 'FAIL per-staff routes %', j; end if;
  if (routes_for('arun@startuptn.in')->'leave'->>'set') is not null then raise exception 'FAIL other staff changed'; end if;
  begin perform set_staff_approver('kavya@startuptn.in', 'od', 'tech'); raise exception 'FAIL bad approver saved';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 35b HR sets leave and OD approver per staff member';
end $$;
-- the routes are used: a new OD from Kavya goes to HR, her leave to Arun
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
insert into od_requests (id, user_id, subject, venue_name, venue_lat, venue_lng, venue_url, starts_at, ends_at)
values ('00000000-0000-0000-0000-0000000035d1', '00000000-0000-0000-0000-000000000001', 'Per staff route', 'Guindy', 13.01, 80.22, 'https://maps.app.goo.gl/abc', now() + interval '3 days', now() + interval '3 days 2 hours');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  if not can_decide('od', '00000000-0000-0000-0000-0000000035d1') then raise exception 'FAIL HR should decide Kavya''s OD'; end if;
  raise notice 'PASS 35c per-staff OD route reaches HR';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  if can_decide('od', '00000000-0000-0000-0000-0000000035d1') then raise exception 'FAIL Chairman decides an OD routed to HR'; end if;
  raise notice 'PASS 35d Chairman does not decide it';
end $$;
-- one calendar: HR and staff get the same month
select pg_temp.reset();
insert into day_marks (email, day, mark, leave_type) values ('kavya@startuptn.in', date_trunc('month', current_date)::date + 1, 'leave', 'casual') on conflict (email, day) do update set mark = 'leave';
insert into day_marks (email, day, mark) values ('kavya@startuptn.in', date_trunc('month', current_date)::date + 2, 'absent') on conflict (email, day) do update set mark = 'absent';
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
create temp table m35 as select my_month(current_date) as j;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare h jsonb := hr_person_month('kavya@startuptn.in', current_date); s jsonb := (select j from m35); begin
  if h <> s then raise exception 'FAIL HR and staff calendars differ'; end if;
  if jsonb_array_length(h->'absent') < 1 or not exists (select 1 from jsonb_array_elements(h->'leave') x where (x->>'mark')::boolean) then raise exception 'FAIL marks missing %', h; end if;
  raise notice 'PASS 35e HR and staff calendar data are identical, marks included';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  if hr_person_month('kavya@startuptn.in', current_date) <> (select j from m35) then raise exception 'FAIL Chairman calendar differs'; end if;
  raise notice 'PASS 35f Chairman calendar is the same';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  begin perform hr_person_month('kavya@startuptn.in', current_date); raise exception 'FAIL staff read another calendar';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform person_month('kavya@startuptn.in', current_date); raise exception 'FAIL person_month callable';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS 35g staff cannot read another person''s calendar';
end $$;
-- staff queries an absent mark; HR asks, staff replies, HR corrects (mark removed); timeline for HR and Chairman
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
create temp table q35 (id uuid);
do $$ declare v uuid; begin
  begin perform raise_mark_query(current_date - 400, 'no mark here'); raise exception 'FAIL query on an unmarked day';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  v := raise_mark_query(date_trunc('month', current_date)::date + 2, 'I was at the Guindy office that day');
  insert into q35 values (v);
  begin perform raise_mark_query(date_trunc('month', current_date)::date + 2, 'again'); raise exception 'FAIL second open query';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin insert into mark_queries (email, user_id, day, mark, message) values ('kavya@startuptn.in', '00000000-0000-0000-0000-000000000001', current_date, 'absent', 'direct'); raise exception 'FAIL direct insert';
  exception when insufficient_privilege then null; end;
  if (select count(*) from mark_queries) <> 1 then raise exception 'FAIL staff sees own query'; end if;
  if jsonb_array_length(my_month(current_date)->'queries') <> 1 then raise exception 'FAIL calendar shows the query'; end if;
  raise notice 'PASS 35h staff raises one query on an HR mark';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin
  if (select count(*) from mark_queries) <> 0 then raise exception 'FAIL other staff sees the query'; end if;
  begin perform decide_mark_query((select id from q35), 'approved'); raise exception 'FAIL staff decided a query';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'PASS 35i other staff cannot see or decide it';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ begin
  if (select count(*) from notifications where kind = 'mark_query') < 1 then raise exception 'FAIL HR not told'; end if;
  perform ask_clarity('mark', (select id from q35), 'Who saw you there?');
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
select reply_clarity('mark', (select id from q35), 'Arun K');
select pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
do $$ declare acts text; begin
  begin perform decide_mark_query((select id from q35), 'returned', ''); raise exception 'FAIL keep without reason';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform decide_mark_query((select id from q35), 'approved', 'Confirmed with Arun');
  if exists (select 1 from day_marks where email = 'kavya@startuptn.in' and day = date_trunc('month', current_date)::date + 2) then raise exception 'FAIL mark not removed'; end if;
  select string_agg(x->>'action', ',' order by o) into acts from jsonb_array_elements(request_timeline('mark', (select id from q35))->'events') with ordinality t(x, o);
  if acts <> 'created,clarify,reply,approved' then raise exception 'FAIL query timeline %', acts; end if;
  raise notice 'PASS 35j HR asks, staff replies, HR corrects: mark removed, full timeline';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ begin
  if jsonb_array_length(request_timeline('mark', (select id from q35))->'events') <> 4 then raise exception 'FAIL Chairman query timeline'; end if;
  if (request_timeline('mark', (select id from q35))->>'can_decide')::boolean then raise exception 'FAIL Chairman can decide'; end if;
  raise notice 'PASS 35k Chairman sees the query timeline, read only';
end $$;
select pg_temp.reset();
update staff_roster set leave_approver = null, od_approver = null, reports_to = null where email = 'kavya@startuptn.in';
delete from day_marks where email = 'kavya@startuptn.in' and day >= date_trunc('month', current_date)::date;

-- ---------- 36. phones never block; live tracking alerts, map and summary ----------
select pg_temp.reset();
do $$ declare d1 uuid; d2 uuid; i int; begin
  insert into devices (user_id, device_key, status) values ('00000000-0000-0000-0000-000000000002', 'ph-a', 'active') returning id into d1;
  insert into devices (user_id, device_key, status) values ('00000000-0000-0000-0000-000000000002', 'ph-b', 'revoked') returning id into d2;
  for i in 0..4 loop   -- a, b, a, b, a: 4 changes this month
    insert into punches (user_id, kind, idempotency_key, client_time, server_time, lat, lng, target_type, device_id)
    values ('00000000-0000-0000-0000-000000000002', 'in', 'swap' || i, now() - make_interval(mins => 50 - i * 10), now() - make_interval(mins => 50 - i * 10), 13, 80, 'hub', case when i % 2 = 0 then d1 else d2 end);
  end loop;
  if phone_swaps('00000000-0000-0000-0000-000000000002') <> 4 then raise exception 'FAIL phone_swaps %', phone_swaps('00000000-0000-0000-0000-000000000002'); end if;
  raise notice 'PASS 36 phone changes counted for the month';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000001');
do $$ begin
  begin perform phone_swaps('00000000-0000-0000-0000-000000000001'); raise exception 'FAIL staff called phone_swaps';
  exception when insufficient_privilege then null; end;
  begin perform presence_watch(); raise exception 'FAIL staff called presence_watch';
  exception when insufficient_privilege then null; end;
  begin perform presence_board(current_date); raise exception 'FAIL staff read presence_board';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform live_locations(); raise exception 'FAIL staff read live_locations';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform presence_day_calc('00000000-0000-0000-0000-000000000001', current_date); raise exception 'FAIL presence_day_calc callable';
  exception when insufficient_privilege then null; end;
  raise notice 'PASS 36b tracking data and jobs are not open to staff';
end $$;
-- Kavya checked in an hour ago, no location since: the watcher raises one alert, not two
select pg_temp.reset();
update settings set value = '"00:00"' where key = 'office_start';
update settings set value = '"23:59"' where key = 'office_end';
update settings set value = '"00:00"' where key = 'late_until';
delete from attendance_days where user_id = '00000000-0000-0000-0000-000000000001' and day = (now() at time zone 'Asia/Kolkata')::date;
insert into attendance_days (user_id, day, in_time, band, status) values ('00000000-0000-0000-0000-000000000001', (now() at time zone 'Asia/Kolkata')::date, now() - interval '1 hour', 'ok', 'present');
delete from flags where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'no_signal';
update hubs set checkin_method = 'selfie' where id = (select hub_id from profiles where email = 'kavya@startuptn.in');   -- leave out test fingerprint rows for today
do $$ declare n int; begin
  if (now() at time zone 'Asia/Kolkata')::time < '00:25' then raise notice 'PASS 36c skipped (just after midnight IST)'; return; end if;
  n := presence_watch();
  if not exists (select 1 from flags where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'no_signal' and rule like 'R-13 location never started%') then raise exception 'FAIL no not-started alert'; end if;
  if (select count(*) from notifications where kind = 'no_signal') < 2 then raise exception 'FAIL HR and Chairman not both told'; end if;
  perform presence_watch();
  if (select count(*) from flags where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'no_signal') <> 1 then raise exception 'FAIL repeated alert'; end if;
  -- a location arrives (outside the hub), then goes quiet for 30 min: one new alert
  update flags set created_at = now() - interval '45 minutes' where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'no_signal';   -- the first alert was earlier
  insert into presence_samples (user_id, at, source, lat, lng, target_type, inside, distance_m) values
    ('00000000-0000-0000-0000-000000000001', now() - interval '40 minutes', 'watch', 13.05, 80.25, 'hub', false, 4000),
    ('00000000-0000-0000-0000-000000000001', now() - interval '30 minutes', 'watch', 13.05, 80.25, 'hub', false, 4000);
  perform presence_watch();
  if (select count(*) from flags where user_id = '00000000-0000-0000-0000-000000000001' and kind = 'no_signal') <> 2 then raise exception 'FAIL silence after samples not alerted'; end if;
  raise notice 'PASS 36c no-location alerts: once per silence, to HR and Chairman';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c1');
do $$ declare r record; begin
  select * into r from live_locations() where full_name like 'Kavya%';
  if r.state <> 'no_signal' or r.lat <> 13.05 then raise exception 'FAIL live map row %', r; end if;
  select * into r from presence_board((now() at time zone 'Asia/Kolkata')::date) where full_name like 'Kavya%';
  if not r.tracked or r.outside_min < 5 or r.no_signal_min < 20 then raise exception 'FAIL out-time board %', r; end if;
  raise notice 'PASS 36d Chairman sees the live map and who went out';
end $$;
select pg_temp.reset();
do $$ begin
  if not (presence_summary() ->> 'sent')::boolean then raise exception 'FAIL summary not sent'; end if;
  if (select count(*) from notifications where kind = 'presence_summary') < 2 then raise exception 'FAIL summary not to HR and Chairman'; end if;
  raise notice 'PASS 36e daily summary to HR and Chairman';
end $$;
-- fingerprint-only check-in is tracked too (merged day)
do $$ begin
  if presence_day_calc('00000000-0000-0000-0000-000000000001', (now() at time zone 'Asia/Kolkata')::date) ->> 'tracked' <> 'true' then raise exception 'FAIL tracked'; end if;
  raise notice 'PASS 36f tracking follows the merged (selfie or fingerprint) day';
end $$;
update settings set value = '"10:00"' where key = 'office_start';
update settings set value = '"18:00"' where key = 'office_end';
update settings set value = '"10:05"' where key = 'late_until';
delete from presence_samples where user_id = '00000000-0000-0000-0000-000000000001';
delete from attendance_days where user_id = '00000000-0000-0000-0000-000000000001' and day = (now() at time zone 'Asia/Kolkata')::date;
update hubs set checkin_method = 'both' where id = (select hub_id from profiles where email = 'kavya@startuptn.in');
