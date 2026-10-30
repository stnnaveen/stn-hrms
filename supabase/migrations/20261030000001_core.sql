-- StartupTN HR · core schema (v1 PWA and v2 store apps share this backend)
-- Rule: anything that decides attendance is computed on the server. Staff never see radius, distance or flags.

create extension if not exists pgcrypto;

-- ---------- enums ----------
create type app_role as enum ('staff', 'intern', 'hr', 'chairman', 'tech');
create type punch_kind as enum ('in', 'out');
create type time_band as enum ('ok', 'warn', 'bad');
create type request_status as enum ('pending', 'approved', 'returned', 'cancelled');
create type flag_kind as enum ('late', 'radius', 'location_changer', 'mock_location', 'face', 'liveness', 'device', 'clock', 'offline', 'jump', 'early_out');
create type flag_status as enum ('open', 'reason_asked', 'valid', 'violation', 'false_flag');

-- ---------- reference data ----------
create table hubs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  radius_m integer not null default 500 check (radius_m between 50 and 5000),
  maps_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table custom_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  login_email text unique,
  permissions text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  full_name text not null,
  employee_code text unique,
  phone text,
  role app_role not null default 'staff',
  custom_role_id uuid references custom_roles (id),
  hub_id uuid references hubs (id),
  joined_on date,
  active boolean not null default true,
  face_status text not null default 'none' check (face_status in ('none', 'pending', 'approved')),
  reference_photo_key text,
  consent_at timestamptz,
  created_at timestamptz not null default now()
);
create index on profiles (hub_id);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

insert into settings (key, value) values
  ('office_start', '"10:00"'),
  ('late_until', '"10:15"'),
  ('office_end', '"18:00"'),
  ('face_threshold', '80'),
  ('default_radius_m', '500'),
  ('same_point_days', '5'),
  ('od_notice_hours', '12'),
  ('offline_flag_minutes', '30'),
  ('clock_gap_minutes', '2'),
  ('jump_kmh', '150'),
  ('chairman_away', 'false'),
  ('phase1b_level', '0');

-- ---------- devices ----------
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  device_key text not null,
  platform text not null default 'web',
  user_agent text,
  status text not null default 'pending' check (status in ('active', 'pending', 'revoked')),
  approved_by uuid references profiles (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, device_key)
);

-- ---------- requests ----------
create table od_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  subject text not null check (length(subject) between 2 and 140),
  note text,
  venue_name text not null,
  venue_lat double precision,
  venue_lng double precision,
  venue_radius_m integer not null default 500,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status request_status not null default 'pending',
  decided_by uuid references profiles (id),
  decided_role app_role,
  decided_at timestamptz,
  return_reason text,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index on od_requests (user_id, starts_at);
create index on od_requests (status);

create table leave_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  leave_type text not null check (leave_type in ('casual', 'sick', 'earned', 'maternity', 'paternity', 'sabbatical', 'other')),
  starts_on date not null,
  ends_on date not null,
  half_day text check (half_day in ('first', 'second')),
  reason text,
  status request_status not null default 'pending',
  assigned_by_hr boolean not null default false,
  decided_by uuid references profiles (id),
  decided_at timestamptz,
  return_reason text,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index on leave_requests (user_id, starts_on);

-- ---------- attendance ----------
create table punches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  kind punch_kind not null,
  status text not null default 'recorded' check (status in ('recorded', 'review')),
  device_id uuid references devices (id),
  idempotency_key text not null unique,
  client_time timestamptz not null,
  server_time timestamptz not null default now(),
  synced_late_minutes integer not null default 0,
  lat double precision not null,
  lng double precision not null,
  accuracy_m double precision,
  altitude double precision,
  speed double precision,
  mocked boolean,
  place_name text,
  target_type text not null check (target_type in ('hub', 'od')),
  target_id uuid,
  distance_m double precision,
  inside boolean,
  selfie_key text,
  face_similarity double precision,
  liveness jsonb,
  quality_score integer check (quality_score between 0 and 100),
  band time_band,
  early_out boolean not null default false,
  created_at timestamptz not null default now()
);
create index on punches (user_id, server_time desc);

create table attendance_days (
  user_id uuid not null references profiles (id) on delete cascade,
  day date not null,
  in_punch uuid references punches (id),
  out_punch uuid references punches (id),
  in_time timestamptz,
  out_time timestamptz,
  band time_band,
  early_out boolean not null default false,
  status text not null default 'present' check (status in ('present', 'od', 'leave', 'absent')),
  primary key (user_id, day)
);
create index on attendance_days (day);

create table flags (
  id uuid primary key default gen_random_uuid(),
  punch_id uuid references punches (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  kind flag_kind not null,
  rule text not null,
  details jsonb not null default '{}',
  status flag_status not null default 'open',
  staff_reason text,
  decided_by uuid references profiles (id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index on flags (status, created_at desc);
create index on flags (user_id);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  data jsonb not null default '{}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on notifications (user_id, created_at desc);

create table geo_cache (
  key text primary key,           -- lat,lng rounded to 4 decimals (~11 m)
  place_name text not null,
  created_at timestamptz not null default now()
);

-- ---------- audit (append only, hash chained) ----------
create table audit_log (
  id bigserial primary key,
  actor_id uuid,
  actor_role text,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
