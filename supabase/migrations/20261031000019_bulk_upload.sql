-- Tech admin bulk upload (CSV). Each row is checked on its own: one bad row never stops the rest.
-- Returns one result per row: added / updated / skipped / error with a short reason.

create or replace function public.bulk_upsert_staff(p_rows jsonb, p_update boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; i int := 0; out jsonb := '[]'::jsonb;
  v_email text; v_name text; v_role app_role; v_hub text; v_code text; v_phone text; v_desig text; v_joined date;
  v_existing staff_roster; v_msg text;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'bad_rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_email := lower(trim(coalesce(r->>'email', '')));
      v_name := trim(coalesce(r->>'full_name', ''));
      v_code := nullif(trim(coalesce(r->>'employee_code', '')), '');
      v_phone := nullif(regexp_replace(coalesce(r->>'phone', ''), '[^0-9+]', '', 'g'), '');
      v_desig := nullif(trim(coalesce(r->>'designation', '')), '');
      v_joined := nullif(trim(coalesce(r->>'joined_on', '')), '')::date;
      v_role := coalesce(nullif(lower(trim(coalesce(r->>'role', ''))), ''), 'staff')::app_role;
      if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Email is not valid'; end if;
      if length(v_name) < 2 then raise exception 'Name is missing'; end if;
      if v_role not in ('staff', 'intern') then raise exception 'Role must be staff or intern'; end if;
      select name into v_hub from hubs where lower(name) = lower(trim(coalesce(r->>'hub', ''))) and active;
      if v_hub is null then raise exception 'Hub "%" not found', coalesce(r->>'hub', ''); end if;
      if v_code is not null and exists (select 1 from staff_roster where employee_code = v_code and email <> v_email) then
        raise exception 'Employee code % is already used', v_code; end if;
      select * into v_existing from staff_roster where email = v_email;
      if v_existing.email is not null then
        if v_existing.role in ('hr', 'chairman', 'tech') then raise exception 'This email is a role login'; end if;
        if not p_update then
          out := out || jsonb_build_object('row', i, 'email', v_email, 'result', 'skipped', 'message', 'Already added');
          continue;
        end if;
        update staff_roster set full_name = v_name, hub_name = v_hub, employee_code = v_code, phone = v_phone,
          designation = coalesce(v_desig, designation), joined_on = coalesce(v_joined, joined_on) where email = v_email;
        out := out || jsonb_build_object('row', i, 'email', v_email, 'result', 'updated', 'message', '');
      else
        insert into staff_roster (email, full_name, role, hub_name, employee_code, phone, designation, joined_on)
        values (v_email, v_name, v_role, v_hub, v_code, v_phone, v_desig, v_joined);
        out := out || jsonb_build_object('row', i, 'email', v_email, 'result', 'added', 'message', '');
      end if;
    exception when others then
      v_msg := sqlerrm;
      if v_msg like 'invalid input syntax for type date%' or v_msg like 'date/time field value out of range%' then v_msg := 'Joining date must look like 2026-11-03'; end if;
      if v_msg like 'invalid input value for enum%' then v_msg := 'Role must be staff or intern'; end if;
      out := out || jsonb_build_object('row', i, 'email', v_email, 'result', 'error', 'message', left(v_msg, 140));
    end;
  end loop;
  perform append_audit('bulk_upload', 'staff_roster', null, null, jsonb_build_object('rows', i,
    'added', (select count(*) from jsonb_array_elements(out) e where e->>'result' = 'added'),
    'updated', (select count(*) from jsonb_array_elements(out) e where e->>'result' = 'updated'),
    'errors', (select count(*) from jsonb_array_elements(out) e where e->>'result' = 'error')));
  return out;
end $$;

create or replace function public.bulk_upsert_hubs(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; i int := 0; out jsonb := '[]'::jsonb; v_name text; v_lat float8; v_lng float8; v_rad int; v_id uuid;
begin
  if my_role() is distinct from 'tech' then raise exception 'only the Tech admin'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then raise exception 'bad_rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      v_name := trim(coalesce(r->>'name', ''));
      if length(v_name) < 2 then raise exception 'Hub name is missing'; end if;
      v_lat := nullif(r->>'lat', '')::float8; v_lng := nullif(r->>'lng', '')::float8;
      v_rad := coalesce(nullif(r->>'radius_m', '')::int, 300);
      if v_rad not between 50 and 3000 then raise exception 'Radius must be 50 to 3000 m'; end if;
      select id into v_id from hubs where lower(name) = lower(v_name);
      if v_id is null then
        if v_lat is null or v_lng is null then raise exception 'New hub needs a map link or lat/lng'; end if;
        insert into hubs (name, lat, lng, radius_m, maps_url) values (v_name, v_lat, v_lng, v_rad, nullif(r->>'maps_url', ''));
        out := out || jsonb_build_object('row', i, 'name', v_name, 'result', 'added', 'message', '');
      else
        update hubs set radius_m = v_rad, lat = coalesce(v_lat, lat), lng = coalesce(v_lng, lng),
          maps_url = coalesce(nullif(r->>'maps_url', ''), maps_url), active = true where id = v_id;
        out := out || jsonb_build_object('row', i, 'name', v_name, 'result', 'updated', 'message', case when v_lat is null then 'Radius only (no pin given)' else '' end);
      end if;
    exception when others then
      out := out || jsonb_build_object('row', i, 'name', v_name, 'result', 'error', 'message', left(sqlerrm, 140));
    end;
  end loop;
  return out;
end $$;

revoke execute on function bulk_upsert_staff(jsonb, boolean), bulk_upsert_hubs(jsonb) from public, anon;
grant execute on function bulk_upsert_staff(jsonb, boolean), bulk_upsert_hubs(jsonb) to authenticated;
