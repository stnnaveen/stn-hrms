# StartupTN HR - remove the eSSL sync from this PC. eTimeTrackLite itself is not touched.
$ErrorActionPreference = 'Continue'
$Root = Join-Path $env:ProgramData 'StartupTN\essl-sync'
$Task = 'StartupTN eSSL Sync'
if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $Task; Unregister-ScheduledTask -TaskName $Task -Confirm:$false
  Write-Host '  Windows task removed.'
}
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -like '*stn-essl-sync.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
if (Test-Path $Root) { Remove-Item $Root -Recurse -Force; Write-Host "  Removed $Root" }
Write-Host '  Done. The read-only database access for SYSTEM is left in place (harmless).'
