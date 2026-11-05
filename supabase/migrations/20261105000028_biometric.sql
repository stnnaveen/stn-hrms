-- Biometric link: eSSL eTimeTrackLite (on an office PC) -> StartupTN HR, every 30 seconds.
-- A sync program on the eSSL PC reads new punch rows from its own database and POSTs them to the bio-sync edge
-- function with a link key. Nothing connects into the office. The key is shown once to the Tech admin; only its
-- SHA-256 hash is stored here. Fingerprint punches are evidence only for now: they do not change attendance yet.

create table bio_links (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  key_hash text not null unique,
  created_by uuid references profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- heartbeat from the sync PC (updated every 30 s, so kept out of the audit log)
create table bio_status (
  link_id uuid primary key references bio_links (id) on delete cascade,
  last_seen timestamptz not null default now(),
  info jsonb not null default '{}'
);

create table bio_devices (
  link_id uuid not null references bio_links (id) on delete cascade,
  essl_id integer not null,
  name text not null,
  serial text,
  kind text not null default 'biometric' check (kind in ('biometric', 'mobile', 'manual')),
  hub_id uuid references hubs (id) on delete set null,
  ip text,
  last_ping timestamptz,
  last_download timestamptz,
  updated_at timestamptz not null default now(),
  primary key (link_id, essl_id)
);

-- eSSL person -> our staff list. Exact employee-code match links automatically; the rest are matched by Tech/HR.
create table bio_people (
  link_id uuid not null references bio_links (id) on delete cascade,
  device_code text not null,
  essl_code text,
  essl_name text,
  email text references staff_roster (email) on update cascade on delete set null,
  matched text not null default 'none' check (matched in ('auto', 'manual', 'none')),
  updated_at timestamptz not null default now(),
  primary key (link_id, device_code)
);

create table bio_punches (
  id bigint generated always as identity primary key,
  link_id uuid not null references bio_links (id) on delete cascade,
  essl_table text not null,
  essl_log_id integer not null,
  essl_device_id integer,
  device_code text not null,
  punched_at timestamptz not null,
  direction text,
  downloaded_at timestamptz,
  received_at timestamptz not null default now(),
  unique (link_id, essl_table, essl_log_id)
);
create index on bio_punches (punched_at desc);
create index on bio_punches (link_id, device_code, punched_at desc);

-- ---------- row-level security: HR, Chairman and Tech read; nobody writes directly ----------
alter table bio_links enable row level security;
alter table bio_status enable row level security;
alter table bio_devices enable row level security;
alter table bio_people enable row level security;
alter table bio_punches enable row level security;
create policy bio_links_read on bio_links for select using (is_hr_or_tech());
create policy bio_status_read on bio_status for select using (sees_all());
create policy bio_devices_read on bio_devices for select using (sees_all());
create policy bio_people_read on bio_people for select using (sees_all());
create policy bio_punches_read on bio_punches for select using (sees_all());

-- ---------- audit (rule 6): links, device hub and person matching; not the 30-second heartbeat ----------
create trigger audit_bio_links after insert or update or delete on bio_links for each row execute function audit_row();
create trigger audit_bio_devices_ins after insert or delete on bio_devices for each row execute function audit_row();
create trigger audit_bio_devices_upd after update of hub_id, name, kind, serial on bio_devices for each row execute function audit_row();
create trigger audit_bio_people_ins after insert or delete on bio_people for each row execute function audit_row();
create trigger audit_bio_people_upd after update of email, matched on bio_people for each row execute function audit_row();

-- ---------- Tech admin: a new link key (shown once). Revokes any earlier key with the same name. ----------
create or replace function public.bio_new_key(p_name text default 'Chennai office')
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_key text; v_name text := coalesce(nullif(trim(p_name), ''), 'Chennai office');
begin
  if coalesce(my_role() <> 'tech', true) then raise exception 'only the Tech admin can create a biometric link key'; end if;
  v_key := 'stnbio_' || encode(gen_random_bytes(32), 'hex');
  update bio_links set revoked_at = now() where name = v_name and revoked_at is null;
  insert into bio_links (name, key_hash, created_by) values (v_name, encode(digest(v_key, 'sha256'), 'hex'), auth.uid());
  return v_key;
end $$;
revoke execute on function bio_new_key(text) from public, anon;
grant execute on function bio_new_key(text) to authenticated;

create or replace function public.bio_revoke(p_link uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(my_role() <> 'tech', true) then raise exception 'only the Tech admin can revoke a biometric link'; end if;
  update bio_links set revoked_at = now() where id = p_link and revoked_at is null;
end $$;
revoke execute on function bio_revoke(uuid) from public, anon;
grant execute on function bio_revoke(uuid) to authenticated;

-- ---------- Tech/HR: which hub a device sits in, and which staff member an eSSL code is ----------
create or replace function public.bio_set_device_hub(p_link uuid, p_device integer, p_hub uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_hr_or_tech() then raise exception 'not allowed'; end if;
  update bio_devices set hub_id = p_hub, updated_at = now() where link_id = p_link and essl_id = p_device;
  if not found then raise exception 'device not found'; end if;
end $$;
revoke execute on function bio_set_device_hub(uuid, integer, uuid) from public, anon;
grant execute on function bio_set_device_hub(uuid, integer, uuid) to authenticated;

create or replace function public.bio_match_person(p_link uuid, p_device_code text, p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
begin
  if not is_hr_or_tech() then raise exception 'not allowed'; end if;
  if v_email is not null and not exists (select 1 from staff_roster where email = v_email) then raise exception 'not on the staff list'; end if;
  update bio_people set email = v_email, matched = case when v_email is null then 'none' else 'manual' end, updated_at = now()
  where link_id = p_link and device_code = p_device_code;
  if not found then raise exception 'code not found'; end if;
end $$;
revoke execute on function bio_match_person(uuid, text, text) from public, anon;
grant execute on function bio_match_person(uuid, text, text) to authenticated;

-- ---------- ingest (internal: called only by the bio-sync edge function with the service role) ----------
create or replace function public.bio_ingest(p_link uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_saved int := 0; v_sent int := coalesce(jsonb_array_length(p -> 'punches'), 0);
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
    select distinct on (left(x ->> 'code', 50)) p_link, left(x ->> 'code', 50), nullif(left(x ->> 'essl_code', 50), ''), nullif(left(x ->> 'name', 120), '')
    from jsonb_array_elements(p -> 'people') x where coalesce(x ->> 'code', '') <> ''
    on conflict (link_id, device_code) do update set essl_code = excluded.essl_code, essl_name = excluded.essl_name, updated_at = now()
    where (bio_people.essl_code, bio_people.essl_name) is distinct from (excluded.essl_code, excluded.essl_name);
    -- exact employee-code match (ignoring case and spaces) links automatically; manual matches are never overwritten
    update bio_people bp set email = r.email, matched = 'auto', updated_at = now()
    from staff_roster r
    where bp.link_id = p_link and bp.matched <> 'manual' and bp.essl_code is not null
      and upper(replace(r.employee_code, ' ', '')) = upper(replace(bp.essl_code, ' ', ''))
      and bp.email is distinct from r.email;
  end if;

  if v_sent > 0 then
    with ins as (
      insert into bio_punches (link_id, essl_table, essl_log_id, essl_device_id, device_code, punched_at, direction, downloaded_at)
      select p_link, left(x ->> 't', 40), (x ->> 'id')::int, nullif(x ->> 'dev', '')::int, left(x ->> 'code', 50),
             (x ->> 'at')::timestamptz, nullif(left(x ->> 'dir', 20), ''), nullif(x ->> 'dl', '')::timestamptz
      from jsonb_array_elements(p -> 'punches') x
      where x ->> 't' ~ '^DeviceLogs(_\d{1,2}_\d{4})?$' and x ->> 'id' ~ '^\d{1,9}$' and coalesce(x ->> 'code', '') <> ''
        and coalesce(x ->> 'dev', '') ~ '^\d{0,9}$' and x ->> 'at' is not null
      on conflict (link_id, essl_table, essl_log_id) do nothing
      returning 1)
    select count(*) into v_saved from ins;
  end if;
  return jsonb_build_object('ok', true, 'sent', v_sent, 'saved', v_saved);
end $$;
revoke execute on function bio_ingest(uuid, jsonb) from public, anon, authenticated;
grant execute on function bio_ingest(uuid, jsonb) to service_role;

-- ---------- HR / Chairman / Tech read ----------
-- fingerprint punches for one day, with the staff member when matched
create or replace function public.bio_day(p_day date default ((now() at time zone 'Asia/Kolkata')::date))
returns table (punched_at timestamptz, direction text, device text, hub text, device_code text, essl_name text, email text, full_name text, user_id uuid)
language sql stable security invoker set search_path = public as $$
  select b.punched_at, b.direction, d.name, h.name, b.device_code, bp.essl_name, bp.email, coalesce(r.full_name, bp.essl_name), pr.id
  from bio_punches b
  left join bio_devices d on d.link_id = b.link_id and d.essl_id = b.essl_device_id
  left join hubs h on h.id = d.hub_id
  left join bio_people bp on bp.link_id = b.link_id and bp.device_code = b.device_code
  left join staff_roster r on r.email = bp.email
  left join profiles pr on pr.email = bp.email
  where b.punched_at >= (p_day::timestamp at time zone 'Asia/Kolkata')
    and b.punched_at < ((p_day + 1)::timestamp at time zone 'Asia/Kolkata')
  order by b.punched_at desc
$$;
revoke execute on function bio_day(date) from public, anon;
grant execute on function bio_day(date) to authenticated;

-- one person's fingerprint punches, last N days (HR person view)
create or replace function public.bio_person(p_user uuid, p_days integer default 31)
returns table (punched_at timestamptz, direction text, device text)
language sql stable security invoker set search_path = public as $$
  select b.punched_at, b.direction, d.name
  from profiles pr
  join bio_people bp on bp.email = pr.email
  join bio_punches b on b.link_id = bp.link_id and b.device_code = bp.device_code
  left join bio_devices d on d.link_id = b.link_id and d.essl_id = b.essl_device_id
  where pr.id = p_user and b.punched_at >= now() - make_interval(days => least(greatest(p_days, 1), 120))
  order by b.punched_at desc
$$;
revoke execute on function bio_person(uuid, integer) from public, anon;
grant execute on function bio_person(uuid, integer) to authenticated;
