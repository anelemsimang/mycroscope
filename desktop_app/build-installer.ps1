# Builds dist\Mycroscope-Setup.exe from the already-built dist\Mycroscope folder (run build.ps1 first).
# Supabase settings are read from dist\agent.env and baked into the installer, so testers only enter the
# company install key. Requires Inno Setup 6 (https://jrsoftware.org/isdl.php).
#   powershell -ExecutionPolicy Bypass -File build-installer.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path 'dist\Mycroscope\Mycroscope.exe')) { throw 'Run build.ps1 first (dist\Mycroscope\Mycroscope.exe is missing).' }

$envPath = @('dist\agent.env', '.env') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $envPath) { throw 'Create dist\agent.env (or .env) with SUPABASE_URL and SUPABASE_KEY (copy from .env.example).' }
$cfg = @{}
foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*([A-Za-z_]+)\s*=\s*(.*)$') { $cfg[$Matches[1]] = $Matches[2].Trim() }
}
if (-not $cfg['SUPABASE_URL'] -or -not $cfg['SUPABASE_KEY']) { throw "$envPath needs SUPABASE_URL and SUPABASE_KEY." }

$iscc = @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php (ISCC.exe).' }

$version = (& '.\venv\Scripts\python.exe' -c 'from config import VERSION; print(VERSION)').Trim()

$defs = @(
    "/DMyAppVersion=$version",
    "/DSourceDir=$PSScriptRoot\dist",
    "/DOutDir=$PSScriptRoot\dist",
    "/DSupabaseUrl=$($cfg['SUPABASE_URL'])",
    "/DSupabaseKey=$($cfg['SUPABASE_KEY'])"
)
if ($cfg['WebAppUrl'] -or $cfg['WEB_APP_URL']) { $defs += "/DWebAppUrl=$($cfg['WEB_APP_URL'])" }
if ($cfg['INSTALL_KEY']) { $defs += "/DInstallKey=$($cfg['INSTALL_KEY'])" }

& $iscc @defs 'installer\mycroscope.iss' | Out-Null
if ($LASTEXITCODE) { throw "Inno Setup compile failed ($LASTEXITCODE)." }
Write-Host "Built dist\Mycroscope-Setup.exe (v$version). Send this one file to testers."
