# Removes ONLY the dev team copy of the eSSL sync. The StartupTN copy and eTimeTrackLite are not touched.
# Run in an administrator PowerShell:  powershell -NoProfile -ExecutionPolicy Bypass -File .\Remove-DevTeamSync.ps1
param([string]$Root = (Join-Path $env:ProgramData 'DevTeam\essl-sync'), [string]$Task = 'DevTeam eSSL Sync')
$ErrorActionPreference = 'Continue'
if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $Task; Unregister-ScheduledTask -TaskName $Task -Confirm:$false; Write-Host "  Task '$Task' removed." }
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like "*$Root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if (Test-Path $Root) { Remove-Item $Root -Recurse -Force; Write-Host "  Removed $Root" }
Write-Host '  Done.'
