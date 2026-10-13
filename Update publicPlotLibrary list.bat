@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File ".\js\build-publicPlotLibrary-index.ps1"
echo.
echo Done. Refresh the page to see your new plots.
pause