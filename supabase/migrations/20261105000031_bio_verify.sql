-- Fingerprint accuracy (HR, 5 Nov): attendance decisions about people must be exact.
-- 1. eSSL treats staff codes without case (stn056 = STN056). We did not, so some punches were not linked.
--    Codes are now stored in upper case, existing rows included, and every join is exact on that.
-- 2. Verification against eSSL itself, three independent checks, shown to HR:
--    a. completeness: eSSL's own row count per day = rows stored here (the sync PC reports eSSL's counts)
--    b. linking: every stored punch belongs to a known eSSL person (no orphans)
--    c. result: our in / out per person per day = eSSL's own AttendanceLogs (eTimeTrackLite's in / out)

-- ---------- 1. one spelling per code ----------
update bio_punches set device_code = upper(device_code) where device_code <> upper(device_code);
update bio_people set device_code = upper(device_code) where device_code <> upper(device_code);

-- ---------- 2. what eSSL itself says ----------
create table bio_audit (            -- latest counts reported by the sync PC (eSSL's numbers, not ours)
  link_id uuid primary key references bio_links (id) on delete cascade,
  at timestamptz not null default now(),
  tables jsonb not null default '[]'    -- [{t, count, max_id, days: {"2026-11-05": 84}}]
);
create table bio_essl_days (        -- eTimeTrackLite's own in / out per person per day (AttendanceLogs)
  link_id uuid not null references bio_links (id) on delete cascade,
  device_code text not null,
  day date not null,
  in_hm text,                        -- 'HH:MM' or null
  out_hm text,
  status text,
  records text,                      -- eSSL's punch list for the day, as eSSL shows it
  updated_at timestamptz not null default now(),
  primary key (link_id, device_code, day)
);
alter table bio_audit enable row level security;
alter table bio_essl_days enable row level security;
create policy bio_audit_read on bio_audit for select using (sees_all());
create policy bio_essl_days_read on bio_essl_days for select using (sees_all());

-- ingest: codes in upper case; plus the audit block (counts + eSSL attendance) when the PC sends it
create or replace function public.bio_ingest(p_link uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_saved int := 0; v_sent int := coalesce(jsonb_array_length(p -> 'punches'), 0); v_days int := 0;
begin
  insert into bio_status (link_id, last_seen, info) values (p_link, now(), coalesce(p -> 'agent', '{}'))
  on conflict (link_id) do update set last_seen = now(), info = excluded.info;

  if jsonb_typeof(p -> 'devices') = 'array' then
    insert into bio_devices (link_id, essl_id, name, serial, kind, ip, last_ping, last_download, updated_at)
    select p_link, (d ->> 'id')::int, left(coalesce(nullif(d ->> 'name', ''), 'Device ' || (d ->> 'id')), 120),
           nullif(left(d ->> 'serial', 60), ''),
           case when d ->> 'kind' in ('biometric', 'mobile', 'manual') then d ->> 'kind' else 'biometric' end,
           nullif(left(d ->> 'ip', 60), ''), (d ->> 'last_ping')::timestamptz, (d ->> 'last_download')::timestamptz, now()
    from jsonb_array_elements(p -> 'devices') d where d ->> 'id' ~ '^\d{1,9}$'
    on conflict (link_id, essl_id) do update set name = excluded.name, serial = excluded.serial, kind = excluded.kind,
      ip = excluded.ip, last_ping = excluded.last_ping, last_download = excluded.last_download, updated_at = now()
    where (bio_devices.name, bio_devices.serial, bio_devices.kind, bio_devices.ip, bio_devices.last_ping, bio_devices.last_download)
      is distinct from (excluded.name, excluded.serial, excluded.kind, excluded.ip, excluded.last_ping, excluded.last_download);
  end if;

  if jsonb_typeof(p -> 'people') = 'array' then
    insert into bio_people (link_id, device_code, essl_code, essl_name)
    select distinct on (upper(left(x ->> 'code', 50))) p_link, upper(left(x ->> 'code', 50)), nullif(left(x ->> 'essl_code', 50), ''), nullif(left(x ->> 'name', 120), '')
    from jsonb_array_elements(p -> 'people') x where coalesce(x ->> 'code', '') <> ''
    on conflict (link_id, device_code) do update set essl_code = excluded.essl_code, essl_name = excluded.essl_name, updated_at = now()
    where (bio_people.essl_code, bio_people.essl_name) is distinct from (excluded.essl_code, excluded.essl_name);
    update bio_people bp set email = r.email, matched = 'auto', updated_at = now()
    from staff_roster r
    where bp.link_id = p_link and bp.matched <> 'manual' and bp.essl_code is not null
      and upper(replace(r.employee_code, ' ', '')) = upper(replace(bp.essl_code, ' ', ''))
      and bp.email is distinct from r.email;
  end if;

  if v_sent > 0 then
    with ins as (
      insert into bio_punches (link_id, essl_table, essl_log_id, essl_device_id, device_code, punched_at, direction, downloaded_at)
      select p_link, left(x ->> 't', 40), (x ->> 'id')::int, nullif(x ->> 'dev', '')::int, upper(left(x ->> 'code', 50)),
             (x ->> 'at')::timestamptz, nullif(left(x ->> 'dir', 20), ''), nullif(x ->> 'dl', '')::timestamptz
      from jsonb_array_elements(p -> 'punches') x
      where x ->> 't' ~ '^DeviceLogs(_\d{1,2}_\d{4})?$' and x ->> 'id' ~ '^\d{1,9}$' and coalesce(x ->> 'code', '') <> ''
        and coalesce(x ->> 'dev', '') ~ '^\d{0,9}$' and x ->> 'at' is not null
      on conflict (link_id, essl_table, essl_log_id) do nothing
      returning 1)
    select count(*) into v_saved from ins;
  end if;

  if jsonb_typeof(p -> 'audit') = 'object' then
    if jsonb_typeof(p -> 'audit' -> 'tables') = 'array' then
      insert into bio_audit (link_id, at, tables) values (p_link, now(), p -> 'audit' -> 'tables')
      on conflict (link_id) do update set at = now(), tables = excluded.tables;
    end if;
    if jsonb_typeof(p -> 'audit' -> 'attendance') = 'array' then
      with up as (
        insert into bio_essl_days (link_id, device_code, day, in_hm, out_hm, status, records, updated_at)
        select distinct on (upper(left(a ->> 'code', 50)), (a ->> 'day')::date)
               p_link, upper(left(a ->> 'code', 50)), (a ->> 'day')::date,
               lpad(substring(a ->> 'in' from '(\d{1,2}:\d{2})'), 5, '0'), lpad(substring(a ->> 'out' from '(\d{1,2}:\d{2})'), 5, '0'),
               left(a ->> 'status', 60), left(a ->> 'records', 600), now()
        from jsonb_array_elements(p -> 'audit' -> 'attendance') a
        where coalesce(a ->> 'code', '') <> '' and a ->> 'day' ~ '^\d{4}-\d{2}-\d{2}$'
        on conflict (link_id, device_code, day) do update set in_hm = excluded.in_hm, out_hm = excluded.out_hm,
          status = excluded.status, records = excluded.records, updated_at = now()
        returning 1)
      select count(*) into v_days from up;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'sent', v_sent, 'saved', v_saved, 'essl_days', v_days);
end $$;
revoke execute on function bio_ingest(uuid, jsonb) from public, anon, authenticated;
grant execute on function bio_ingest(uuid, jsonb) to service_role;

-- ---------- 3. the three checks, per day ----------
create or replace function public.bio_verify(p_from date, p_to date)
returns table (day date, essl_rows integer, stored_rows integer, orphans integer, compared integer,
               in_agree integer, out_agree integer, differ jsonb, essl_reported_at timestamptz)
language sql stable security invoker set search_path = public as $$
  with d as (select generate_series(p_from, least(p_to, p_from + 62), '1 day')::date as day),
  au as (select a.at, t.value as tb from bio_audit a cross join jsonb_array_elements(a.tables) t),
  src as (select (k.key)::date as day, sum((k.value #>> '{}')::int)::int as n, max(au.at) as at
          from au cross join jsonb_each(au.tb -> 'days') k group by 1),
  st as (select (b.punched_at at time zone 'Asia/Kolkata')::date as day, count(*)::int as n,
                count(*) filter (where pe.device_code is null)::int as orphan
         from bio_punches b left join bio_people pe on pe.link_id = b.link_id and pe.device_code = b.device_code
         where b.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and b.punched_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')
         group by 1),
  pts as (select b.link_id, b.device_code, (b.punched_at at time zone 'Asia/Kolkata')::date as day, b.punched_at
          from bio_punches b left join bio_devices dv on dv.link_id = b.link_id and dv.essl_id = b.essl_device_id
          where coalesce(dv.kind, 'biometric') = 'biometric'
            and b.punched_at >= (p_from::timestamp at time zone 'Asia/Kolkata') and b.punched_at < ((p_to + 1)::timestamp at time zone 'Asia/Kolkata')),
  ours as (select f.link_id, f.device_code, f.day, f.in_at,
                  (select max(x.punched_at) from pts x where x.link_id = f.link_id and x.device_code = f.device_code and x.day = f.day
                     and x.punched_at > f.in_at + make_interval(mins => bio_gap_min())) as out_at
           from (select link_id, device_code, day, min(punched_at) as in_at from pts group by 1, 2, 3) f),
  cmp as (select o.day, o.device_code, pe.essl_name, to_char(o.in_at at time zone 'Asia/Kolkata', 'HH24:MI') as our_in,
                 to_char(o.out_at at time zone 'Asia/Kolkata', 'HH24:MI') as our_out, e.in_hm, e.out_hm,
                 (e.in_hm = to_char(o.in_at at time zone 'Asia/Kolkata', 'HH24:MI')) as in_ok,
                 (case when o.out_at is not null then e.out_hm = to_char(o.out_at at time zone 'Asia/Kolkata', 'HH24:MI')
                       else e.out_hm is null or e.out_hm = e.in_hm
                         or to_timestamp(e.out_hm, 'HH24:MI')::time - to_timestamp(e.in_hm, 'HH24:MI')::time <= make_interval(mins => bio_gap_min()) end) as out_ok
          from ours o
          join bio_essl_days e on e.link_id = o.link_id and e.device_code = o.device_code and e.day = o.day
          left join bio_people pe on pe.link_id = o.link_id and pe.device_code = o.device_code)
  select d.day, src.n, coalesce(st.n, 0), coalesce(st.orphan, 0),
         (select count(*)::int from cmp where cmp.day = d.day),
         (select count(*)::int from cmp where cmp.day = d.day and cmp.in_ok),
         (select count(*)::int from cmp where cmp.day = d.day and cmp.out_ok),
         coalesce((select jsonb_agg(jsonb_build_object('code', cmp.device_code, 'name', cmp.essl_name, 'our_in', cmp.our_in, 'essl_in', cmp.in_hm,
                     'our_out', cmp.our_out, 'essl_out', cmp.out_hm) order by cmp.device_code)
                   from cmp where cmp.day = d.day and not (coalesce(cmp.in_ok, false) and coalesce(cmp.out_ok, false))), '[]'::jsonb),
         src.at
  from d left join src on src.day = d.day left join st on st.day = d.day
  order by d.day desc
$$;
revoke execute on function bio_verify(date, date) from public, anon;
grant execute on function bio_verify(date, date) to authenticated;
