-- TEMPORARY Chairman login for testing (requested by Naveen, 30 Oct 2026). Remove before the pilot:
--   delete from staff_roster where email = 'naveenbackup7@gmail.com';  and deactivate the profile.
insert into staff_roster (email, full_name, role, hub_name)
values ('naveenbackup7@gmail.com', 'Chairman (test)', 'chairman', null)
on conflict (email) do update set role = 'chairman', full_name = excluded.full_name;
update profiles set role = 'chairman', active = true where email = 'naveenbackup7@gmail.com';
