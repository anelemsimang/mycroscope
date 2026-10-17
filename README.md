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
- Owners can require two-factor login for all managers; new organisations start on the free plan (3 people, 30 days of detail).
- Employees who sign in see only their own activity and can send privacy requests.

Checks: `npm run typecheck`, `npm test`.

## 3. Desktop agent

See [`desktop_app/README.md`](desktop_app/README.md) to run it from source, and
[`desktop_app/installer/README.txt`](desktop_app/installer/README.txt) to build and install it on employee PCs.

## 4. Putting the web app and the public site online (Docker)

`docker-compose.yml` builds three images: the signed-in app, the public site, and a private inbox for the
support form. Supabase still holds the database, sign-in and edge functions. The Windows desktop agent stays
an installer, not a container.

```powershell
copy .env.example .env
# Fill in EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY and EXPO_PUBLIC_WEB_URL.
# EXPO_PUBLIC_WEB_URL is the public address of the app, such as https://app.example.co.za
docker compose up -d --build
```

The app listens on port 8080 and the site on port 8081. Put TLS in front of both. In Supabase, set the Site
URL to the app address and add `https://<app-address>/auth/*` to the Redirect URLs. Set the same app address
as `WEB_APP_URL` for the desktop agent. Those three `EXPO_PUBLIC_` values are compiled into the app image, so
changing them needs another build.

Support questions are appended to `/data/support.jsonl` in the `support-inbox` volume:

```powershell
docker compose exec inbox cat /data/support.jsonl
```

Phone builds still use `mobile_app/.env` for the same Supabase values. `npm run typecheck` and `npm test` in
`mobile_app` are unchanged.

## 5. Database tests

```powershell
cd supabase/tests
npm install
npm test        # runs the migrations in an in-process Postgres and checks security, reporting and retention rules,
                # then unit-tests the payment and email logic used by the edge functions
```

## 6. Payments (Yoco)

Owners pay under **Settings -> Subscription & billing**. Prices in the plan catalogue are exclusive of VAT.
With VAT on (15% by default), Yoco is charged the gross amount for a whole year: every active person times the
per-person monthly gross price, times 12. Work Activity at R100 a month is R1,200 a year before VAT. The smallest
charge is R2.00. Yoco does not store the card or renew it. Each payment is one checkout. The `payment.succeeded`
webhook extends the year. The page the payer returns to is not proof of payment.

| Plan | Net per person | With 15% VAT | People | Detailed activity |
| --- | --- | --- | --- | --- |
| Free | R0 | R0 | 3 | 30 days |
| Work Activity | R100 | R115 | No cap | 6 months |
| Workforce | R200 | R230 | No cap | 6 months |
| Productivity | R300 | R345 | No cap | 12 months |

A higher plan includes everything in the plans below it. Change a price or a feature in `plans` and
`plan_feature_grants`. Do not hardcode them in the app.

Moving from Free charges a full year. A paid upgrade has two choices. Starting today charges one year of the
new plan for the seats already in force, minus each seat's unused current-plan value, and every seat then ends
one year from today. Waiting charges nothing today. The higher plan starts at the end of the term only after a
year of the new plan is paid (`p_when` `end` on `quote_plan_change`). If that payment is not made, the change
does not start. Deploy `yoco-checkout` with this change so a payment for the end of the term is not charged as
a start-today upgrade. A downgrade or cancellation starts when the current year
ends, with no refund. If a payment is missed, the paid plan stays for 7 days (`billing_config.grace_days`), then
the account moves to Free. Recording continues. Extra people are paused, not deleted. Activity outside the new
plan is hidden, and it is deleted only once it is older than the longest plan or older than the shorter limit
the owner already chose.

1. Create a Yoco account. Use the test secret key until one payment has been confirmed by the webhook.
2. From the repository root, with the Supabase CLI logged in and the project linked:

   ```powershell
   supabase functions deploy yoco-checkout
   supabase functions deploy yoco-webhook billing-reminders --no-verify-jwt
   supabase secrets set YOCO_SECRET_KEY=sk_test_... YOCO_WEBHOOK_SECRET=whsec_...
   ```

   `APP_URL` and `CRON_SECRET` are already set. The morning payment email also needs `RESEND_API_KEY` and
   `EMAIL_FROM` (section 7). The account still moves to Free after the grace window if email is not configured.
