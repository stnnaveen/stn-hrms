-- Staff app calendar: a person's own month — punch in / out (app and fingerprint merged, with the on-time colour),
-- OD and leave. Nothing else: no radius, distance, flags or face scores (CLAUDE.md rule 2).
create or replace function public.my_month(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_email text;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date := date_trunc('month', coalesce(p_month, v_today))::date;
  v_to date := least((date_trunc('month', coalesce(p_month, v_today)) + interval '1 month - 1 day')::date, v_today + 60);
begin
  select email into v_email from profiles where id = v_uid and active;
  if v_email is null then raise exception 'not signed in'; end if;
  if v_from < (date_trunc('month', v_today) - interval '12 months')::date then raise exception 'too far back'; end if;
  return jsonb_build_object(
    'month', to_char(v_from, 'YYYY-MM'),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', m.day, 'in', m.in_time, 'out', m.out_time, 'band', m.band) order by m.day)
                      from person_days_merged(v_email, v_from, least(v_to, v_today)) m where m.in_time is not null), '[]'::jsonb),
    'od', coalesce((select jsonb_agg(jsonb_build_object('subject', o.subject, 'venue', o.venue_name, 'starts_at', o.starts_at, 'ends_at', o.ends_at, 'status', o.status) order by o.starts_at)
                    from od_requests o where o.user_id = v_uid and o.status in ('approved', 'pending')
                      and o.starts_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata') and o.ends_at >= (v_from::timestamp at time zone 'Asia/Kolkata')), '[]'::jsonb),
    'leave', coalesce((select jsonb_agg(jsonb_build_object('type', l.leave_type, 'from', l.starts_on, 'to', l.ends_on, 'half_day', l.half_day, 'status', l.status) order by l.starts_on)
                       from leave_requests l where l.user_id = v_uid and l.status in ('approved', 'pending')
                         and l.starts_on <= v_to and l.ends_on >= v_from), '[]'::jsonb));
end $$;
revoke execute on function my_month(date) from public, anon;
grant execute on function my_month(date) to authenticated;
