@echo off
cd /d "%~dp0"
echo Mengunggah SA-CHAOS-win-Setup.exe ke S3...
node upload-setup-exe.js
pause
