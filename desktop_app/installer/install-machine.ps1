# Installs the Mycroscope agent for every user of this PC. Run as administrator (or from Intune/GPO/RMM as SYSTEM).
#   powershell -ExecutionPolicy Bypass -File install-machine.ps1 [-SupabaseUrl URL -SupabaseKey ANON_KEY]
#       [-WebAppUrl URL] [-UpdateManifestUrl URL -UpdateSignerThumbprint THUMBPRINT]
# Without parameters it uses agent.env next to this script, or keeps an existing configuration.
#
# Employees (standard users) cannot remove or reconfigure it: the program lives in Program Files,
# the configuration in ProgramData (read-only for users) and the scheduled tasks belong to the administrator.
param(
    [string]$SupabaseUrl,
    [string]$SupabaseKey,
    [string]$WebAppUrl,
    [string]$InstallKey,
    [string]$UpdateManifestUrl,
    [string]$UpdateSignerThumbprint
)
$ErrorActionPreference = 'Stop'

function Test-InstallKey($url, $anon, $key) {
    if (-not $key) { throw 'No install key. Pass -InstallKey (the company install key from the manager app).' }
    try {
        $resp = Invoke-RestMethod -Method Post -Uri "$($url.TrimEnd('/'))/rest/v1/rpc/verify_install_key" `
            -Headers @{ apikey = $anon; Authorization = "Bearer $anon"; 'Content-Type' = 'application/json' } `
            -Body (@{ p_key = $key } | ConvertTo-Json) -TimeoutSec 15
    } catch {
        Write-Warning "Could not check the install key online ($($_.Exception.Message)); continuing with the key as given."
        return
    }
    if (-not $resp -or @($resp).Count -eq 0) { throw 'That install key is not valid. Check it in the manager app (Settings -> Organisation).' }
    Write-Host "Install key verified for $(@($resp)[0].organization_name)."
}

function Get-EnvVal($lines, $name) {
    $match = $lines | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -First 1
    if ($match) { return ($match -replace "^\s*$name\s*=\s*", '').Trim() }
    return $null
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this script as administrator (right-click PowerShell -> Run as administrator).'
}

$source = Join-Path $PSScriptRoot 'Mycroscope'
$target = Join-Path $env:ProgramFiles 'Mycroscope'
$configDir = Join-Path $env:ProgramData 'Mycroscope'
$envFile = Join-Path $configDir 'agent.env'
if (-not (Test-Path (Join-Path $source 'Mycroscope.exe'))) { throw "Mycroscope.exe not found under $source" }

# A per-user install on this PC would run a second copy; remove its tasks (its files are harmless).
schtasks /Delete /TN "Mycroscope Agent" /F 2>$null | Out-Null
schtasks /Delete /TN "Mycroscope Agent Watchdog" /F 2>$null | Out-Null

Get-Process Mycroscope -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force $target, $configDir | Out-Null
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)" }
Set-Content -Path (Join-Path $target 'machine-install') -Value 'Installed for all users by an administrator.'
Copy-Item (Join-Path $PSScriptRoot 'update.ps1') $target -Force -ErrorAction SilentlyContinue

# Configuration: administrators and SYSTEM may change it; users may only read it.
$utf8 = New-Object Text.UTF8Encoding $false
$lines = @()
if ($SupabaseUrl -and $SupabaseKey) {
    $lines += "SUPABASE_URL=$SupabaseUrl", "SUPABASE_KEY=$SupabaseKey"
    if ($WebAppUrl) { $lines += "WEB_APP_URL=$WebAppUrl" }
} elseif (Test-Path (Join-Path $PSScriptRoot 'agent.env')) {
    $lines += Get-Content (Join-Path $PSScriptRoot 'agent.env') | Where-Object { $_ -notmatch '^\s*UPDATE_' }
} elseif (Test-Path $envFile) {
    $lines += Get-Content $envFile | Where-Object { $_ -notmatch '^\s*UPDATE_' }
} else {
    throw "No configuration: pass -SupabaseUrl and -SupabaseKey, or put agent.env next to this script."
}
if ($InstallKey) { $lines = @($lines | Where-Object { $_ -notmatch '^\s*INSTALL_KEY\s*=' }) + "INSTALL_KEY=$InstallKey" }
Test-InstallKey (Get-EnvVal $lines 'SUPABASE_URL') (Get-EnvVal $lines 'SUPABASE_KEY') (Get-EnvVal $lines 'INSTALL_KEY')
if ($UpdateManifestUrl) { $lines += "UPDATE_MANIFEST_URL=$UpdateManifestUrl" }
if ($UpdateSignerThumbprint) { $lines += "UPDATE_SIGNER_THUMBPRINT=$($UpdateSignerThumbprint -replace '\s', '')" }
[IO.File]::WriteAllText($envFile, (($lines -join "`r`n") + "`r`n"), $utf8)

$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$inherit = 'ContainerInherit,ObjectInherit'
foreach ($rule in @(
    @('*S-1-5-18', 'FullControl'),       # SYSTEM
    @('*S-1-5-32-544', 'FullControl'),   # Administrators
    @('*S-1-5-32-545', 'ReadAndExecute') # Users
)) {
    $sid = New-Object Security.Principal.SecurityIdentifier($rule[0].TrimStart('*'))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, $rule[1], $inherit, 'None', 'Allow')))
}
Set-Acl -Path $configDir -AclObject $acl
Get-ChildItem $configDir -Recurse -Force | ForEach-Object {
    $fileAcl = Get-Acl $_.FullName
    $fileAcl.SetAccessRuleProtection($false, $false)
    Set-Acl $_.FullName $fileAcl
}

# Tasks for every member of the Users group: start at sign-in, and restart within 5 minutes if stopped.
$exe = Join-Path $target 'Mycroscope.exe'
$users = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
$logon = New-ScheduledTaskTrigger -AtLogOn
$logon.Delay = 'PT10S'
Register-ScheduledTask -TaskPath '\Mycroscope\' -TaskName 'Agent' -Force -Principal $users -Settings $settings `
    -Trigger $logon -Action (New-ScheduledTaskAction -Execute $exe -Argument '--hidden' -WorkingDirectory $target) `
    -Description 'Starts the Mycroscope activity agent when a user signs in.' | Out-Null
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskPath '\Mycroscope\' -TaskName 'Watchdog' -Force -Principal $users -Settings $settings `
    -Trigger $every5 -Action (New-ScheduledTaskAction -Execute $exe -Argument '--watchdog' -WorkingDirectory $target) `
    -Description 'Restarts the Mycroscope agent if it is not running.' | Out-Null

# Daily signed update check, as SYSTEM (only when an update source is configured).
if ((Get-Content $envFile) -match '^UPDATE_MANIFEST_URL=') {
    $system = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $daily = New-ScheduledTaskTrigger -Daily -At '12:30'
    $daily.RandomDelay = 'PT2H'
    $updateArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $target 'update.ps1')`""
    Register-ScheduledTask -TaskPath '\Mycroscope\' -TaskName 'Updater' -Force -Principal $system -Settings $settings `
        -Trigger $daily -Action (New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $updateArgs) `
        -Description 'Installs signed Mycroscope agent updates.' | Out-Null
}

Write-Host "Mycroscope installed for all users in $target."
Write-Host "It starts at each user's next sign-in (or within 5 minutes for users already signed in)."
