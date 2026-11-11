@echo off
setlocal
cd /d "%~dp0"
title "SA-CHAOS Smart Patch & Emergency Repair Tool"

echo Memulai SA-CHAOS Smart Patch ^& Repair Tool...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0patch-updater.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Script patch mengembalikan kode error %ERRORLEVEL%.
    pause
)