3. In Yoco, subscribe to `payment.succeeded` at
   `https://YOUR_PROJECT_REF.supabase.co/functions/v1/yoco-webhook`.
4. Before the first tax invoice, set the supplier VAT number. The business name is already stored.

   ```sql
   update public.billing_config set business_vat_number = 'YOUR-VAT-NUMBER';
   ```

   Leave `vat_enabled` true. Set it to false only when VAT must not be charged. The invoice then has no VAT
   line, and Yoco is charged the net price.

`supabase/setup/schedule_billing.sql` is already applied on this project. Do not run it again. The Paystack
functions are still in the repository. The billing screen uses Yoco.

Without `YOCO_SECRET_KEY` the billing page says online payment is not set up.

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
3. From the console, suspend or cancel a customer, or delete a cancelled customer's data on request.
   Seats and the paid-until date are set when a payment is confirmed. That payment covers one year from the confirmation.

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
- **Plan features:** `plan_features(plan)` decides what each plan includes (goals need Business or Enterprise).
  Change a customer's plan in the operator console. The trial plan was removed by
  `20261028090000_remove_trial_and_case_studies.sql`.
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
  (the domain and its subdomains) or program you name. A rule can instead restrict a program or a website. Agent
  2.6.3 minimises a restricted program when it comes to the front while monitoring is on, shows a short notice, and
  records an alert. No administrator rights are needed, and it starts only after the employee acknowledges the
  notice. A restricted website stays blocked in Google Chrome and Microsoft Edge the whole time the employee is
  signed in, including after hours and while tracking is paused, unless the computer already uses its own web proxy.
  If the website is opened in Firefox or another browser, managers are told which website it was. Other sites keep
  working. Suggested lists add file-sharing sites, personal email and Bluetooth file transfer
  (`fsquirt.exe`). Rules are checked on the server as activity arrives, so the alert works with every agent version,
  but only for what is recorded (Websites / Applications switched on). An alert shows a visit, not an upload.
  Reinstall `Mycroscope-Setup.exe` (version 2.6.3) for minimising a program and for blocking a website.
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

`20261019090000_ai_tools.sql` (apply after the one above) adds **AI tool reports** on Business and Enterprise.
Mycroscope keeps one list of tools (ChatGPT, Claude, Gemini, Microsoft Copilot, and Perplexity to start).
Operators add, edit, hide, or remove tools in the operator console. A website matches the tool and its subdomains;
an app name must match exactly. A company marks each tool approved, not approved, or leaves it with no decision
(Insights -> AI tools, owners and organisation-wide managers). The report shows how many people used each tool, and
whether each person was occasional (under two days a week) or consistent. When someone's first use falls in the
selected period, and both the 28 days before and the 28 days from that day have at least five days of computer
activity, the report also shows average productive computer hours before and after. That is a correlation. Time in
the tool counts toward those hours when the tool's category is productive.

Monitoring & privacy -> AI tools turns on an alert for tools marked not approved. It stays off until switched on,
and the employee notice gains a sentence only then. The desktop app does not change for this.

`20261020090000_work_advisor.sql` (apply after the one above) adds **written reports** on Business and Enterprise.
It stays off until an owner switches it on under Monitoring & privacy. A manager picks a report in
Insights -> Advice: week in review, workload, where time went, capacity, or how the period changed. The report is
written inside Mycroscope from the trends, workload, capacity and software figures already stored, using that
manager's own sign-in so a team manager only sees their teams. Every number in the report comes from those figures.
The report leads with the result that crosses a threshold: someone over or under the company's goal, a rise or fall
of more than about 15% through the period, a capacity gap of an hour or more, one app taking most of the open time,
or productive time away from the computer reaching about a quarter of the total. Pay figures are left out. Nothing is sent to another company to write the report.

`20261022090000_report_templates.sql` (apply after the free-plan migration) replaces the employee-notice sentence that
named an outside service. While written reports are on, the notice says the report is written inside Mycroscope from
figures it already stores. Companies that already had reports switched on get a new notice version.

