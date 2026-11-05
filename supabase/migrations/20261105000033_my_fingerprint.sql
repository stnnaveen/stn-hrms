-- Staff app: a person's own fingerprint days (read only). Shows their own in / out times and colours, and month
-- figures with app and fingerprint days merged. Never radius, flags or anyone else's data (CLAUDE.md rule 2).
-- The app's check-in / check-out flow is unchanged.

-- internal: merged app + fingerprint days for one email (no auth check; callers check)
create or replace function public.person_days_merged(p_email text, p_from date, p_to date)
returns table (day date, band time_band, status text, early_out boolean, in_time timestamptz, out_time timestamptz, source text)
language sql stable security definer set search_path = public as $$
  with a as (
    select d.day, d.band, d.status, d.early_out, d.in_time, d.out_time
    from attendance_days d join profiles pr on pr.id = d.user_id
    where pr.email = lower(p_email) and d.day between p_from and p_to),
  b as (select * from bio_attendance(p_from, p_to) x where x.email = lower(p_email))
  select coalesce(a.day, b.day),
         case when a.status in ('od', 'leave') then a.band
              when a.in_time is not null and (b.in_at is null or a.in_time <= b.in_at) then a.band
              else b.band end,
         coalesce(a.status, 'present'),
         coalesce(a.early_out, false),
         least(a.in_time, b.in_at),
         greatest(a.out_time, b.out_at),
         case when a.day is not null and b.day is not null then 'both' when b.day is not null then 'bio' else 'app' end
  from a full join b on b.day = a.day
  order by 1
$$;
revoke execute on function person_days_merged(text, date, date) from public, anon, authenticated;

create or replace function public.hr_person_days(p_email text, p_from date, p_to date)
returns table (day date, band time_band, status text, early_out boolean, in_time timestamptz, out_time timestamptz, source text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return query select * from person_days_merged(p_email, p_from, p_to);
end $$;

create or replace function public.my_fingerprint() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_email text; v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_end text := coalesce(setting('office_end') #>> '{}', '18:00');
begin
  select email into v_email from profiles where id = auth.uid() and active;
  if v_email is null then raise exception 'not signed in'; end if;
  return jsonb_build_object(
    'today', (select jsonb_build_object('in_at', x.in_at, 'out_at', x.out_at, 'band', x.band)
              from bio_attendance(v_today, v_today) x where x.email = v_email),
    'month', (select jsonb_build_object(
                'on_time', count(*) filter (where m.band = 'ok' or m.status = 'od'),
                'late', count(*) filter (where m.band in ('warn', 'bad') and m.status <> 'od'),
                'early', count(*) filter (where m.early_out or (m.source = 'bio' and m.out_time is not null
                                  and to_char(m.out_time at time zone 'Asia/Kolkata', 'HH24:MI') < v_end)),
                'finger_days', count(*) filter (where m.source in ('bio', 'both')))
              from person_days_merged(v_email, date_trunc('month', v_today)::date, v_today) m
              where m.in_time is not null or m.status in ('od', 'leave')));
end $$;
revoke execute on function my_fingerprint() from public, anon;
grant execute on function my_fingerprint() to authenticated;
