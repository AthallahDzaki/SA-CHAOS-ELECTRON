@echo off
echo ========================================================
echo   SA-CHAOS EMERGENCY FIX: BREAK UPDATE LOOP
echo ========================================================
echo.

echo [1/3] Menutup semua proses SA-CHAOS...
taskkill /F /IM SA-CHAOS.exe >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/3] Membersihkan cache paket delta yang rusak...
del /q "%LOCALAPPDATA%\SA-CHAOS\packages\*-delta.nupkg" >nul 2>&1

echo [3/3] Memasang langsung Full Package v1.0.71 lokal...
if exist "%LOCALAPPDATA%\SA-CHAOS\Update.exe" (
    "%LOCALAPPDATA%\SA-CHAOS\Update.exe" apply --package "%~dp0Releases\SA-CHAOS-1.0.71-full.nupkg" --restart
    echo.
    echo [SUKSES] Aplikasi berhasil diperbarui ke v1.0.71 dan dibuka kembali!
) else (
    echo [ERROR] Update.exe tidak ditemukan di %LOCALAPPDATA%\SA-CHAOS
)

echo.
pause
