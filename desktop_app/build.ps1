# Builds dist\Mycroscope (a folder with Mycroscope.exe) plus the install scripts.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1 [-UpdateBaseUrl https://downloads.example.com/agent]
#
# Code signing (recommended for anything you ship): set ONE of
#   $env:SIGN_CERT_THUMBPRINT   a code-signing certificate in the current user's or machine's store, or
#   $env:SIGN_PFX_PATH (+ $env:SIGN_PFX_PASSWORD)   a .pfx file
# and optionally $env:SIGN_TIMESTAMP_URL (default http://timestamp.digicert.com).
# Unsigned builds work but trigger SmartScreen warnings and cannot be delivered by the signed updater.
param([string]$UpdateBaseUrl)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path venv)) { python -m venv venv }
$py = '.\venv\Scripts\python.exe'
& $py -m pip install -q -r requirements.txt "pyinstaller>=6.10,<7"
if ($LASTEXITCODE) { throw 'pip install failed' }

New-Item -ItemType Directory -Force build | Out-Null

$utf8 = New-Object Text.UTF8Encoding $false
$version = (& $py -c "from config import VERSION; print(VERSION)").Trim()
$parts = ($version.Split('.') + @('0', '0', '0', '0'))[0..3] -join ', '
$versionInfo = @"
VSVersionInfo(
  ffi=FixedFileInfo(filevers=($parts), prodvers=($parts)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Mycroscope'),
      StringStruct('FileDescription', 'Mycroscope activity agent'),
      StringStruct('FileVersion', '$version'),
      StringStruct('ProductName', 'Mycroscope'),
      StringStruct('ProductVersion', '$version')])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
"@
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'build\version.txt'), $versionInfo, $utf8)

# PyInstaller logs warnings to stderr; Windows PowerShell turns those into terminating errors under 'Stop'.
$ErrorActionPreference = 'Continue'
& $py -m PyInstaller --noconfirm --clean --windowed --name Mycroscope `
    --icon assets\mycroscope.ico `
    --add-data "assets;assets" `
    --version-file build\version.txt `
    --hidden-import pystray._win32 `
    --hidden-import win32timezone `
    --collect-all uiautomation `
    --collect-data tzdata `
    main.py
$pyInstallerExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($pyInstallerExit) { throw 'PyInstaller failed' }

$installers = 'install.ps1', 'uninstall.ps1', 'install-machine.ps1', 'uninstall-machine.ps1', 'update.ps1', 'README.txt'
Copy-Item ($installers | ForEach-Object { Join-Path installer $_ }) -Destination dist\
Copy-Item .env.example -Destination dist\

# ---- signing -------------------------------------------------------------
$cert = $null
if ($env:SIGN_CERT_THUMBPRINT) {
    $tp = $env:SIGN_CERT_THUMBPRINT -replace '\s', ''
    $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -CodeSigningCert | Where-Object Thumbprint -eq $tp | Select-Object -First 1
    if (-not $cert) { throw "Code-signing certificate $tp not found" }
} elseif ($env:SIGN_PFX_PATH) {
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2(
        (Resolve-Path $env:SIGN_PFX_PATH).Path, $env:SIGN_PFX_PASSWORD)
    if (-not $cert.HasPrivateKey) { throw 'The .pfx file has no private key' }
}
if ($cert) {
    $ts = if ($env:SIGN_TIMESTAMP_URL) { $env:SIGN_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }
    $targets = @('dist\Mycroscope\Mycroscope.exe') + ($installers | Where-Object { $_ -like '*.ps1' } | ForEach-Object { "dist\$_" })
    foreach ($file in $targets) {
        $result = Set-AuthenticodeSignature -FilePath $file -Certificate $cert -HashAlgorithm SHA256 -TimestampServer $ts
        if ($result.Status -ne 'Valid') { throw "Signing $file failed: $($result.StatusMessage)" }
    }
    Write-Host "Signed with $($cert.Subject) ($($cert.Thumbprint))"
} else {
    Write-Warning 'Not code-signed (set SIGN_CERT_THUMBPRINT or SIGN_PFX_PATH). Fine for testing; sign anything you ship.'
}

# ---- release package for the updater ----------------------------------------
New-Item -ItemType Directory -Force dist\release | Out-Null
$zip = "dist\release\Mycroscope-$version.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path dist\Mycroscope -DestinationPath $zip
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash
$url = if ($UpdateBaseUrl) { "$($UpdateBaseUrl.TrimEnd('/'))/Mycroscope-$version.zip" } else { "https://REPLACE-WITH-YOUR-DOWNLOAD-HOST/Mycroscope-$version.zip" }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'dist\release\manifest.json'),
    (@{ version = $version; url = $url; sha256 = $sha } | ConvertTo-Json), $utf8)

Write-Host "`nBuilt dist\Mycroscope\Mycroscope.exe (v$version)"
Write-Host "Release package: $zip and dist\release\manifest.json (upload both for signed auto-updates)."
Write-Host "Distribute the dist folder; see installer\README.txt for per-user and all-users installs."
