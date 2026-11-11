@echo off
cd /d "%~dp0"
echo Mengunggah SA-CHAOS-beta-Setup.exe ke S3...
node upload-setup-exe.js beta
pause
