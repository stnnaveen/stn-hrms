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
  if not (setting('chairman_away'))::boolean then raise exception 'FAIL away not set'; end if;
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
  if (setting('face_threshold'))::int <> 85 or setting('office_start') #>> '{}' <> '09:30' then raise exception 'FAIL setting not saved'; end if;
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
