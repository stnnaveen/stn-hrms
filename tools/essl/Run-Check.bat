@echo off
rem StartupTN HR - eSSL server check (read only). Right-click > Run as administrator.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stn-essl-check.ps1"
echo.
echo Done. Send Desktop\stn-essl-check.txt to Naveen.
pause
