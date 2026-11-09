@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ========================================================
echo   SA-CHAOS P2P DIRECT VPS SEEDER SYNC (IPv6 DUPLEX)
echo ========================================================
echo.

set "APP_VERSION=%~1"
if "%APP_VERSION%"=="" (
    if exist "version.txt" (
        for /f "delims=" %%a in ('node -e "const fs=require('fs'); console.log(fs.readFileSync('version.txt','utf8').trim());"') do set "APP_VERSION=%%a"
    )
)
if "%APP_VERSION%"=="" (
    for /f "delims=" %%a in ('node -p "require('./package.json').version"') do set "APP_VERSION=%%a"
)
if "%APP_VERSION%"=="" set "APP_VERSION=1.0.67"

echo [i] Target Release Version : %APP_VERSION%
echo [i] VPS Seeder Host        : ubuntu@2406:da1c:11f2:14b:dc34:88da:9283:b479
echo [i] P2P Config Repository  : https://github.com/AthallahDzaki/SA-CHAOS-P2P-CONFIG
echo.

if not exist "Releases\SA-CHAOS-%APP_VERSION%-full.nupkg" (
    echo [ERROR] File Releases\SA-CHAOS-%APP_VERSION%-full.nupkg tidak ditemukan!
    echo Silakan selesaikan 'build.bat' terlebih dahulu untuk membuat paket rilis.
    echo.
    pause
    exit /b 1
)

echo [1/1] Menandatangani Release Index ^& Mengunggah langsung ke VPS Seeder...
call node scripts/publish-p2p-release.js ^
  --releases-dir Releases ^
  --version %APP_VERSION% ^
  --private-key keys\publisher-ed25519-private.pem ^
  --public-key keys\publisher-ed25519-public.pem ^
  --key-id publisher-2026 ^
  --vps-host ubuntu@2406:da1c:11f2:14b:dc34:88da:9283:b479 ^
  --vps-ssh-key ..\sa-chaos.pem

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Gagal sinkronisasi langsung ke VPS!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ================================================================
echo  SUKSES! SA-CHAOS v%APP_VERSION% (Full + Delta + Signed Index)
echo  berhasil disinkronkan langsung ke VPS Seeder!
echo  VPS sekarang aktif men-seed versi ini.
echo ================================================================
echo.
pause
