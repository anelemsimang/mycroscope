# Mycroscope desktop agent (Windows)

Records which application and website an employee is using, and whether they are active, idle (no input),
away (locked/asleep) or paused, then uploads it to Supabase. It never records keystrokes, screenshots,
webcam, microphone or file contents. What it records is set by the organisation (Settings -> Monitoring &
privacy in the web/mobile app) and shown to the employee in a monitoring notice they must acknowledge.

## Run from source (development)

```powershell
cd desktop_app
python -m venv venv
.\venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env      # then fill in SUPABASE_URL and SUPABASE_KEY (anon/public key only)
.\venv\Scripts\python.exe main.py
```

`.env` settings:

| Setting | Meaning |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon/public key (never the service_role key) |
| `WEB_APP_URL` | Optional. Web app address; password-reset emails link to `<address>/auth/reset-password` |

## How it behaves

- **Sign-in:** employee code or email and password. New employees activate with the employee code and
  one-time activation code their manager gets when adding them.
- **Notice:** tracking only starts after the employee acknowledges the current monitoring notice. When the
  organisation changes settings, the new notice appears within about 5 minutes; anything it adds is not
  recorded until the employee acknowledges it, while anything it removes stops immediately.
- **Tray and taskbar:** while tracking, closing the window minimises it; the tray icon stays. Signing out
  stops tracking. Pausing (if the organisation allows it) is recorded.
- **Offline:** activity is queued in a local database and uploaded when the connection returns.
- **Working hours:** if the organisation chooses "working hours only", nothing is recorded outside the
  schedule (the tray shows "Outside working hours"). If it also turns on "flag after-hours use", the agent
  only notes, at most once an hour, that the PC was in use after hours: no apps, titles or websites.
- **Subscription:** when the organisation's subscription is not active, the agent stops recording and says so.
- **Integrity checks** (if the organisation turns them on; all listed in the notice): gaps where the agent
  was not running while the PC was awake during working hours, virtual machines, remote desktop sessions,
  and machine-like input rhythms (mouse jigglers). These raise alerts for managers; they never block work.
- **Data and logs:** `%LOCALAPPDATA%\Mycroscope` (`agent.db`, `logs\agent.log`). Sign-in tokens are encrypted
  with Windows DPAPI for the signed-in user.

## Tests

```powershell
.\venv\Scripts\python.exe -m unittest discover -s tests -p "test_*.py"
```

`tests/live_e2e.py` is an optional end-to-end test against a real Supabase project. It creates a throwaway
"E2E Test" organisation (not removed afterwards) and needs "Confirm email" turned off, or
`--owner-email/--owner-password` for an already confirmed owner.

## Build and install on employee PCs

See `installer/README.txt`. `build.ps1` produces a self-contained `Mycroscope.exe`, install/uninstall scripts and
an update package. Company PCs should use the all-users install (`install-machine.ps1`, administrator): the
agent then starts for every user, restarts if closed, cannot be removed by standard users, and updates itself
from signed builds. Personal PCs can use the per-user install (`install.ps1`, no admin rights).

Code signing: set `SIGN_CERT_THUMBPRINT` (certificate in the Windows store) or `SIGN_PFX_PATH` and
`SIGN_PFX_PASSWORD` before running `build.ps1`. Unsigned builds work but trigger SmartScreen warnings and
cannot be delivered by the auto-updater.
