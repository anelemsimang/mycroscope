# Builds dist\Mycroscope (a folder with Mycroscope.exe) plus the install scripts.
# Usage:  powershell -ExecutionPolicy Bypass -File build.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path venv)) { python -m venv venv }
$py = '.\venv\Scripts\python.exe'
& $py -m pip install -q -r requirements.txt "pyinstaller>=6.10,<7"
if ($LASTEXITCODE) { throw 'pip install failed' }

New-Item -ItemType Directory -Force build | Out-Null
& $py -c "from ui.app_ui import _tray_image; from config import THEME_COLORS as C; _tray_image(C['success']).save('build/mycroscope.ico', sizes=[(16,16),(32,32),(48,48),(64,64)])"
if ($LASTEXITCODE) { throw 'icon generation failed' }

& $py -m PyInstaller --noconfirm --clean --windowed --name Mycroscope `
    --icon build\mycroscope.ico `
    --hidden-import pystray._win32 `
    --hidden-import win32timezone `
    --collect-all uiautomation `
    --collect-data tzdata `
    main.py
if ($LASTEXITCODE) { throw 'PyInstaller failed' }

Copy-Item installer\install.ps1, installer\uninstall.ps1, .env.example -Destination dist\
Write-Host "`nBuilt dist\Mycroscope\Mycroscope.exe"
Write-Host "Distribute the whole dist folder; employees run install.ps1 (see installer\README.txt)."
