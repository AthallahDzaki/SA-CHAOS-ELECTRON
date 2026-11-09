@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ====================================================
echo   SA-CHAOS AUTO BUILDER ^& VERSION MANAGER
echo ====================================================
echo.

:: 1. Deteksi Versi Saat Ini dari version.txt atau package.json
set "CURRENT_VERSION="
if exist "version.txt" (
    for /f "delims=" %%a in ('node -e "const fs=require('fs'); console.log(fs.readFileSync('version.txt','utf8').trim());"') do set "CURRENT_VERSION=%%a"
)
if "%CURRENT_VERSION%"=="" (
    for /f "delims=" %%a in ('node -p "require('./package.json').version"') do set "CURRENT_VERSION=%%a"
)
if "%CURRENT_VERSION%"=="" set "CURRENT_VERSION=1.0.0"

:: 2. Hitung Versi Patch Berikutnya Otomatis (contoh: 1.0.49 -> 1.0.50)
for /f "delims=" %%a in ('node -e "const cur = process.argv[1]; const p = cur.split('.').map(Number); p[2] = (isNaN(p[2]) ? 0 : p[2]) + 1; console.log(p.join('.'));" "%CURRENT_VERSION%"') do (
    set "SUGGESTED_VERSION=%%a"
)

:: 3. Tentukan Versi Target (dari argumen CLI atau input interaktif)
set "TARGET_VERSION=%~1"
if "%TARGET_VERSION%"=="" (
    echo Versi saat ini   : %CURRENT_VERSION%
    echo Versi disarankan : %SUGGESTED_VERSION%
    echo.
    set /p "USER_INPUT=Masukkan versi baru [tekan ENTER untuk %SUGGESTED_VERSION%]: "
    if "!USER_INPUT!"=="" (
        set "TARGET_VERSION=%SUGGESTED_VERSION%"
    ) else (
        set "TARGET_VERSION=!USER_INPUT!"
    )
)

echo.
echo [i] Target Versi Build: %TARGET_VERSION%
echo.

:: 4. Simpan Versi ke version.txt (lokal & root c:\SA-Chaos)
echo [i] Menyimpan versi ke version.txt...
node -e "const fs=require('fs'); fs.writeFileSync('version.txt', process.argv[1].trim() + '\n');" "%TARGET_VERSION%"
if exist "..\SA-CHAOS-ELECTRON" (
    node -e "const fs=require('fs'); fs.writeFileSync('../version.txt', process.argv[1].trim() + '\n');" "%TARGET_VERSION%"
)

:: 5. Sinkronisasi Versi ke package.json
echo [i] Memperbarui versi di package.json...
node -e "const fs=require('fs'); const p='./package.json'; const pkg=JSON.parse(fs.readFileSync(p,'utf8')); pkg.version=process.argv[1].trim(); fs.writeFileSync(p, JSON.stringify(pkg,null,2)+'\n');" "%TARGET_VERSION%"

:: 6. Sinkronisasi latestVersion di Releases/changelog.json
if exist "Releases\changelog.json" (
    echo [i] Memperbarui latestVersion di Releases\changelog.json...
    node -e "const fs=require('fs'); const p='./Releases/changelog.json'; const cl=JSON.parse(fs.readFileSync(p,'utf8')); cl.latestVersion=process.argv[1].trim(); cl.updatedAt=new Date().toISOString(); fs.writeFileSync(p, JSON.stringify(cl,null,2)+'\n');" "%TARGET_VERSION%"
)

:: 7. Build Frontend Next.js (SA-CHAOS-CONFIG)
echo.
echo [1/3] Membangun Frontend Next.js (SA-CHAOS-CONFIG)...
if exist "..\SA-CHAOS-CONFIG" (
    pushd "..\SA-CHAOS-CONFIG"
    call npm run build
    if !ERRORLEVEL! NEQ 0 (
        echo.
        echo [ERROR] Kompilasi frontend Next.js gagal!
        popd
        pause
        exit /b !ERRORLEVEL!
    )
    popd
) else (
    echo [WARN] Folder ..\SA-CHAOS-CONFIG tidak ditemukan, melewati tahap ini.
)

:: 8. Obfuscate & Prebuild Electron Main Process
echo.
echo [2/3] Mengaburkan (Obfuscate) ^& Menyiapkan Main Process...
call npm run prebuild:win
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Gagal menjalankan prebuild / obfuscate Electron!
    pause
    exit /b %ERRORLEVEL%
)

:: 9. Package Unpacked Directory (dist\win-unpacked)
echo.
echo [3/3] Mengompilasi Binary Unpacked (dist\win-unpacked)...
call npm run pack
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Gagal melakukan packaging win-unpacked!
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ================================================================
echo  BUILD BERHASIL SELESAI!
echo  - Versi Build : %TARGET_VERSION%
echo  - Disimpan di : version.txt
echo.
echo  Langkah Rilis Selanjutnya:
echo  Jalankan 'deploy.bat' untuk mem-package Velopack ^& upload ke S3!
echo ================================================================
echo.
pause
