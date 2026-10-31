-- Security review, 31 Oct 2026.
-- 1. Signed-out visitors (anon key) need no database functions or tables at all; sign-in runs inside Supabase Auth.
--    Postgres gives every new function to PUBLIC (which includes anon), so: take it from PUBLIC and anon,
--    give it to signed-in users and the server, then take back the internal ones below.
--    From now on a new RPC needs an explicit "grant execute ... to authenticated" (safe default: not callable).
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema public revoke all on tables from anon;
-- internal: trigger functions and server-only helpers are never called by users
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.prorettype = 'trigger'::regtype
             or p.proname in ('append_audit', 'notify_role', 'handle_new_user', 'sync_roster_to_profile'))
  loop execute format('revoke execute on function %s from authenticated', f.sig); end loop;
end $$;

-- 2. setting() returned any rule value (face threshold, radius defaults) to whoever called it. Staff must never
--    learn the checks (CLAUDE.md rule 2); only server-side functions use it now.
revoke execute on function setting(text) from public, anon, authenticated;

-- 3. Test-account helpers are server-side only (the check-in function and my_today use them)
revoke execute on function is_test_user(uuid) from public, anon, authenticated;
revoke execute on function is_test_mode(uuid) from public, anon, authenticated;
grant execute on function is_test_user(uuid), is_test_mode(uuid) to service_role;

-- 4. Only the Tech admin may mark someone as test staff or switch test mode. HR could otherwise flag a real
--    person as test, hiding them from the numbers and letting them clear their own attendance.
create or replace function public.guard_roster_test() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and coalesce(my_role() <> 'tech', true)
     and ((tg_op = 'INSERT' and (new.is_test or not new.test_mode))
       or (tg_op = 'UPDATE' and (new.is_test is distinct from old.is_test or new.test_mode is distinct from old.test_mode))) then
    raise exception 'only the Tech admin can change test accounts';
  end if;
  return new;
end $$;
revoke execute on function guard_roster_test() from public, anon, authenticated;
create trigger roster_guard_test before insert or update on staff_roster for each row execute function guard_roster_test();
