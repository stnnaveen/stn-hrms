-- HR asks a reason for a late check-in or an early check-out (not only for disputes the server raised).
-- Reuses the dispute flow: a flag on that punch (created if the server didn't raise one) is set to
-- 'reason_asked', the staff member gets "Add a reason", answers with submit_flag_reason, HR decides.
-- Staff are told only about the time, never about checks (CLAUDE.md rule 2).
create or replace function public.ask_punch_reason(p_punch uuid, p_kind text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_p punches; v_flag uuid; v_when text;
begin
  if my_role() is distinct from 'hr' then raise exception 'only HR'; end if;
  if p_kind not in ('late', 'early_out') then raise exception 'late or early_out only'; end if;
  select * into v_p from punches where id = p_punch;
  if v_p.id is null then raise exception 'not_found'; end if;
  if (p_kind = 'late' and v_p.kind <> 'in') or (p_kind = 'early_out' and v_p.kind <> 'out') then raise exception 'wrong punch'; end if;
  select id into v_flag from flags where punch_id = p_punch and kind = p_kind::flag_kind order by created_at desc limit 1;
  if v_flag is null then
    insert into flags (punch_id, user_id, kind, rule, details, status)
    values (p_punch, v_p.user_id, p_kind::flag_kind, case when p_kind = 'late' then 'HR asked: late check-in' else 'HR asked: early check-out' end,
            jsonb_build_object('asked_by', auth.uid()), 'reason_asked')
    returning id into v_flag;
  else
    update flags set status = 'reason_asked' where id = v_flag and status in ('open', 'reason_asked');
  end if;
  v_when := to_char(v_p.server_time at time zone 'Asia/Kolkata', 'DD Mon, HH12:MI AM');
  insert into notifications (user_id, kind, title, body, data)
  values (v_p.user_id, 'reason_asked', 'Add a reason',
          case when p_kind = 'late' then 'For your late check-in on ' else 'For leaving early on ' end || v_when,
          jsonb_build_object('flag_id', v_flag));
  return v_flag;
end $$;
revoke execute on function ask_punch_reason(uuid, text) from public, anon;
grant execute on function ask_punch_reason(uuid, text) to authenticated;
