-- HR can delete a staff entry added by mistake. People with any attendance, OD or leave records
-- cannot be deleted (that history must stay); deactivate them instead. Role accounts belong to the Tech admin.
create or replace function public.delete_staff(p_email text) returns text
language plpgsql security definer set search_path = public, auth as $$
declare
  v_email text := lower(trim(p_email));
  v_id uuid;
  v_role app_role;
  v_roster_role app_role;
  n int;
begin
  if not is_hr_or_tech() then raise exception 'not allowed'; end if;
  select id, role into v_id, v_role from profiles where email = v_email;
  select role into v_roster_role from staff_roster where email = v_email;
  if coalesce(v_role, v_roster_role) in ('hr', 'chairman', 'tech') and my_role() <> 'tech' then
    raise exception 'role accounts are managed by the Tech admin';
  end if;
  if v_id is not null then
    select (select count(*) from punches where user_id = v_id)
         + (select count(*) from od_requests where user_id = v_id)
         + (select count(*) from leave_requests where user_id = v_id) into n;
    if n > 0 then raise exception 'has_records'; end if;
    delete from auth.users where id = v_id;   -- cascades to profile, devices, notifications
  end if;
  delete from staff_roster where email = v_email;
  perform append_audit('delete_staff', 'staff_roster', v_email, null, jsonb_build_object('had_account', v_id is not null));
  return 'deleted';
end $$;
revoke execute on function delete_staff(text) from public, anon;
grant execute on function delete_staff(text) to authenticated;
