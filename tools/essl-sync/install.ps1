# StartupTN HR - install the eSSL sync on this PC (run Install.bat as administrator).
# 1. asks for the link key (from StartupTN HR > Tech admin > Biometric)
# 2. lets Windows' own SYSTEM account READ the eTimeTrackLite database (read-only role, nothing else)
# 3. copies the sync program to C:\ProgramData\StartupTN\essl-sync (only Administrators and SYSTEM can open it)
# 4. sends the first punches, then registers a Windows task that starts it at boot and restarts it if it stops
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Join-Path $env:ProgramData 'StartupTN\essl-sync'
$Task = 'StartupTN eSSL Sync'
$Url = 'https://johnyztppvetjdcjuqan.supabase.co/functions/v1/bio-sync'

function Say([string]$m, [string]$c = 'Gray') { Write-Host "  $m" -ForegroundColor $c }
function Fail([string]$m) { Write-Host ''; Write-Host "  STOPPED: $m" -ForegroundColor Red; Write-Host '  Nothing else was changed. Take a photo of this window and send it to Naveen.'; exit 1 }
function Sql([string]$srv, [string]$db, [string]$q) {
  $c = New-Object System.Data.SqlClient.SqlConnection
  $c.ConnectionString = "Server=$srv;Database=$db;Integrated Security=True;Connect Timeout=15"
  $c.Open()
  try { $cmd = $c.CreateCommand(); $cmd.CommandText = $q; $cmd.CommandTimeout = 60
        $da = New-Object System.Data.SqlClient.SqlDataAdapter; $da.SelectCommand = $cmd; $dt = New-Object System.Data.DataTable; [void]$da.Fill($dt); return ,$dt }
  finally { $c.Close() }
}

Write-Host ''
Write-Host '  StartupTN HR - eSSL sync setup' -ForegroundColor Cyan
Write-Host ''
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Please right-click Install.bat and choose "Run as administrator".' }

# 1. link key
$key = ''
$oldCfg = Join-Path $Root 'config.json'
if (Test-Path $oldCfg) { try { $k = (Get-Content $oldCfg -Raw | ConvertFrom-Json).key; if ($k -match '^stnbio_[0-9a-f]{64}$') { $key = $k; Say 'Updating: keeping the current link key.' 'Green' } } catch {} }
for ($i = 0; $i -lt 3 -and $key -notmatch '^stnbio_[0-9a-f]{64}$'; $i++) {
  $key = (Read-Host '  Paste the link key (starts with stnbio_) and press Enter').Trim()
  if ($key -notmatch '^stnbio_[0-9a-f]{64}$') { Say 'That is not a full link key. Copy it again from the Tech admin screen.' 'Yellow' }
}
if ($key -notmatch '^stnbio_[0-9a-f]{64}$') { Fail 'No valid link key.' }

# 2. find the eTimeTrackLite database
Say 'Finding the eTimeTrackLite database...'
$srv = $null; $db = $null
foreach ($s in (Get-Service -Name 'MSSQL*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' })) {
  $cand = if ($s.Name -eq 'MSSQLSERVER') { 'localhost' } else { 'localhost\' + ($s.Name -replace '^MSSQL\$', '') }
  try {
    foreach ($r in (Sql $cand 'master' "select name from sys.databases where database_id > 4").Rows) {
      $t = Sql $cand $r.name "select count(*) as n from sys.tables where name like 'DeviceLogs[_]%'"
      if ($t.Rows[0].n -gt 0) { $srv = $cand; $db = [string]$r.name; break }
    }
  } catch { Say "  $cand : $($_.Exception.Message)" 'Yellow' }
  if ($db) { break }
}
if (-not $db) { Fail 'Could not find the eTimeTrackLite database on this PC.' }
Say "Found: $srv, database $db" 'Green'

# 3. read-only access for Windows' SYSTEM account (the sync runs as SYSTEM so nobody needs to stay logged in)
Say 'Giving the sync read-only access...'
try {
  Sql $srv $db @"
if suser_id('NT AUTHORITY\SYSTEM') is null create login [NT AUTHORITY\SYSTEM] from windows;
if user_id('NT AUTHORITY\SYSTEM') is null create user [NT AUTHORITY\SYSTEM] for login [NT AUTHORITY\SYSTEM];
if is_rolemember('db_datareader', 'NT AUTHORITY\SYSTEM') = 0 alter role db_datareader add member [NT AUTHORITY\SYSTEM];
"@ | Out-Null
  Say 'Read-only access set' 'Green'
} catch { Fail "Could not set read-only access: $($_.Exception.Message)" }

# 4. files, locked to Administrators + SYSTEM (the key is inside)
Say 'Copying the sync program...'
$old = Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
if ($old) { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }
New-Item -ItemType Directory -Path $Root -Force | Out-Null
Copy-Item (Join-Path $Here 'stn-essl-sync.ps1') (Join-Path $Root 'stn-essl-sync.ps1') -Force
foreach ($f in 'Status.bat', 'Uninstall.bat', 'uninstall.ps1') { if (Test-Path (Join-Path $Here $f)) { Copy-Item (Join-Path $Here $f) (Join-Path $Root $f) -Force } }
[ordered]@{ url = $Url; key = $key; sql_server = $srv; database = $db; interval_sec = 30 } | ConvertTo-Json | Set-Content (Join-Path $Root 'config.json') -Encoding UTF8
& icacls.exe $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
Say "Saved in $Root" 'Green'

# 5. first send, right now (shows any problem on screen)
Say 'Sending to StartupTN HR (first time can take a minute)...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'stn-essl-sync.ps1') -Once
$st = Get-Content (Join-Path $Root 'status.json') -Raw | ConvertFrom-Json
if ($st.last_error) { Fail "First send failed: $($st.last_error)" }
Say "Connected. Last punch read: $($st.last_punch)" 'Green'

# 6. Windows task: at boot, plus every 5 minutes as a watchdog (never two copies at once)
Say 'Starting it with Windows...'
$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Root\stn-essl-sync.ps1`""
$t1 = New-ScheduledTaskTrigger -AtStartup
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $Task -Action $a -Trigger @($t1, $t2) -Settings $s -Principal $p -Description 'Sends new eSSL fingerprint punches to StartupTN HR every 30 seconds.' -Force | Out-Null
Start-ScheduledTask -TaskName $Task

# 7. prove the Windows task itself works (it runs as SYSTEM, not as you)
$since = Get-Date
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 3
  try { $st = Get-Content (Join-Path $Root 'status.json') -Raw | ConvertFrom-Json } catch { continue }
  if ($st.checked -and ([datetime]$st.checked) -gt $since.AddSeconds(-1)) {
    if ($st.last_error) { Fail "The Windows task started but could not send: $($st.last_error)" }
    $ok = $true; break
  }
}
if (-not $ok) { Fail 'The Windows task did not report in 90 seconds.' }
Write-Host ''
Write-Host '  DONE. The sync runs by itself now, every 30 seconds, also after a restart.' -ForegroundColor Green
Write-Host '  To check it later: open C:\ProgramData\StartupTN\essl-sync and run Status.bat as administrator.'
Write-Host ''
