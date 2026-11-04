-- Store app: separate, recorded consent for work-hours location (check-in → check-out, office hours).
-- The server stores no presence samples for anyone who has not given it.
alter table profiles add column if not exists presence_consent_at timestamptz;
create or replace function public.give_presence_consent() returns void
language sql security definer set search_path = public as $$
  update profiles set presence_consent_at = coalesce(presence_consent_at, now()) where id = auth.uid() and active
$$;
revoke execute on function give_presence_consent() from public, anon;
grant execute on function give_presence_consent() to authenticated;
