-- Fingerprint report: add designation and staff code (for the HR sheet format: one row per staff, a column pair per date).
-- Return type changes, so both functions are dropped and made again with the same rules and access.
drop function if exists public.bio_report_json(date, date);
drop function if exists public.bio_report(date, date);

create or replace function public.bio_report(p_from date, p_to date)
returns table (day date, device_code text, essl_code text, essl_name text, email text, full_name text, hub text,
               status text, in_at timestamptz, out_at timestamptz, band text, punches integer, entries jsonb, note text,
               designation text, staff_code text)
language plpgsql stable security invoker set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_to date := least(p_to, (now() at time zone 'Asia/Kolkata')::date);
  v_gap int := bio_gap_min();
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'bad_range'; end if;
  if p_to - p_from > 92 then raise exception 'range_too_long'; end if;
  if v_to < p_from then return; end if;

  return query
  with link as (select l.id from bio_links l where l.revoked_at is null),
  ppl as (
    select bp.link_id, bp.device_code, bp.essl_code, bp.essl_name, bp.email, r.full_name, r.hub_name, pr.id as uid,
           coalesce(r.designation, pr.designation) as designation, coalesce(r.employee_code, pr.employee_code) as staff_code
    from bio_people bp
    join link on link.id = bp.link_id
    left join staff_roster r on r.email = bp.email
    left join profiles pr on pr.email = bp.email),
  days as (select g::date as d from generate_series(p_from, v_to, interval '1 day') g),
  raw as (
    select b.link_id, b.device_code, (b.punched_at at time zone 'Asia/Kolkata')::date as d, b.punched_at, b.direction,
           coalesce(dv.kind, 'biometric') as kind, dv.name as dev
    from bio_punches b
    join link on link.id = b.link_id
    left join bio_devices dv on dv.link_id = b.link_id and dv.essl_id = b.essl_device_id
    where b.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata')
      and b.punched_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata')),
  agg as (
    select x.link_id, x.device_code, x.d,
           min(x.punched_at) filter (where x.kind = 'biometric') as f,
           count(*)::int as n,
           count(*) filter (where x.kind <> 'biometric')::int as other,
           jsonb_agg(jsonb_build_object('at', x.punched_at, 'dir', x.direction, 'device', x.dev, 'kind', x.kind) order by x.punched_at) as e
    from raw x group by 1, 2, 3),
  grid as (
    select p.*, dd.d, a.f, a.n, a.other, a.e,
           (select max(x.punched_at) from raw x where x.link_id = p.link_id and x.device_code = p.device_code and x.d = dd.d
              and x.kind = 'biometric' and a.f is not null and x.punched_at > a.f + make_interval(mins => v_gap)) as l,
           (select h.name from holidays h where h.day = dd.d) as hol,
           (select dm.mark from day_marks dm where dm.email = p.email and dm.day = dd.d) as mark,
           exists (select 1 from leave_requests lr where lr.user_id = p.uid and lr.status = 'approved'
                     and dd.d between lr.starts_on and lr.ends_on) as on_leave,
           exists (select 1 from od_requests o where o.user_id = p.uid and o.status = 'approved'
                     and dd.d between (o.starts_at at time zone 'Asia/Kolkata')::date and (o.ends_at at time zone 'Asia/Kolkata')::date) as on_od
    from ppl p cross join days dd
    left join agg a on a.link_id = p.link_id and a.device_code = p.device_code and a.d = dd.d)
  select g.d, g.device_code, g.essl_code, g.essl_name, g.email, g.full_name, g.hub_name,
         case when g.f is not null then (case when g.l is null and g.d < v_today then 'no_out' else 'present' end)
              when g.hol is not null then 'holiday'
              when g.on_leave or g.mark = 'leave' then 'leave'
              when g.mark = 'absent' then 'absent'
              when g.on_od then 'od'
              when extract(isodow from g.d) in (6, 7) then 'week_off'
              else 'absent' end,
         g.f, g.l, case when g.f is null then null else band_at(g.f)::text end,
         coalesce(g.n, 0), coalesce(g.e, '[]'::jsonb),
         concat_ws(' · ', g.hol, case when g.mark = 'absent' then 'Marked absent by HR' end,
                   case when g.other > 0 then g.other || ' manual/mobile entr' || case when g.other = 1 then 'y' else 'ies' end || ' in eSSL' end),
         g.designation, g.staff_code
  from grid g
  order by g.d desc, coalesce(g.full_name, g.essl_name, g.device_code);
end $$;

revoke execute on function bio_report(date, date) from public, anon;
grant execute on function bio_report(date, date) to authenticated;

create or replace function public.bio_report_json(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.day desc, coalesce(r.full_name, r.essl_name, r.device_code)), '[]'::jsonb)
  from bio_report(p_from, p_to) r
$$;
revoke execute on function bio_report_json(date, date) from public, anon;
grant execute on function bio_report_json(date, date) to authenticated;
