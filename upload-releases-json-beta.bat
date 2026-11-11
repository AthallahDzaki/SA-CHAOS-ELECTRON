@echo off
cd /d "%~dp0"
echo ========================================================
echo  UPLOAD RELEASES.BETA.JSON KE CLOUDHOST S3
echo ========================================================
echo.
node upload-releases-json.js beta
pause
