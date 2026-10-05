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
- **Settings -> Compliance** (owners and managers): what is recorded, retention, Information Officer, notice text,
  who has acknowledged the notice, notice history and the audit log.
- Employees who sign in see only their own activity.

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
npm test        # runs the migrations in an in-process Postgres and checks security, reporting and retention rules
```
