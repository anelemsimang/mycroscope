# Installs the Mycroscope agent for the current Windows user (no admin rights needed).
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-SupabaseUrl URL -SupabaseKey ANON_KEY] [-WebAppUrl URL] [-InstallKey KEY]
# Without parameters it uses agent.env next to this script, or keeps an existing configuration.
# The company install key (from the manager app: Settings -> Organisation) is required for a new install.
param(
    [string]$SupabaseUrl,
    [string]$SupabaseKey,
    [string]$WebAppUrl,
    [string]$InstallKey
)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'Mycroscope'
$target = Join-Path $env:LOCALAPPDATA 'Programs\Mycroscope'
$dataDir = Join-Path $env:LOCALAPPDATA 'Mycroscope'
$envFile = Join-Path $dataDir 'agent.env'

if (-not (Test-Path (Join-Path $source 'Mycroscope.exe'))) { throw "Mycroscope.exe not found under $source" }

function Read-EnvFile($path) {
    $h = @{}
    if (Test-Path $path) {
        foreach ($line in Get-Content $path) {
            if ($line -match '^\s*([A-Za-z_]+)\s*=\s*(.*)$') { $h[$Matches[1]] = $Matches[2].Trim() }
        }
    }
    return $h
}

function Test-InstallKey($url, $anon, $key) {
    if (-not $key) { throw 'No install key. Pass -InstallKey (ask your manager for the company install key).' }
    try {
        $resp = Invoke-RestMethod -Method Post -Uri "$($url.TrimEnd('/'))/rest/v1/rpc/verify_install_key" `
            -Headers @{ apikey = $anon; Authorization = "Bearer $anon"; 'Content-Type' = 'application/json' } `
            -Body (@{ p_key = $key } | ConvertTo-Json) -TimeoutSec 15
    } catch {
        Write-Warning "Could not check the install key online ($($_.Exception.Message)); continuing with the key as given."
        return
    }
    if (-not $resp -or @($resp).Count -eq 0) { throw 'That install key is not valid. Ask your manager for the current company install key.' }
    Write-Host "Install key verified for $(@($resp)[0].organization_name)."
}

# Merge configuration: existing install, then agent.env beside this script, then parameters (highest priority).
$cfg = Read-EnvFile $envFile
$beside = Read-EnvFile (Join-Path $PSScriptRoot 'agent.env')
foreach ($k in $beside.Keys) { $cfg[$k] = $beside[$k] }
if ($SupabaseUrl) { $cfg['SUPABASE_URL'] = $SupabaseUrl }
if ($SupabaseKey) { $cfg['SUPABASE_KEY'] = $SupabaseKey }
if ($WebAppUrl) { $cfg['WEB_APP_URL'] = $WebAppUrl }
if ($InstallKey) { $cfg['INSTALL_KEY'] = $InstallKey }

if (-not $cfg['SUPABASE_URL'] -or -not $cfg['SUPABASE_KEY']) {
    throw 'No configuration: pass -SupabaseUrl and -SupabaseKey, or put agent.env next to install.ps1.'
}
Test-InstallKey $cfg['SUPABASE_URL'] $cfg['SUPABASE_KEY'] $cfg['INSTALL_KEY']

Get-Process Mycroscope -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

New-Item -ItemType Directory -Force $target, $dataDir | Out-Null
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)" }

$utf8 = New-Object Text.UTF8Encoding $false
$out = ($cfg.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`r`n"
[IO.File]::WriteAllText($envFile, $out + "`r`n", $utf8)

$exe = Join-Path $target 'Mycroscope.exe'
& $exe --install-autostart | Out-Null
Start-Process $exe
Write-Host "Mycroscope installed to $target and set to start when you sign in to Windows."
