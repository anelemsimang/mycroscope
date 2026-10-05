# Mycroscope

Employee productivity tracking for organisations, designed around POPIA and RICA: employees are told exactly
what is recorded and must acknowledge it, managers' access to individual data is audited, and data is deleted
automatically after the organisation's retention period.

| Part | Folder | What it is |
| --- | --- | --- |
| Desktop agent | `desktop_app/` | Windows tray app (Python) that records app/website use and active/idle/away/paused time |
| Manager app | `mobile_app/` | Expo app for phones, tablets and browsers: live dashboard, reports, employees, compliance |
| Backend | `supabase/` | Database schema, security rules, reporting functions and tests |
| Old versions | `legacy/` | Previous admin dashboard, scripts and schema, kept for reference only |

## 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In **SQL Editor**, run each file in `supabase/migrations/` in name order (each file once).
3. **Database -> Extensions:** enable `pg_cron` before step 2, or afterwards run
   `select cron.schedule('mycroscope-nightly', '15 0 * * *', 'select public.run_nightly_maintenance()');`
   This nightly job closes stale sessions, builds daily totals and deletes data past the retention period.
   Check it with `select jobname, schedule from cron.job;`.
4. **Authentication -> URL Configuration:**
   - Site URL: the web app's address (`http://localhost:8081` while testing locally).
   - Redirect URLs: add `<that address>/auth/*` (and the live address later).
5. **Authentication -> Sign In / Providers -> Email:** keep "Confirm email" on.
6. **Project Settings -> API:** copy the project URL and the **anon/public** key for the apps.
   Never put the service_role key in any app.

## 2. Manager app (web, Android, iOS)

```powershell
cd mobile_app
npm install
copy .env.example .env      # fill in EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
npx expo start              # press w for the browser (http://localhost:8081), or scan the QR code with Expo Go
```

- The organisation owner registers from the sign-in screen and confirms their email.
- Owners and managers add employees (**Register Employee**); each new employee gets an employee code and a
  one-time activation code to enter in the desktop agent.
- **Settings -> Compliance** (owners and managers): what is recorded, working hours, integrity checks, retention,
  Information Officer, notice text, who has acknowledged the notice, notice history, the audit log and
  employees' privacy requests.
- **Settings -> Organisation:** alerts, productivity categories, teams (owner), subscription and billing,
  and time-limited support access for Mycroscope (owner).
- Owners can require two-factor login for all managers; new organisations get a 14-day trial.
- Employees who sign in see only their own activity and can send privacy requests.

Checks: `npm run typecheck`, `npm test`.

## 3. Desktop agent

See [`desktop_app/README.md`](desktop_app/README.md) to run it from source, and
[`desktop_app/installer/README.txt`](desktop_app/installer/README.txt) to build and install it on employee PCs.

## 4. Putting the web app online (Netlify)

`netlify.toml` contains the build settings. When ready:

1. Push the repository to GitHub and create a Netlify site from it (the settings are picked up automatically).
2. Under **Site configuration -> Environment variables**, add `EXPO_PUBLIC_SUPABASE_URL` and
   `EXPO_PUBLIC_SUPABASE_ANON_KEY`, then deploy.
3. Add your domain in Netlify, then in Supabase set the Site URL to it and add `https://<domain>/auth/*` to the
   Redirect URLs.
4. Set `EXPO_PUBLIC_WEB_URL` in `mobile_app/.env` (for phone builds) and `WEB_APP_URL` in the desktop agent's
   configuration to the same address, so emails sent from those apps open the web pages.

## 5. Database tests

```powershell
cd supabase/tests
npm install
npm test        # runs the migrations in an in-process Postgres and checks security, reporting and retention rules,
                # then unit-tests the payment and email logic used by the edge functions
```

## 6. Payments (Paystack)

Billing is prepaid: the owner picks seats and 1 or 12 months on **Settings -> Subscription & billing**, pays on
Paystack's page, and the paid period is extended when Paystack confirms the payment. Paying early adds to the end.
When a subscription lapses (after a 14-day grace period), everything stays viewable and exportable but the
desktop agent stops recording.

