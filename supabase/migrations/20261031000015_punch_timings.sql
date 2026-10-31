-- How long each check-in took (phone GPS wait, upload, server work, total), so Tech can find slow saves.
alter table punches add column if not exists timings jsonb;
