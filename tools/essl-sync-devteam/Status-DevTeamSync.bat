@echo off
rem Dev team eSSL sync: is it running? Right-click > Run as administrator.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r='C:\ProgramData\DevTeam\essl-sync'; Get-ScheduledTask -TaskName 'DevTeam eSSL Sync' | Select-Object TaskName,State | Format-Table -AutoSize; Get-Content \"$r\status.json\"; Write-Host ''; Write-Host 'Last log lines:'; Get-Content \"$r\sync.log\" -Tail 15"
pause