A weekly note for the previous Monday to Sunday is written for each team, and one for the whole company. Emailing it
to managers is a separate switch. Deploy the function with JWT verification off; it rejects callers that are neither
a signed-in user nor the existing cron secret:

```powershell
supabase functions deploy work-advisor --no-verify-jwt
```

No API key is required. Then run `supabase/setup/schedule_advisor.sql` in the SQL editor after replacing the project
URL. The same `CRON_SECRET` as the manager emails is reused. Weekly email uses the existing `RESEND_API_KEY` and
`EMAIL_FROM`. The desktop app does not change for this.

`20261021090000_free_plan.sql` (apply after the one above) added the **free plan**: up to 3 active people, and detailed
activity kept for 30 days. Paid reports are not included. Recording continues. A fourth person cannot be added or
switched back on until someone is deactivated or the company pays.

`20261028090000_remove_trial_and_case_studies.sql` removes the 14-day trial and case studies. Sign-up creates the free
plan directly. Existing organisations were moved to Free, with at most 3 billed seats. Employee records were not
deleted, and the history length already chosen on each company was left as it was.

`20261029090000_plan_catalogue.sql` is the price and feature list: Free, Work Activity, Workforce, and Productivity.
Prices are net of VAT. `20261030090000_billing_lifecycle.sql` is the monthly payment, the 7-day grace window,
invoices, and the history rules. `20261031090000_grant_feature_check.sql` lets the team list ask who is working
right now. Section 6 is how to take payment. The desktop app does not change for this. On Free it keeps recording,
and it does not show who is online.

`20261023090000_restrictions.sql` (apply after `20261022090000_report_templates.sql`) lets an alert rule restrict a
program or a website. A restricted program is minimised by agent 2.6.3, with a short notice, while monitoring is on.
A restricted website stays blocked in Google Chrome and Microsoft Edge the whole time the employee is signed in,
including after hours and while tracking is paused, unless the computer already uses its own web proxy. If the
website is opened in Firefox or another browser, managers are told which website it was. Other sites keep working. Saving or removing a restriction publishes a new notice, and it starts after the employee acknowledges
it. Reinstall `Mycroscope-Setup.exe` (version 2.6.3).

`20261024090000_site_block.sql` (apply after the one above) updates the employee notice so a restricted website is
described as blocked in Google Chrome and Microsoft Edge, instead of only raising an alert.

`20261025090000_site_block_always.sql` (apply after the one above) keeps that block on outside working hours and
while tracking is paused.

`20261026090000_restricted_site_alert.sql` (apply after the one above) tells managers when a restricted website is
opened in Firefox or another browser while the employee is signed in, including after hours and while tracking is paused.

`channel-test` is called by signed-in managers (keep JWT verification on). `api` checks its own keys.
Set `APP_URL` (e.g. `supabase secrets set APP_URL=https://mycroscope.co.za`) so messages link to the app.

Resetting a lost second factor (any user): in Supabase **Authentication -> Users**, open the user and remove
their MFA factor, after confirming their identity out of band.

## 9. Launch checklist

- [ ] All migrations applied in order; `select jobname from cron.job;` shows `mycroscope-nightly` (and the two
      email jobs once section 7 is done).
- [ ] Authentication: Site URL and `https://<domain>/auth/*` redirect set; "Confirm email" on; custom SMTP set.
- [ ] Web app deployed (section 4) with HTTPS on your own domain.
- [ ] Yoco test key and webhook secret set, `payment.succeeded` webhook configured, one test payment confirmed by the webhook.
- [ ] Resend domain verified; a test digest received (`kind: "digest"` request, see `schedule_emails.sql`).
- [ ] Desktop agent built with a code-signing certificate; update host serving `manifest.json`; installed on a
      test PC with `install-machine.ps1` and checked: starts for a standard user, restarts when killed, updates.
- [ ] Operator account created with two-factor login.
- [ ] Your own POPIA documents ready: privacy policy, operator agreement (customers are responsible parties,
      Mycroscope is their operator), Information Officer registration, breach-notification procedure.
- [ ] Supabase on a paid plan with point-in-time recovery or daily backups, and a region close to customers.
- [ ] GitHub Actions CI green on `main`.
