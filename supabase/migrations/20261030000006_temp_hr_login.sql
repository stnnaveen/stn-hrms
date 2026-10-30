-- TEMPORARY HR login for testing (requested by Naveen, 30 Oct 2026). Remove before the pilot:
--   delete from staff_roster where email = 'naveenflop@gmail.com';  and deactivate the profile.
insert into staff_roster (email, full_name, role, hub_name)
values ('naveenflop@gmail.com', 'Naveen (test HR)', 'hr', null)
on conflict (email) do update set role = 'hr', full_name = excluded.full_name;

-- if the account already exists from an earlier attempt, make sure it is HR and active
update profiles set role = 'hr', active = true where email = 'naveenflop@gmail.com';
