# Installs the Mycroscope agent for the current Windows user (no admin rights needed).
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-SupabaseUrl URL -SupabaseKey ANON_KEY]
# Without parameters it uses agent.env next to this script, or keeps an existing configuration.
param(
    [string]$SupabaseUrl,
    [string]$SupabaseKey
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'Mycroscope'
$target = Join-Path $env:LOCALAPPDATA 'Programs\Mycroscope'
$dataDir = Join-Path $env:LOCALAPPDATA 'Mycroscope'
$envFile = Join-Path $dataDir 'agent.env'

if (-not (Test-Path (Join-Path $source 'Mycroscope.exe'))) { throw "Mycroscope.exe not found under $source" }

Get-Process Mycroscope -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force $target, $dataDir | Out-Null
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)" }

$utf8 = New-Object Text.UTF8Encoding $false
if ($SupabaseUrl -and $SupabaseKey) {
    [IO.File]::WriteAllText($envFile, "SUPABASE_URL=$SupabaseUrl`r`nSUPABASE_KEY=$SupabaseKey`r`n", $utf8)
} elseif (Test-Path (Join-Path $PSScriptRoot 'agent.env')) {
    Copy-Item (Join-Path $PSScriptRoot 'agent.env') $envFile -Force
} elseif (-not (Test-Path $envFile)) {
    throw "No configuration: pass -SupabaseUrl and -SupabaseKey, or put agent.env next to install.ps1."
}

$exe = Join-Path $target 'Mycroscope.exe'
& $exe --install-autostart | Out-Null
Start-Process $exe
Write-Host "Mycroscope installed to $target and set to start when you sign in to Windows."
