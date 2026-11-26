# Adds a SECOND copy of the StartupTN eSSL sync on the Chennai eTimeTrackLite PC that posts to YOUR server.
# The StartupTN copy keeps running. eTimeTrackLite is only read. Nothing connects into this PC.
# Run in an administrator PowerShell, from this folder:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\Setup-DevTeamSync.ps1 -Url https://your-server/your-endpoint
# It asks for your key (sent as header x-bio-key). Re-running it updates the URL/key and keeps the cursor.
param(
  [string]$Url,
  [string]$Key,
  [string]$Root = $(if ($env:ProgramData) { Join-Path $env:ProgramData 'DevTeam\essl-sync' } else { '' }),
  [string]$Task = 'DevTeam eSSL Sync',
  [string]$OursConfig = $(if ($env:ProgramData) { Join-Path $env:ProgramData 'StartupTN\essl-sync\config.json' } else { '' }),
  [switch]$NoTask          # set up and test only; do not create the Windows task
)
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
function Say([string]$m, [string]$c = 'Gray') { Write-Host "  $m" -ForegroundColor $c }
function Fail([string]$m) { Write-Host ''; Write-Host "  STOPPED: $m" -ForegroundColor Red; exit 1 }

Write-Host ''; Write-Host '  eSSL sync to your server - setup' -ForegroundColor Cyan; Write-Host ''
if ($IsWindows -ne $false) {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Open PowerShell with "Run as administrator" and run this again.' }
}
# never touch the StartupTN copy: its task name and folder are off limits
$OursRoot = Split-Path -Parent $OursConfig
if ($Task -eq 'StartupTN eSSL Sync') { Fail 'That task name belongs to the StartupTN sync. Use another name.' }
if ($OursRoot -and ([IO.Path]::GetFullPath($Root).TrimEnd('\','/') -eq [IO.Path]::GetFullPath($OursRoot).TrimEnd('\','/'))) { Fail 'That folder belongs to the StartupTN sync. Use another folder.' }
$Program = Join-Path (Join-Path (Split-Path -Parent $Here) 'essl-sync') 'stn-essl-sync.ps1'
if (-not (Test-Path $Program)) { Fail "Sync program not found at $Program. Keep the bundle folders together." }

# 1. your URL and key
$cfgPath = Join-Path $Root 'config.json'
$prev = $null; if (Test-Path $cfgPath) { try { $prev = Get-Content $cfgPath -Raw | ConvertFrom-Json } catch {} }
if (-not $Url -and $prev) { $Url = $prev.url }
if (-not $Url) { $Url = (Read-Host '  Your endpoint URL (https://...)').Trim() }
if ($Url -notmatch '^https://' -and $Url -notmatch '^http://(localhost|127\.0\.0\.1)[:/]') { Fail 'The URL must start with https://' }
if (-not $Key -and $prev -and $prev.key) { $Key = $prev.key; Say 'Keeping the current key.' 'Green' }
if (-not $Key) { $Key = (Read-Host '  Your key (sent as header x-bio-key)').Trim() }
if ($Key.Length -lt 16) { Fail 'Use a key of at least 16 characters.' }

# 2. database: the same one the StartupTN copy reads (only these two values are copied; its key is not)
if (-not (Test-Path $OursConfig)) { Fail "StartupTN sync config not found at $OursConfig." }
$o = Get-Content $OursConfig -Raw | ConvertFrom-Json
if (-not $o.sql_server -or -not $o.database) { Fail 'StartupTN sync config has no sql_server/database.' }
Say "Database: $($o.sql_server), $($o.database) (read only)" 'Green'

# 3. files: a renamed copy of the program, a launcher, your config. Locked to Administrators + SYSTEM.
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Copy-Item $Program (Join-Path $Root 'dev-essl-sync.ps1') -Force
@'
param([switch]$Once)
$env:STN_SYNC_ROOT = $PSScriptRoot
& (Join-Path $PSScriptRoot 'dev-essl-sync.ps1') -Once:$Once
'@ | Set-Content (Join-Path $Root 'run-sync.ps1') -Encoding UTF8
$cfg = [ordered]@{ url = $Url; key = $Key; sql_server = $o.sql_server; database = $o.database; interval_sec = 30 }
if ($prev -and $prev.fake_dir) { $cfg.fake_dir = $prev.fake_dir }   # test harness only
$cfg | ConvertTo-Json | Set-Content $cfgPath -Encoding UTF8
if (Get-Command icacls.exe -ErrorAction SilentlyContinue) { & icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null }
Say "Saved in $Root" 'Green'

# 4. one send now, on screen
Say 'Sending to your server...'
$ps = if ($IsWindows -eq $false) { 'pwsh' } else { 'powershell.exe' }
if ($IsWindows -ne $false -and (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue)) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
& $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'run-sync.ps1') -Once
$st = Get-Content (Join-Path $Root 'status.json') -Raw | ConvertFrom-Json
if ($st.last_error) { Fail "First send failed: $($st.last_error)" }
Say "Connected. Last punch read: $($st.last_punch)" 'Green'

# 5. Windows task: at boot, plus every 5 minutes as a watchdog (never two copies at once)
if ($NoTask) { Say 'No Windows task created (-NoTask).' 'Yellow'; Write-Host ''; Write-Host '  DONE' -ForegroundColor Green; exit 0 }
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\run-sync.ps1`""
$t1 = New-ScheduledTaskTrigger -AtStartup
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $Task -Action $a -Trigger @($t1, $t2) -Settings $s -Principal $p -Description 'Sends new eSSL fingerprint punches to the dev team server every 30 seconds.' -Force | Out-Null
Start-ScheduledTask -TaskName $Task
Say "Windows task '$Task' started." 'Green'
Write-Host ''; Write-Host '  DONE' -ForegroundColor Green
