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
insert into auth.users values ('00000000-0000-0000-0000-0000000000c7','naveenbackup7@gmail.com');
do $$ begin if (select role from profiles where email='naveenbackup7@gmail.com') <> 'chairman' then raise exception 'FAIL temp chairman role'; end if;
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
select add_role_login('NewHR@StartupTN.in', 'New HR', 'hr');
select set_setting('face_threshold', '85');
select set_setting('office_start', '"09:30"');
select decide_device('00000000-0000-0000-0000-00000000de02', true);
do $$ begin
  if (select role from staff_roster where email = 'newhr@startuptn.in') <> 'hr' then raise exception 'FAIL role login not added'; end if;
  if ((select value from settings where key='face_threshold'))::int <> 85 or (select value from settings where key='office_start') #>> '{}' <> '09:30' then raise exception 'FAIL setting not saved'; end if;
  begin perform set_setting('face_threshold', '10'); raise exception 'FAIL bad value saved'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  begin perform set_setting('chairman_away', 'true'); raise exception 'FAIL tech set chairman away'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  if (select status from devices where device_key = 'new-phone') <> 'active' or (select status from devices where device_key = 'old-phone') <> 'revoked' then raise exception 'FAIL phone switch'; end if;
  if not (verify_audit_chain() ->> 'ok')::boolean then raise exception 'FAIL audit chain broken'; end if;
  begin perform remove_role_login('ai@startuptn.in'); raise exception 'FAIL removed own login'; exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  perform remove_role_login('naveenbackup7@gmail.com');
  raise notice 'PASS 13b Tech adds logins, tunes rules, approves phones, checks audit';
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-000000000002');
do $$ begin if not exists (select 1 from notifications where kind = 'device_ok') then raise exception 'FAIL staff not told'; end if; raise notice 'PASS 13d staff told the new phone is approved'; end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000000c7');
do $$ begin
  if my_role() is not null or sees_all() then raise exception 'FAIL removed login still has access'; end if;
  raise notice 'PASS 13c removed login loses access at once';
end $$;

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
