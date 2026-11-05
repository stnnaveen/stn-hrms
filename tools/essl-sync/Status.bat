@echo off
rem StartupTN HR - eSSL sync: is it running? Right-click > Run as administrator.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r='C:\ProgramData\StartupTN\essl-sync'; Get-ScheduledTask -TaskName 'StartupTN eSSL Sync' | Select-Object TaskName,State | Format-Table -AutoSize; Get-Content \"$r\status.json\"; Write-Host ''; Write-Host 'Last log lines:'; Get-Content \"$r\sync.log\" -Tail 15"
pause
