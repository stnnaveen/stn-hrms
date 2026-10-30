-- Designation for staff (HR enters it when adding staff; shown on lists and profiles)
alter table staff_roster add column if not exists designation text;
alter table profiles add column if not exists designation text;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r staff_roster;
begin
  select * into r from staff_roster where email = lower(new.email);
  if r.email is null then
    raise exception 'not_on_roster' using errcode = 'P0001';
  end if;
  insert into profiles (id, email, full_name, role, hub_id, employee_code, phone, joined_on, designation)
  values (new.id, r.email, r.full_name, r.role, (select id from hubs where name = r.hub_name), r.employee_code, r.phone, r.joined_on, r.designation)
  on conflict (id) do nothing;
  return new;
end $$;
revoke execute on function handle_new_user() from public, anon, authenticated;

-- keep an existing profile in step when HR edits the roster row (designation, hub, phone, code)
create or replace function public.sync_roster_to_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles set designation = new.designation, phone = new.phone, employee_code = new.employee_code,
    full_name = new.full_name, hub_id = (select id from hubs where name = new.hub_name)
  where email = new.email;
  return new;
end $$;
revoke execute on function sync_roster_to_profile() from public, anon, authenticated;
create trigger roster_sync_profile after update on staff_roster for each row execute function sync_roster_to_profile();
