# Removes an all-users Mycroscope install. Run as administrator.
#   powershell -ExecutionPolicy Bypass -File uninstall-machine.ps1 [-RemoveConfig]
# Each user's local queue and logs (%LOCALAPPDATA%\Mycroscope) are left in place.
param([switch]$RemoveConfig)
$ErrorActionPreference = 'Continue'

foreach ($name in 'Agent', 'Watchdog', 'Updater') {
    Unregister-ScheduledTask -TaskPath '\Mycroscope\' -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
}
# Best effort: tell the managers this PC is being removed (uses the PC's existing report key).
$exe = Join-Path (Join-Path $env:ProgramFiles 'Mycroscope') 'Mycroscope.exe'
if (Test-Path $exe) { try { & $exe --report-uninstall 2>$null | Out-Null } catch {} }
Get-Process Mycroscope -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item (Join-Path $env:ProgramFiles 'Mycroscope') -Recurse -Force -ErrorAction SilentlyContinue
if ($RemoveConfig) { Remove-Item (Join-Path $env:ProgramData 'Mycroscope') -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host 'Mycroscope removed for all users.'
