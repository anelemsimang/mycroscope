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
- **Settings -> Organisation:** alerts, productivity categories (company-wide or per team), productivity goals,
  working hours for teams or individual people, teams (owner), subscription and billing,
  the agent install key (the key needed to install the desktop agent on a PC), and time-limited support
  access for Mycroscope (owner).
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

`20261011090000_install_key_and_tamper.sql` adds the per-company **agent install key** (manager app ->
Settings -> Organisation): whoever installs the agent must enter it, so an employee cannot reinstall the agent
on their own. It also adds two alerts: "Started late" (the agent only started well after the PC was switched on
and used during working hours, e.g. the agent was removed, the PC restarted and used, then reinstalled) and
"App uninstalled" (the uninstaller reported the removal). Both appear under Alerts and in the alert emails.

`20261014090000_team_settings_and_goals.sql` adds:
- **Plan features:** `plan_features(plan)` decides what each plan includes (trials get everything; goals need
  Business or Enterprise). Change a customer's plan in the operator console.
- **Productivity categories per team:** a team's rule beats the company rule for the same app or website.
- **Working hours per team or person:** Settings -> Organisation -> Working hours. A person's own hours beat
  their team's, which beat the company's. They are listed in the monitoring notice, so changes publish a new
  version while monitoring is limited to working hours. Desktop agents older than this release ignore them and use
  the company hours, so reinstall the agent with the new `Mycroscope-Setup.exe`.
- **Productivity goals** per company or team, with under- and over-utilised thresholds.
- **Daily usage** per person, app and website, filled nightly and back-filled for stored history, for
  company-wide reports.

`20261015090000_workforce_analytics.sql` (apply after the one above) adds the **Insights** screen in the manager app:
- **Trends** (Standard and up): productive and active time per person-day by day, week or month, compared with the
  previous period of the same length.
- **Workload** (Business and up): each person's productive time per day worked against their goal, flagged as
  under-utilised, healthy or over-utilised.
- **Capacity** (Business and up): the gap to the goal per team in full-time equivalents. With an optional average
  salary (owners and company-wide managers only; readable only through `get_workforce_costs`), the gap is also shown
  in rand.
- **Software** (Business and up): active time and number of users per app or website, plus licence counts and
  monthly cost per seat to show unused licences.

It rebuilds `daily_usage` as one row per person, day, app and website (so website rules can override browser
rules) and back-fills it from stored activity. Reports cover at most 400 days per request. These figures start as
tracked computer time. From the migration below, productive totals can also include time away from the computer.

`20261016090000_alerts_and_integrations.sql` (apply after the one above) adds:
- **Alert rules** (Standard and up; manager app -> Alerts -> Alert rules): an alert when someone uses a website
  (the domain and its subdomains) or program you name. Suggested lists add file-sharing sites, personal email and
  Bluetooth file transfer (`fsquirt.exe`). Rules are checked on the server as activity arrives, so they work with
  every agent version, but only for what is recorded (Websites / Applications switched on). An alert shows a visit,
  not an upload.
- **File activity** (Business and up; Monitoring & privacy -> File activity, off by default): with agent 2.3, USB
  drive, external disk and phone connections, and the names and sizes of files copied to removable drives, cloud
  sync folders (OneDrive, Dropbox, Google Drive) and, optionally, network drives. File contents are never read.
  Switching it on publishes a new notice version, and the agent only starts once the employee has acknowledged it.
  File names are kept for 30 days by default (7 to 365), are only visible on the employee's page behind
  "Show file activity", and every view is audited. Alerts, Slack/Teams and the API only carry counts. Files copied
  onto a phone cannot be seen (only that it was connected); on network drives only files owned by the employee's
  Windows account are counted.
- **Slack, Microsoft Teams and webhooks** (Standard and up; Alerts -> Slack, Teams & API): new alerts are posted
  hourly with the alert emails. Saved addresses are never shown again in the app. Webhook requests carry
  `X-Mycroscope-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the signing secret>`; the
  secret is shown once when the webhook is added.
