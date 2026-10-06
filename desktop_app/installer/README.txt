Mycroscope desktop agent - installing on employee PCs
=====================================================

1. Build once (developer PC):  powershell -ExecutionPolicy Bypass -File build.ps1
   This produces the dist folder containing:
       Mycroscope\              the program
       install.ps1 / uninstall.ps1                   per-user install (no admin rights)
       install-machine.ps1 / uninstall-machine.ps1   all-users install (administrator)
       update.ps1               signed auto-updater (used by the all-users install)
       release\                 Mycroscope-<version>.zip + manifest.json for auto-updates
   Sign builds you ship: see the top of build.ps1 (SIGN_CERT_THUMBPRINT or SIGN_PFX_PATH).

1b. One-click installer for non-technical testers (recommended): after build.ps1, run
       powershell -ExecutionPolicy Bypass -File build-installer.ps1
    This needs Inno Setup 6 (https://jrsoftware.org/isdl.php) and reads SUPABASE_URL/SUPABASE_KEY from
    dist\agent.env (or .env). It produces dist\Mycroscope-Setup.exe - a single file you send to testers.
    They double-click it, enter the company install key (checked online), and the agent installs for their user
    and starts. Uninstall is through Windows Settings -> Apps. Unsigned builds show a SmartScreen warning
    ("More info -> Run anyway") until you code-sign (see build.ps1).

2. In dist, copy .env.example to agent.env and fill in SUPABASE_URL and SUPABASE_KEY
   (Supabase -> Project Settings -> API, the anon/public key - never the service_role key), and INSTALL_KEY
   (the company install key from the manager app -> Settings -> Organisation). The installer checks the key.
   Optionally set WEB_APP_URL to the web app's address so password-reset emails open its reset page.

3a. Company-managed PCs (recommended): as administrator, or from Intune / GPO / your RMM tool, run
       powershell -ExecutionPolicy Bypass -File install-machine.ps1
           [-UpdateManifestUrl https://.../manifest.json -UpdateSignerThumbprint <certificate thumbprint>]

   - Installs to C:\Program Files\Mycroscope; configuration in C:\ProgramData\Mycroscope\agent.env
     (users can read but not change it).
   - Scheduled tasks under \Mycroscope\ for every user: "Agent" (starts at sign-in, in the tray) and
     "Watchdog" (restarts it within 5 minutes if it is closed or killed). Standard users cannot remove them.
   - With an update source: "Updater" runs daily as SYSTEM and installs a newer version only if its checksum
     matches and Mycroscope.exe is signed by the pinned certificate. Log: C:\ProgramData\Mycroscope\update.log
   - Remove with uninstall-machine.ps1 (as administrator).

3b. Personal or unmanaged PCs: signed in as the employee, run
       powershell -ExecutionPolicy Bypass -File install.ps1 [-InstallKey MYC-XXXX-XXXX-XXXX-XXXX]

   - Installs to %LOCALAPPDATA%\Programs\Mycroscope (no admin rights needed); config in
     %LOCALAPPDATA%\Mycroscope\agent.env. The employee can uninstall it; the manager sees that the PC
     stopped reporting.
   - Registers "Mycroscope Agent" and "Mycroscope Agent Watchdog" for that user.

4. The employee activates their account in the window with the employee code and activation code
   from their manager, then reads and acknowledges the monitoring notice.

Publishing an update (all-users installs):
   build with -UpdateBaseUrl https://your-download-host/agent, upload dist\release\Mycroscope-<version>.zip
   and dist\release\manifest.json there, and point -UpdateManifestUrl at the manifest.

Upgrading by hand: run the new install script again; configuration and queued data are kept.
