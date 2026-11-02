-- TEMPORARY demo logins for HR and Chairman (requested by Naveen, 2 Nov 2026). They sign in with a fixed
-- test code (set on the account by the Tech admin tool, never stored here). Remove before the pilot:
--   select remove_role_login('hr.ai@startuptn.in'); select remove_role_login('chairman.ai@startuptn.in');
insert into staff_roster (email, full_name, role, hub_name)
values ('hr.ai@startuptn.in', 'HR (demo)', 'hr', null),
       ('chairman.ai@startuptn.in', 'Chairman (demo)', 'chairman', null)
on conflict (email) do update set role = excluded.role, full_name = excluded.full_name;
update profiles set role = 'hr', active = true where email = 'hr.ai@startuptn.in';
update profiles set role = 'chairman', active = true where email = 'chairman.ai@startuptn.in';
