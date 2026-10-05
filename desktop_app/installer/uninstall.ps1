# Removes the Mycroscope agent for the current Windows user.
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-RemoveData]
# -RemoveData also deletes the local queue, saved sign-in and logs. Data not yet uploaded is lost.
param([switch]$RemoveData)
$ErrorActionPreference = 'Continue'
$target = Join-Path $env:LOCALAPPDATA 'Programs\Mycroscope'

schtasks /Delete /TN "Mycroscope Agent" /F 2>$null | Out-Null
schtasks /Delete /TN "Mycroscope Agent Watchdog" /F 2>$null | Out-Null
Get-Process Mycroscope -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
if ($RemoveData) { Remove-Item (Join-Path $env:LOCALAPPDATA 'Mycroscope') -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "Mycroscope removed."
