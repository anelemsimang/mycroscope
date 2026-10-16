-- Renewal emails. Run once in the Supabase SQL editor AFTER deploying billing-reminders
-- (supabase functions deploy billing-reminders --no-verify-jwt).
-- The nightly database job already moves an unpaid company to Free after the grace window.
-- This schedule only sends the payment email. The address below is the live project. Do not run this file again.
-- The cron secret is the same one already stored for manager emails.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select vault.create_secret('https://kufcctokgmaehshqsvzf.supabase.co/functions/v1/billing-reminders', 'mycroscope_billing_url');

-- 05:00 UTC (07:00 South African time), every day.
select cron.schedule('mycroscope-billing-reminders', '0 5 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_billing_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'mycroscope_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$$);

-- Remove: select cron.unschedule('mycroscope-billing-reminders');
