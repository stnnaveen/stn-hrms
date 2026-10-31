-- 1. HR "Delete" now removes the person completely: account, check-ins (photos removed by the edge function),
--    disputes, OD, leave, notifications, phones and the roster entry. The same email can then be added again
--    and starts fresh. Deactivate stays the way to keep history for someone who left.
--    audit_log is never touched (CLAUDE.md rule 6); the delete itself is logged with the counts.
create or replace function public.delete_staff_full(p_email text) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_email text := lower(trim(p_email));
  v_id uuid; v_role app_role; v_roster_role app_role; v_keys text[];
  n_p int := 0; n_o int := 0; n_l int := 0; n_f int := 0;
begin
  if not is_hr_or_tech() then raise exception 'not allowed'; end if;
  select id, role into v_id, v_role from profiles where email = v_email;
  select role into v_roster_role from staff_roster where email = v_email;
  if v_id is null and v_roster_role is null then raise exception 'not_found'; end if;
  if coalesce(v_role, v_roster_role) in ('hr', 'chairman', 'tech') then raise exception 'role_account'; end if;
  if v_id = auth.uid() then raise exception 'not_yourself'; end if;
  if v_id is not null then
    select count(*), array_agg(selfie_key) filter (where selfie_key is not null) into n_p, v_keys from punches where user_id = v_id;
    select count(*) into n_o from od_requests where user_id = v_id;
    select count(*) into n_l from leave_requests where user_id = v_id;
    select count(*) into n_f from flags where user_id = v_id;
    delete from flags where user_id = v_id;
    delete from attendance_days where user_id = v_id;
    delete from punches where user_id = v_id;
    delete from od_requests where user_id = v_id;
    delete from leave_requests where user_id = v_id;
    delete from notifications where user_id = v_id;
    delete from devices where user_id = v_id;
    delete from auth.users where id = v_id;   -- cascades to the profile
  end if;
  delete from staff_roster where email = v_email;
  perform append_audit('delete_person', 'profiles', v_email, null,
    jsonb_build_object('had_account', v_id is not null, 'checkins', n_p, 'od', n_o, 'leave', n_l, 'flags', n_f));
  return jsonb_build_object('checkins', n_p, 'od', n_o, 'leave', n_l, 'flags', n_f, 'selfie_keys', to_jsonb(coalesce(v_keys, '{}')));
end $$;
revoke execute on function delete_staff_full(text) from public, anon;
grant execute on function delete_staff_full(text) to authenticated;

-- 2. Tech removes one selfie (wrong person, privacy request, test photo). The check-in time and place stay;
--    the photo is deleted by the edge function and the punch remembers who removed it and why.
alter table punches add column if not exists selfie_removed jsonb;
create or replace function public.remove_selfie(p_punch uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare v_key text; v_user uuid;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason_needed'; end if;
  select selfie_key, user_id into v_key, v_user from punches where id = p_punch for update;
  if v_key is null then raise exception 'no_selfie'; end if;
  update punches set selfie_key = null,
    selfie_removed = jsonb_build_object('by', auth.uid(), 'at', now(), 'reason', left(trim(p_reason), 200)) where id = p_punch;
  perform append_audit('remove_selfie', 'punches', p_punch::text, jsonb_build_object('selfie_key', v_key),
    jsonb_build_object('user_id', v_user, 'reason', left(trim(p_reason), 200)));
  return v_key;
end $$;
revoke execute on function remove_selfie(uuid, text) from public, anon;
grant execute on function remove_selfie(uuid, text) to authenticated;
