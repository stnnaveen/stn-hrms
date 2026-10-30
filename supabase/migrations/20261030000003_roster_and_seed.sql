-- Staff roster: HR loads people here (from the staff CSV). Only emails on the roster can sign in;
-- the first sign-in creates the auth user and this trigger turns it into a profile.

create table staff_roster (
  email text primary key check (email = lower(email)),
  full_name text not null,
  role app_role not null default 'staff',
  hub_name text references hubs (name) on update cascade,
  employee_code text unique,
  phone text,
  joined_on date,
  created_at timestamptz not null default now()
);
alter table staff_roster enable row level security;
create policy roster_read on staff_roster for select using (sees_all());
create policy roster_write on staff_roster for all using (is_hr_or_tech()) with check (is_hr_or_tech());
create trigger audit_staff_roster after insert or update or delete on staff_roster for each row execute function audit_row();

-- role accounts on the roster may only be added or changed by the Tech admin (PRD TA-07)
create or replace function public.guard_roster_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.role in ('hr', 'chairman', 'tech') and coalesce(my_role() <> 'tech', true)
     and (tg_op = 'INSERT' or new.role is distinct from old.role) then
    raise exception 'only the Tech admin can add role accounts';
  end if;
  return new;
end $$;
create trigger roster_guard_role before insert or update on staff_roster for each row execute function guard_roster_role();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r staff_roster;
begin
  select * into r from staff_roster where email = lower(new.email);
  if r.email is null then
    raise exception 'not_on_roster' using errcode = 'P0001';
  end if;
  insert into profiles (id, email, full_name, role, hub_id, employee_code, phone, joined_on)
  values (new.id, r.email, r.full_name, r.role, (select id from hubs where name = r.hub_name), r.employee_code, r.phone, r.joined_on)
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function handle_new_user(), guard_roster_role() from public, anon, authenticated;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Hubs: PLACEHOLDER coordinates (city centres). HR must replace each with the real hub pin before the pilot.
insert into hubs (name, lat, lng) values
  ('Chennai', 13.0827, 80.2707), ('Coimbatore', 11.0168, 76.9558), ('Madurai', 9.9252, 78.1198),
  ('Salem', 11.6643, 78.1460), ('Trichy', 10.7905, 78.7047), ('Erode', 11.3410, 77.7172),
  ('Hosur', 12.7409, 77.8253), ('Tirunelveli', 8.7139, 77.7567), ('Thoothukudi', 8.7642, 78.1348),
  ('Villupuram', 11.9401, 79.4861)
on conflict (name) do nothing;

-- The three role logins (PRD TA-07) and one staff account for testing
insert into staff_roster (email, full_name, role, hub_name) values
  ('hr@startuptn.in', 'HR team', 'hr', null),
  ('chairmanoffice@startuptn.in', 'Chairman', 'chairman', null),
  ('ai@startuptn.in', 'Tech admin', 'tech', null),
  ('naveen@startuptn.in', 'Naveen', 'staff', 'Chennai')
on conflict (email) do nothing;
