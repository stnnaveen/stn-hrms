-- Until StartupTN's S3 bucket is ready, selfies go to a private Supabase Storage bucket (Mumbai).
-- Only the edge function (service role) writes or reads it; no policies are granted to staff.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('selfies', 'selfies', false, 3145728, array['image/jpeg'])
    on conflict (id) do nothing;
  end if;
end $$;
