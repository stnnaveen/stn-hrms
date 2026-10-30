-- HR, Chairman and Tech admin can view selfies (signed links) for disputes; staff cannot list or read the bucket.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    execute $p$
      create policy selfies_admin_read on storage.objects for select to authenticated
      using (bucket_id = 'selfies' and public.sees_all())
    $p$;
  end if;
end $$;

-- HR's home numbers in one call (all hubs, India date)
create or replace function public.hr_today() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not sees_all() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'staff', (select count(*) from profiles where role in ('staff', 'intern') and active),
    'checked_in', (select count(*) from attendance_days where day = v_today and in_time is not null),
    'late', (select count(*) from attendance_days where day = v_today and band in ('warn', 'bad')),
    'od', (select count(distinct user_id) from od_requests where status = 'approved' and starts_at::date <= v_today and ends_at::date >= v_today),
    'leave', (select count(distinct user_id) from leave_requests where status = 'approved' and starts_on <= v_today and ends_on >= v_today),
    'pending_leave', (select count(*) from leave_requests where status = 'pending'),
    'pending_od', (select count(*) from od_requests where status = 'pending'),
    'open_flags', (select count(*) from flags where status in ('open', 'reason_asked') and (kind <> 'late' or staff_reason is not null)),
    'chairman_away', coalesce((setting('chairman_away'))::boolean, false)
  );
end $$;
