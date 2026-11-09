-- Security hardening, 9 Nov.
-- 1. Admin access (HR, Chairman, Tech) only for the approved StartupTN emails. The list changes only by migration.
-- 2. The two Gmail test admins lose access (their records stay).
-- 3. Fixed search_path on the last two functions without one; rls_auto_enable not callable by users.
-- 4. Rate limits for the edge functions (server only).
-- 5. Length limits on free-text fields (new rows; old rows untouched).

-- ---------- 1. admin email list ----------
create or replace function public.admin_email_ok(p_email text) returns boolean
language sql immutable set search_path = public as $$
  select lower(trim(coalesce(p_email, ''))) in (
    'hr@startuptn.in',            -- HR (real)
    'hr.ai@startuptn.in',         -- HR (test)
    'chairmanoffice@startuptn.in',-- Chairman (real)
    'chairman.ai@startuptn.in',   -- Chairman (test)
    'ai@startuptn.in'             -- Tech admin
  )
$$;
revoke execute on function admin_email_ok(text) from public, anon, authenticated;

create or replace function public.guard_admin_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role in ('hr', 'chairman', 'tech') and not admin_email_ok(new.email) then
    raise exception 'not_on_admin_list' using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke execute on function guard_admin_email() from public, anon, authenticated;

-- 2. remove the Gmail test admins first (same as Tech "Remove login": roster row goes, profile turns inactive)
delete from staff_roster where email in ('naveenflop@gmail.com', 'naveenbackup7@gmail.com') and role in ('hr', 'chairman', 'tech');
update profiles set active = false where email in ('naveenflop@gmail.com', 'naveenbackup7@gmail.com') and role in ('hr', 'chairman', 'tech');
-- any other admin row outside the list loses its access the same way
delete from staff_roster where role in ('hr', 'chairman', 'tech') and not admin_email_ok(email);
update profiles set active = false where role in ('hr', 'chairman', 'tech') and not admin_email_ok(email) and active;

drop trigger if exists roster_admin_email on staff_roster;
create trigger roster_admin_email before insert or update of role, email on staff_roster for each row execute function guard_admin_email();
drop trigger if exists profiles_admin_email on profiles;
create trigger profiles_admin_email before insert or update of role, email on profiles for each row execute function guard_admin_email();

-- belt and braces: an admin role on an email outside the list gives no access, even if a row slipped in
create or replace function public.my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid() and active
     and (role not in ('hr', 'chairman', 'tech') or admin_email_ok(email))
$$;

-- ---------- 3. fixed search_path; internal helper not callable ----------
alter function public.distance_m(float8, float8, float8, float8) set search_path = public;
alter function public.audit_is_append_only() set search_path = public;
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rls_auto_enable') then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- ---------- 4. rate limits (called by the edge functions with the service key) ----------
create table if not exists rate_hits (
  key text not null,
  window_start timestamptz not null,
  n integer not null default 1,
  primary key (key, window_start)
);
alter table rate_hits enable row level security;   -- no policies: users read and write nothing; the service key bypasses RLS
revoke all on rate_hits from anon, authenticated;

-- true = allowed. Counts per fixed window; clears old windows now and then.
create or replace function public.rate_limit(p_key text, p_max integer, p_window_s integer) returns boolean
language plpgsql security definer set search_path = public as $$
declare w timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_s) * p_window_s); c integer;
begin
  if p_key is null or length(p_key) > 200 or p_max < 1 or p_window_s < 1 or p_window_s > 86400 then raise exception 'bad_request'; end if;
  insert into rate_hits as r (key, window_start, n) values (p_key, w, 1)
  on conflict (key, window_start) do update set n = r.n + 1
  returning n into c;
  if random() < 0.01 then delete from rate_hits where window_start < now() - interval '1 day'; end if;
  return c <= p_max;
end $$;
revoke execute on function rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function rate_limit(text, integer, integer) to service_role;

-- ---------- 5. length limits on free text (React already escapes everything shown) ----------
alter table od_requests drop constraint if exists od_text_len;
alter table od_requests add constraint od_text_len check (
  length(coalesce(note, '')) <= 1000 and length(venue_name) <= 200 and length(coalesce(venue_url, '')) <= 2000
  and length(coalesce(venue_place, '')) <= 300 and length(coalesce(return_reason, '')) <= 500) not valid;
alter table leave_requests drop constraint if exists leave_text_len;
alter table leave_requests add constraint leave_text_len check (
  length(coalesce(reason, '')) <= 1000 and length(coalesce(return_reason, '')) <= 500) not valid;
alter table staff_roster drop constraint if exists roster_text_len;
alter table staff_roster add constraint roster_text_len check (
  length(full_name) between 1 and 120 and length(email) <= 254 and length(coalesce(phone, '')) <= 20
  and length(coalesce(designation, '')) <= 120 and length(coalesce(employee_code, '')) <= 40) not valid;
