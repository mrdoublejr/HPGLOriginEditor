@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\js\build-samples-index.ps1"
echo.
echo Done. Refresh the page to see your new plots.
pause