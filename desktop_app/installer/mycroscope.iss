; Mycroscope desktop agent - Windows setup wizard (Inno Setup 6).
; Build with build-installer.ps1, which fills in the Supabase settings from dist\agent.env and the version,
; then produces dist\Mycroscope-Setup.exe. Per-user install (no administrator rights), to match install.ps1.
;
; The wizard asks for the company install key and checks it online before installing, so a tester only
; double-clicks the file, enters the key the manager gave them, and activates with their employee codes.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "dist"
#endif
#ifndef OutDir
  #define OutDir "dist"
#endif
#ifndef SupabaseUrl
  #define SupabaseUrl ""
#endif
#ifndef SupabaseKey
  #define SupabaseKey ""
#endif
#ifndef WebAppUrl
  #define WebAppUrl ""
#endif
#ifndef InstallKey
  #define InstallKey ""
#endif

[Setup]
AppId={{B6F1E3C2-9A4D-4E77-8C21-9E5A1D7F2B10}
AppName=Mycroscope
AppVersion={#MyAppVersion}
AppPublisher=Mycroscope
DefaultDirName={localappdata}\Programs\Mycroscope
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir={#OutDir}
OutputBaseFilename=Mycroscope-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile=..\assets\mycroscope.ico
UninstallDisplayIcon={app}\Mycroscope.exe
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#SourceDir}\Mycroscope\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Run]
Filename: "{app}\Mycroscope.exe"; Parameters: "--install-autostart"; Flags: runhidden waituntilterminated
Filename: "{app}\Mycroscope.exe"; Description: "Start Mycroscope now"; Flags: nowait postinstall skipifsilent

[UninstallRun]
; Tell the managers this PC is being removed, then stop the agent and remove its scheduled tasks.
Filename: "{app}\Mycroscope.exe"; Parameters: "--report-uninstall"; Flags: runhidden; RunOnceId: "ReportUninstall"
Filename: "{sys}\taskkill.exe"; Parameters: "/IM Mycroscope.exe /F"; Flags: runhidden; RunOnceId: "StopAgent"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""Mycroscope Agent"" /F"; Flags: runhidden; RunOnceId: "TaskAgent"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN ""Mycroscope Agent Watchdog"" /F"; Flags: runhidden; RunOnceId: "TaskWatchdog"

[Code]
var
  KeyPage: TInputQueryWizardPage;
  GInstallKey: String;

procedure InitializeWizard;
begin
  KeyPage := CreateInputQueryPage(wpWelcome,
    'Company install key',
    'Enter the key your manager gave you',
    'Mycroscope can only be installed with your organisation''s install key. ' +
    'Find it in the Mycroscope manager app under Settings > Organisation > Agent install key.');
  KeyPage.Add('Install key (for example MYC-XXXX-XXXX-XXXX-XXXX):', False);
  KeyPage.Values[0] := '{#InstallKey}';
end;

{ Returns 1 if the key is valid, 0 if the server rejected it, -1 if it could not be checked. }
function VerifyKey(Key: String): Integer;
var
  Http: Variant;
begin
  Result := -1;
  if '{#SupabaseUrl}' = '' then
    exit;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.Open('POST', '{#SupabaseUrl}/rest/v1/rpc/verify_install_key', False);
    Http.SetRequestHeader('apikey', '{#SupabaseKey}');
    Http.SetRequestHeader('Authorization', 'Bearer {#SupabaseKey}');
    Http.SetRequestHeader('Content-Type', 'application/json');
    Http.Send('{"p_key":"' + Key + '"}');
    if Integer(Http.Status) = 200 then
    begin
      if Pos('organization_id', String(Http.ResponseText)) > 0 then
        Result := 1
      else
        Result := 0;
    end;
  except
    Result := -1;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Verdict: Integer;
begin
  Result := True;
  if CurPageID = KeyPage.ID then
  begin
    GInstallKey := Trim(KeyPage.Values[0]);
    if GInstallKey = '' then
    begin
      MsgBox('Enter the company install key. Ask your manager if you do not have it.', mbError, MB_OK);
      Result := False;
      exit;
    end;
    Verdict := VerifyKey(GInstallKey);
    if Verdict = 0 then
    begin
      MsgBox('That install key is not valid. Check it in the manager app (Settings > Organisation).', mbError, MB_OK);
      Result := False;
    end
    else if Verdict = -1 then
      MsgBox('Could not check the install key online (no internet connection). Installation will continue with the key as entered.',
        mbInformation, MB_OK);
  end;
end;

procedure WriteAgentEnv;
var
  DataDir: String;
  Content: String;
begin
  DataDir := ExpandConstant('{localappdata}\Mycroscope');
  ForceDirectories(DataDir);
  Content := 'SUPABASE_URL={#SupabaseUrl}'#13#10 + 'SUPABASE_KEY={#SupabaseKey}'#13#10;
#if WebAppUrl != ""
  Content := Content + 'WEB_APP_URL={#WebAppUrl}'#13#10;
#endif
  Content := Content + 'INSTALL_KEY=' + GInstallKey + #13#10;
  SaveStringToFile(DataDir + '\agent.env', Content, False);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  { Close any running agent so its files can be replaced. }
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM Mycroscope.exe /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteAgentEnv;
end;
