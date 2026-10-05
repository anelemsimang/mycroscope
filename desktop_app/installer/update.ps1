# Installs a newer agent from the configured update source. Runs daily as SYSTEM (install-machine.ps1).
# The update is applied only when:
#   * the manifest's version is newer than the installed one,
#   * the download's SHA-256 matches the manifest, and
#   * Mycroscope.exe in it has a valid Authenticode signature by the pinned certificate (UPDATE_SIGNER_THUMBPRINT).
# Manifest (JSON): { "version": "2.1.0", "url": "https://.../Mycroscope-2.1.0.zip", "sha256": "..." }
$ErrorActionPreference = 'Stop'
$target = $PSScriptRoot
$configFile = Join-Path $env:ProgramData 'Mycroscope\agent.env'
$logFile = Join-Path $env:ProgramData 'Mycroscope\update.log'
function Log($message) { Add-Content -Path $logFile -Value "$(Get-Date -Format s) $message" }

try {
    $config = @{}
    Get-Content $configFile | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$' } |
        ForEach-Object { $config[$Matches[1]] = $Matches[2].Trim() }
    $manifestUrl = $config['UPDATE_MANIFEST_URL']
    $thumbprint = ($config['UPDATE_SIGNER_THUMBPRINT'] -replace '\s', '').ToUpperInvariant()
    if (-not $manifestUrl) { return }
    if (-not $manifestUrl.StartsWith('https://')) { throw 'UPDATE_MANIFEST_URL must use https' }
    if (-not $thumbprint) { throw 'UPDATE_SIGNER_THUMBPRINT is not set; refusing to install unsigned updates' }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing -TimeoutSec 60
    $installed = [version](Get-Item (Join-Path $target 'Mycroscope.exe')).VersionInfo.ProductVersion
    $offered = [version]$manifest.version
    if ($offered -le $installed) { return }
    if (-not "$($manifest.url)".StartsWith('https://')) { throw 'Update URL must use https' }

    $work = Join-Path $env:TEMP "mycroscope-update-$([guid]::NewGuid())"
    New-Item -ItemType Directory $work | Out-Null
    try {
        $zip = Join-Path $work 'update.zip'
        Invoke-WebRequest -Uri $manifest.url -OutFile $zip -UseBasicParsing -TimeoutSec 600
        $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
        if ($hash -ne "$($manifest.sha256)".ToUpperInvariant()) { throw "Checksum mismatch ($hash)" }
        Expand-Archive $zip -DestinationPath $work
        $exe = Join-Path $work 'Mycroscope\Mycroscope.exe'
        $sig = Get-AuthenticodeSignature $exe
        if ($sig.Status -ne 'Valid') { throw "Signature not valid: $($sig.Status)" }
        if ($sig.SignerCertificate.Thumbprint -ne $thumbprint) {
            throw "Signed by an unexpected certificate ($($sig.SignerCertificate.Thumbprint))"
        }

        Get-Process Mycroscope -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 1
        robocopy (Join-Path $work 'Mycroscope') $target /E /NFL /NDL /NJH /NJS /NP /XF machine-install update.ps1 | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "Copy failed (robocopy $LASTEXITCODE)" }
        Log "Updated $installed -> $offered"
        # The watchdog task restarts the agent for signed-in users within 5 minutes.
    } finally {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
    }
} catch {
    Log "Update failed: $_"
    exit 1
}