1. Create a Paystack business account and complete its verification (needed for live payments).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repository root:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase secrets set PAYSTACK_SECRET_KEY=sk_live_... PRICE_PER_SEAT_CENTS=9900 ANNUAL_DISCOUNT_PERCENT=15 APP_URL=https://app.example.co.za
   supabase functions deploy paystack-checkout
   supabase functions deploy paystack-webhook --no-verify-jwt
   ```

   `PRICE_PER_SEAT_CENTS` is the monthly price per seat in cents (9900 = R99.00). A per-customer price can be set
   in the `subscriptions.price_per_seat_cents` column. `ANNUAL_DISCOUNT_PERCENT` (optional, at most 50) applies
   to 12-month payments.
3. In Paystack **Settings -> API Keys & Webhooks**, set the webhook URL to
   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/paystack-webhook`.
4. Test with the `sk_test_...` key and Paystack's test cards first, then switch to the live key.

Without these secrets the billing page explains that online payment is not set up; EFT payments can be recorded
by an operator (section 8).

## 7. Manager emails (Resend)

Managers get a Monday-morning summary and, at most hourly, a notice when new integrity alerts appear. Emails
contain counts only (no names or activity details). Each manager can turn them off under Account.

1. Create a [Resend](https://resend.com) account, add and verify a sending domain (DNS records), create an API key.
2. Deploy:

   ```powershell
   supabase secrets set RESEND_API_KEY=re_... EMAIL_FROM="Mycroscope <alerts@mail.example.co.za>" CRON_SECRET=<long random string>
   supabase functions deploy notify-managers --no-verify-jwt
   ```

3. Edit the placeholders in `supabase/setup/schedule_emails.sql` (function URL and the same `CRON_SECRET`) and
   run it once in the SQL editor. It enables `pg_cron`/`pg_net` and stores both values in Supabase Vault.

Also recommended: under **Authentication -> Emails -> SMTP Settings**, send Supabase's own sign-up and
password-reset emails through Resend too (Supabase's built-in sender is heavily rate-limited).

## 8. Operator console (for Mycroscope staff)

Operators see customers, subscriptions and system health, but **no activity data**. Customers can grant support
a time-limited technical view (agent versions and status); every operator action is recorded in an operator
audit log and, where it affects a customer, in that customer's audit log.

1. In the SQL editor: `insert into public.platform_admin_invites (email) values ('you@yourcompany.co.za');`
2. Create the account: either Supabase **Authentication -> Users -> Add user** with that email, or the app's
   registration form (the organisation fields are ignored for invited emails; no organisation is created).
   Sign in; operator accounts must set up two-factor login before the console opens.
3. Use the console to extend trials, record EFT payments (set the status to Active, the seats and the paid-until
   date, with a note), suspend or cancel customers, and delete a cancelled customer's data on request.

**Case studies** (free periods for selected companies): **Operator Console -> Case studies**. Invite the owner's
email before they sign up (3, 6, 12 or 24 months), and the free period starts automatically when they register
the organisation. Companies already using Mycroscope get one from their customer page. When the free period ends,
the normal 14-day trial runs; it can be ended early or restarted. The customer sees "Free case study until ..."
and every change appears in both audit logs. Needs `supabase/migrations/20261008090000_case_studies.sql`.

The "Used without signing in" alert (a PC in use for 15 minutes with nobody signed in to the agent) needs
`supabase/migrations/20261009090000_unattended_use.sql` and agent 2.1 or later.
`20261010090000_notice_sign_in_reminders.sql` adds the reminder and this alert to the monitoring notice and
publishes a new notice version for every organisation (employees are asked to acknowledge it; tracking continues).

Resetting a lost second factor (any user): in Supabase **Authentication -> Users**, open the user and remove
their MFA factor, after confirming their identity out of band.

## 9. Launch checklist

- [ ] All migrations applied in order; `select jobname from cron.job;` shows `mycroscope-nightly` (and the two
      email jobs once section 7 is done).
- [ ] Authentication: Site URL and `https://<domain>/auth/*` redirect set; "Confirm email" on; custom SMTP set.
- [ ] Web app deployed (section 4) with HTTPS on your own domain.
- [ ] Paystack live keys set, webhook URL configured, one real low-value payment tested end to end.
- [ ] Resend domain verified; a test digest received (`kind: "digest"` request, see `schedule_emails.sql`).
- [ ] Desktop agent built with a code-signing certificate; update host serving `manifest.json`; installed on a
      test PC with `install-machine.ps1` and checked: starts for a standard user, restarts when killed, updates.
- [ ] Operator account created with two-factor login.
- [ ] Your own POPIA documents ready: privacy policy, operator agreement (customers are responsible parties,
      Mycroscope is their operator), Information Officer registration, breach-notification procedure.
- [ ] Supabase on a paid plan with point-in-time recovery or daily backups, and a region close to customers.
- [ ] GitHub Actions CI green on `main`.
