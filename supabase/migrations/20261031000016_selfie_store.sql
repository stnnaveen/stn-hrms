-- Where each selfie file lives, so photos keep opening after the move to StartupTN's AWS:
-- older ones stay in Supabase Storage, new ones go to S3 (Mumbai) once the AWS keys are set.
alter table punches add column if not exists selfie_store text check (selfie_store in ('supabase', 's3'));
update punches set selfie_store = 'supabase' where selfie_key is not null and selfie_store is null;
