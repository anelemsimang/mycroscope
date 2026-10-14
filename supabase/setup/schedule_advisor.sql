-- Weekly reports. Run once in the Supabase SQL editor AFTER deploying work-advisor
-- (supabase functions deploy work-advisor --no-verify-jwt). No outside API key is required.
-- Replace the project URL. The cron secret is the same one already stored for manager emails.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1/work-advisor', 'mycroscope_advisor_url');

-- Mondays 06:00 UTC (08:00 South African time), after the weekly digest.
select cron.schedule('mycroscope-weekly-advice', '0 6 * * 1', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_advisor_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- Remove: select cron.unschedule('mycroscope-weekly-advice');
