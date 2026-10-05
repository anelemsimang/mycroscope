-- Schedules the manager emails. Run once in the Supabase SQL editor AFTER deploying the notify-managers function
-- and setting its secrets. Replace the two placeholders first; the values are kept in Supabase Vault, not in cron.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1/notify-managers', 'mycroscope_notify_url');
select vault.create_secret('PASTE-THE-SAME-CRON_SECRET-AS-THE-FUNCTION', 'mycroscope_cron_secret');

-- Integrity alerts: hourly at :07.
select cron.schedule('mycroscope-alert-emails', '7 * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_notify_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_cron_secret')),
    body := '{"kind":"alerts"}'::jsonb,
    timeout_milliseconds := 30000);
$$);

-- Weekly digest: Mondays 05:00 UTC (07:00 South African time), after the nightly summaries have been built.
select cron.schedule('mycroscope-weekly-digest', '0 5 * * 1', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_notify_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_cron_secret')),
    body := '{"kind":"digest"}'::jsonb,
    timeout_milliseconds := 60000);
$$);

-- Check runs:   select * from cron.job_run_details order by start_time desc limit 20;
-- Responses:    select id, status_code, content from net._http_response order by created desc limit 20;
-- Remove:       select cron.unschedule('mycroscope-alert-emails'); select cron.unschedule('mycroscope-weekly-digest');
