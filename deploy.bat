@echo off
setlocal
cd /d "%~dp0"

echo ========================================================
echo  SA-CHAOS UNIFIED DEPLOY: S3 ^& VPS SEEDER
echo ========================================================
echo.

:: 1. Tentukan Versi Target (dari argumen CLI, version.txt, atau package.json)
set "APP_VERSION=%~1"

if "%APP_VERSION%"=="" (
    if exist "version.txt" (
        for /f "delims=" %%a in ('node -e "const fs=require('fs'); console.log(fs.readFileSync('version.txt','utf8').trim());"') do set "APP_VERSION=%%a"
    )
)

if "%APP_VERSION%"=="" (
    for /f "delims=" %%a in ('node -p "require('./package.json').version"') do set "APP_VERSION=%%a"
)

if "%APP_VERSION%"=="" set "APP_VERSION=1.0.0"

echo [i] Target Release Version: %APP_VERSION%
echo.

:: 2. Validasi Binary Unpacked
if not exist "dist\win-unpacked\SA-CHAOS.exe" (
    echo [ERROR] Folder 'dist\win-unpacked' belum siap atau file SA-CHAOS.exe tidak ditemukan.
    echo Silakan jalankan 'build.bat' terlebih dahulu untuk mengompilasi aplikasi.
    echo.
    pause
    exit /b 1
)

:: 2.5 Bersihkan binary non-Windows (VfusionNix & VfusionMac) agar vpk pack tidak error
if exist "dist\win-unpacked\resources\app.asar.unpacked\node_modules\velopack\bin\VfusionNix" (
    del /f /q "dist\win-unpacked\resources\app.asar.unpacked\node_modules\velopack\bin\VfusionNix" >nul 2>&1
)
if exist "dist\win-unpacked\resources\app.asar.unpacked\node_modules\velopack\bin\VfusionMac" (
    del /f /q "dist\win-unpacked\resources\app.asar.unpacked\node_modules\velopack\bin\VfusionMac" >nul 2>&1
)

:: 3. Packaging dengan Velopack
echo [1/4] Packaging dengan Velopack v%APP_VERSION%...
call vpk pack -u SA-CHAOS -v %APP_VERSION% -p dist\win-unpacked -e SA-CHAOS.exe -o Releases --exclude "(.*\.pdb|.*VfusionNix|.*VfusionMac)"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Gagal melakukan packaging dengan Velopack.
    pause
    exit /b %ERRORLEVEL%
)

:: 4. Upload Paket ke CloudHost S3
echo.
echo [2/4] Mengunggah Paket Update ke CloudHost S3 (Bucket: sa-chaos)...
call vpk upload s3 ^
  --endpoint https://is3.cloudhost.id ^
  --keyId 64LHGNGM66GNV0GOSXY4 ^
  --secret E0airrFLcLaHt8qwCHaU1Qvo3R90e9qaAROqNg82 ^
  --bucket sa-chaos ^
  --prefix desktop/updates/ ^
  --outputDir Releases ^
  --keepMaxReleases 3
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Gagal mengunggah paket update ke S3.
    pause
    exit /b %ERRORLEVEL%
)

:: 5. Upload Changelog ke S3
echo.
echo [3/4] Mengunggah Changelog ke CloudHost S3...
call node upload-changelog.js
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Gagal mengunggah changelog ke S3.
    pause
    exit /b %ERRORLEVEL%
)

:: 6. Buat Signed P2P Release Index, Upload Sidecar ke S3, & Deploy ke VPS Seeder
echo.
echo [4/4] Menandatangani P2P Index, Upload Sidecar ke S3, ^& Deploy ke VPS Seeder...
call node scripts/publish-p2p-release.js ^
  --releases-dir Releases ^
  --version %APP_VERSION% ^
  --private-key keys\publisher-ed25519-private.pem ^
  --public-key keys\publisher-ed25519-public.pem ^
  --key-id publisher-2026 ^
  --upload-s3 ^
  --vps-host ubuntu@2406:da1c:11f2:14b:dc34:88da:9283:b479 ^
  --vps-ssh-key ..\sa-chaos.pem ^
  --non-fatal

echo.
echo ================================================================
echo  SUKSES: SA-CHAOS v%APP_VERSION% BERHASIL DIRILIS LENGKAP
echo  1. CloudHost S3 (Paket Update + Changelog + Sidecar)
echo  2. VPS Ubuntu Seeder (Dual-Stack P2P Seeder aktif)
echo ================================================================
echo.
pause
