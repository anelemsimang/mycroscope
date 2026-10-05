Mycroscope desktop agent - installing on an employee PC
=======================================================

1. Build once (developer PC):  powershell -ExecutionPolicy Bypass -File build.ps1
   This produces the dist folder containing:  Mycroscope\  install.ps1  uninstall.ps1  .env.example

2. In dist, copy .env.example to agent.env and fill in SUPABASE_URL and SUPABASE_KEY
   (Supabase -> Project Settings -> API, the anon/public key - never the service_role key).
   Optionally set WEB_APP_URL to the web app's address so password-reset emails open its reset page.

3. Copy the dist folder to the employee PC (USB, network share, zip) and, signed in as the employee, run:
       powershell -ExecutionPolicy Bypass -File install.ps1

   - Installs to %LOCALAPPDATA%\Programs\Mycroscope (no admin rights needed).
   - Configuration lives in %LOCALAPPDATA%\Mycroscope\agent.env; local data and logs in the same folder.
   - Registers two scheduled tasks for that user: "Mycroscope Agent" (starts at sign-in, in the tray)
     and "Mycroscope Agent Watchdog" (restarts the agent within 5 minutes if it crashes or is killed;
     it stays closed if the employee signs out and closes the window).

4. The employee activates their account in the window with the employee code and activation code
   from their manager, then reads and acknowledges the monitoring notice.

Upgrading: run the new install.ps1; the existing configuration and queued data are kept.
Removing:  powershell -ExecutionPolicy Bypass -File uninstall.ps1   (add -RemoveData to delete local data)