- **Read-only API** (Business and up): keys are shown once and stored hashed. Send `X-Api-Key: myc_...` to
  `https://<project>.supabase.co/functions/v1/api/v1/` + `employees`, `daily-totals?from=YYYY-MM-DD&to=YYYY-MM-DD`,
  `usage?from=...&to=...` (at most 93 days) or `alerts?since=<ISO time>`.

Deploy the functions (alerts to Slack/Teams/webhooks also need the section 7 cron job, even without Resend):

```powershell
supabase functions deploy notify-managers --no-verify-jwt
supabase functions deploy channel-test
supabase functions deploy api --no-verify-jwt
```

`20261017090000_offline_time.sql` (apply after the one above) adds **time away from the computer**, on every plan.
With agent 2.4, when someone comes back after being idle or away for longer than a company setting (10 minutes
unless you change it), the desktop app asks: meeting, call, break or other, with an optional note. They can dismiss
it. Nothing is asked until they have acknowledged the notice that describes it, and nothing is asked outside working
hours, while paused, or while the subscription is inactive. Reinstall `Mycroscope-Setup.exe` for this.

Monitoring & privacy -> Time away from the computer turns it on and chooses which reasons count as productive.
Meetings and calls do, unless you change that. The choice applies to past days as well, the same way categories do.

Where that time appears:
- **Daily totals, the employee page and Reports** show it on its own (meeting, call, break, other). It still also
  sits inside idle or away, because the activity record is unchanged. A project report leaves it out.
- **Trends** adds the productive reasons to the productive-per-person-day figure. A day counts when there was computer activity or productive time away. The coloured bars stay computer time.
- **Workload, capacity and goals** add the productive reasons to the productive time compared with the goal. A day
  with only a meeting still counts. Breaks and unexplained time do not.
- **App, website and software reports** are unchanged.
- The **read-only API** `daily-totals` productive figure includes the productive reasons, and also returns
  `offline_seconds` and `productive_offline_seconds`.

Answers are kept for the same period as detailed activity and are removed when a manager deletes someone's activity.
Two answers for the same person cannot overlap. The desktop app drops an answer the server refuses.

`20261018090000_work_location.sql` (apply after the one above) adds **office and remote days** on Standard and up.
With agent 2.5, while someone is signed in and working, the desktop app checks about every 15 minutes whether the PC
is on a network the company registered: a public IP address or range (not a 192.168 or 10. address) and/or the office
Wi-Fi name. It records each day as office, remote, or mixed, and which office. A home address and a home network name
are not stored. Nothing is recorded until the employee has acknowledged the notice, and nothing is checked outside
working hours, while paused, or while the subscription is inactive. If the address and the Wi-Fi name both cannot be
read, that check is skipped. The Wi-Fi name comes from Windows (`netsh wlan show interfaces`). Some newer
Windows 11 builds ask for location permission before they will show it; if that is refused, or there is no Wi-Fi, the
app uses the public address only.

Monitoring & privacy -> Office and remote turns it on, sets how many office days a week the company looks for (empty
means no target), and registers offices. A team can set its own number under Teams; that replaces the company number
for people in the team. Insights -> Office days shows the split and, for each full Monday-to-Sunday week in the period,
whether the target was met. A mixed day counts as an office day. A week with no recorded day is left out.

The public address is read by a small function that returns it and stores nothing. Deploy it with JWT verification left on:

```powershell
supabase functions deploy client-ip
```

Reinstall `Mycroscope-Setup.exe` for this. A VPN that exits through the office will look like the office. Two PCs on
the same day are combined: one at the office and one elsewhere makes the day mixed.

`channel-test` is called by signed-in managers (keep JWT verification on). `api` checks its own keys.
Set `APP_URL` (e.g. `supabase secrets set APP_URL=https://mycroscope.netlify.app`) so messages link to the app.

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
