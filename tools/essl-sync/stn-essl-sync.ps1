# StartupTN HR - eSSL sync (runs on the eTimeTrackLite PC, started by Windows at boot as SYSTEM).
# Every 30 seconds: reads NEW punch rows from the eTimeTrackLite database (read only) and sends them to
# StartupTN HR over HTTPS. Outbound only: nothing connects into this PC.
# - Never loses a punch: the last row the server confirmed is saved on disk; unconfirmed rows are re-sent.
# - Never doubles a punch: the server ignores a row it already has.
# - Reports in every cycle, so HR/Tech see if this PC goes quiet.
# Reads only: punch time, device, staff code; device list; staff code + name. No photos, Aadhaar or passwords.
# v1.1: every 15 minutes also sends eSSL's own numbers (rows per day, and eTimeTrackLite's in/out per person per day)
#       so StartupTN HR can prove its figures match eSSL exactly.

param([switch]$Once)
$ErrorActionPreference = 'Stop'
$Version = '1.1.0'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$Root = if ($env:STN_SYNC_ROOT) { $env:STN_SYNC_ROOT } else { Join-Path $env:ProgramData 'StartupTN\essl-sync' }
$cfg = Get-Content (Join-Path $Root 'config.json') -Raw | ConvertFrom-Json
$Interval = if ($cfg.interval_sec) { [int]$cfg.interval_sec } else { 30 }
$StatePath = Join-Path $Root 'state.json'
$StatusPath = Join-Path $Root 'status.json'
$LogPath = Join-Path $Root 'sync.log'
$Batch = 500

function Log([string]$m) {
  try {
    if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 2MB) { Move-Item $LogPath "$LogPath.1" -Force }
    Add-Content -Path $LogPath -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
  } catch {}
  if ($Once) { Write-Host $m }
}
function Save-Json($obj, [string]$path) {
  $tmp = "$path.tmp"
  ($obj | ConvertTo-Json -Depth 6) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Path $tmp -Destination $path -Force
}
function Iso($d) {
  if ($null -eq $d -or $d -is [DBNull]) { return $null }
  $dt = [datetime]$d
  $o = [TimeZoneInfo]::Local.GetUtcOffset($dt)
  $sign = if ($o.Ticks -lt 0) { '-' } else { '+' }
  return $dt.ToString("yyyy-MM-dd'T'HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture) + $sign + ('{0:00}:{1:00}' -f [math]::Abs($o.Hours), [math]::Abs($o.Minutes))
}
function Str($v) { if ($null -eq $v -or $v -is [DBNull]) { return '' } else { return ([string]$v).Trim() } }

# ---- database (read only). A fake source can be plugged in for testing (config.fake_dir).
function Get-Rows([string]$sql, [hashtable]$p = @{}) {
  if ($cfg.fake_dir) { return & (Join-Path $cfg.fake_dir 'fake-sql.ps1') -Sql $sql -Params $p -Dir $cfg.fake_dir }
  $c = New-Object System.Data.SqlClient.SqlConnection
  $c.ConnectionString = "Server=$($cfg.sql_server);Database=$($cfg.database);Integrated Security=True;Connect Timeout=15;Application Name=StartupTN eSSL sync"
  $c.Open()
  try {
    $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 60
    foreach ($k in $p.Keys) { [void]$cmd.Parameters.AddWithValue($k, $p[$k]) }
    $da = New-Object System.Data.SqlClient.SqlDataAdapter; $da.SelectCommand = $cmd
    $dt = New-Object System.Data.DataTable; [void]$da.Fill($dt)
    return ,$dt
  } finally { $c.Close() }
}

# punch tables: eTimeTrackLite keeps one per month, e.g. essl.DeviceLogs_11_2026
function Get-LogTables {
  $names = @()
  foreach ($k in 0, 1) { $d = (Get-Date).AddMonths(-$k); $names += "DeviceLogs_$($d.Month)_$($d.Year)" }
  $rows = Get-Rows "select s.name as sch, t.name as tbl from sys.tables t join sys.schemas s on s.schema_id = t.schema_id where t.name in (@a, @b)" @{ '@a' = $names[0]; '@b' = $names[1] }
  $out = @()
  foreach ($n in $names) { foreach ($r in $rows.Rows) { if ($r.tbl -eq $n) { $out += [pscustomobject]@{ Schema = [string]$r.sch; Name = $n } } } }
  return ,$out
}

function Get-Devices {
  $rows = Get-Rows "select DeviceId, DeviceFName, SerialNumber, IpAddress, LastPing, LastLogDownloadDate from dbo.Devices"
  $list = @()
  foreach ($r in $rows.Rows) {
    $name = Str $r.DeviceFName; $serial = Str $r.SerialNumber
    $kind = if ($name -match '(?i)manual') { 'manual' } elseif ($name -match '(?i)mobile') { 'mobile' } else { 'biometric' }
    $list += [ordered]@{ id = [int]$r.DeviceId; name = $name; serial = $serial; kind = $kind; ip = (Str $r.IpAddress); last_ping = (Iso $r.LastPing); last_download = (Iso $r.LastLogDownloadDate) }
  }
  return ,$list
}

function Get-People {
  $rows = Get-Rows "select EmployeeCodeInDevice, EmployeeCode, EmployeeName from dbo.Employees"
  $list = @()
  foreach ($r in $rows.Rows) {
    $code = Str $r.EmployeeCodeInDevice
    if ($code) { $list += [ordered]@{ code = $code; essl_code = (Str $r.EmployeeCode); name = (Str $r.EmployeeName) } }
  }
  return ,$list
}

# 'HH:mm' (24 h) from whatever eSSL stores: '09:41', '2026-11-05 09:41:00', '1:05 PM'. Null when no time.
function Hm($v) {
  $t = Str $v
  if ($t -notmatch '(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?') { return $null }
  $h = [int]$Matches[1]; $m = [int]$Matches[2]; $ap = $Matches[3]
  if ($ap) { if ($ap -match '^[Pp]' -and $h -lt 12) { $h += 12 } elseif ($ap -match '^[Aa]' -and $h -eq 12) { $h = 0 } }
  if ($h -gt 23 -or $m -gt 59) { return $null }
  return ('{0:00}:{1:00}' -f $h, $m)
}

# eSSL's own numbers: rows per log table and per day, and eTimeTrackLite's in/out per person per day
function Get-Audit($tables) {
  $tb = @()
  foreach ($t in $tables) {
    $c = Get-Rows "select count(*) as n, max(DeviceLogId) as mx from [$($t.Schema)].[$($t.Name)]"
    $days = [ordered]@{}
    foreach ($r in (Get-Rows "select convert(varchar(10), LogDate, 120) as d, count(*) as n from [$($t.Schema)].[$($t.Name)] group by convert(varchar(10), LogDate, 120)").Rows) { $days[[string]$r.d] = [int]$r.n }
    $tb += [ordered]@{ t = $t.Name; count = [int]$c.Rows[0].n; max_id = $(if ($c.Rows[0].mx -is [DBNull]) { 0 } else { [int]$c.Rows[0].mx }); days = $days }
  }
  $from = (Get-Date).Date.AddDays(1 - (Get-Date).Day); if ((Get-Date).Day -le 7) { $from = $from.AddMonths(-1) }
  $att = @()
  $rows = Get-Rows "select e.EmployeeCodeInDevice as code, convert(varchar(10), a.AttendanceDate, 120) as d, a.InTime, a.OutTime, a.Status, cast(a.PunchRecords as nvarchar(600)) as rec from dbo.AttendanceLogs a join dbo.Employees e on e.EmployeeId = a.EmployeeId where a.AttendanceDate >= @from" @{ '@from' = $from }
  foreach ($r in $rows.Rows) {
    $in = Hm $r.InTime
    if (-not $in -and -not (Str $r.rec)) { continue }        # no punch that day: nothing to compare
    $att += [ordered]@{ code = (Str $r.code); day = [string]$r.d; in = $in; out = (Hm $r.OutTime); status = (Str $r.Status); records = (Str $r.rec) }
  }
  return @{ tables = $tb; attendance = $att }
}

function Send([hashtable]$body) {
  $json = $body | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Method Post -Uri $cfg.url -Headers @{ 'x-bio-key' = $cfg.key } -ContentType 'application/json; charset=utf-8' -Body $bytes -TimeoutSec 25 -UseBasicParsing
}

# ---- state
$state = @{ cursors = @{}; devices_at = $null; people_at = $null; audit_at = $null }
if (Test-Path $StatePath) {
  try {
    $s = Get-Content $StatePath -Raw | ConvertFrom-Json
    foreach ($p in $s.cursors.PSObject.Properties) { $state.cursors[$p.Name] = [int]$p.Value }
    $state.devices_at = $s.devices_at; $state.people_at = $s.people_at; $state.audit_at = $s.audit_at
  } catch { Log "state file unreadable, starting from this month: $($_.Exception.Message)" }
}
$started = Iso (Get-Date)
$stats = @{ sent = 0; saved = 0; last_ok = $null; last_error = $null; last_punch = $null; errors_in_row = 0 }

function Sync-Cycle {
  $more = $false
  $tables = Get-LogTables
  $punches = New-Object System.Collections.Generic.List[object]
  $maxIds = @{}
  foreach ($t in $tables) {
    $cur = if ($state.cursors.ContainsKey($t.Name)) { $state.cursors[$t.Name] } else { 0 }   # new table: send it from the start
    $sql = "select top $Batch DeviceLogId, DeviceId, UserId, LogDate, Direction, AttDirection, DownloadDate from [$($t.Schema)].[$($t.Name)] where DeviceLogId > @cur order by DeviceLogId"
    $rows = Get-Rows $sql @{ '@cur' = $cur }
    if ($rows.Rows.Count -ge $Batch) { $more = $true }
    foreach ($r in $rows.Rows) {
      $dir = Str $r.Direction; if (-not $dir) { $dir = Str $r.AttDirection }
      $punches.Add([ordered]@{ t = $t.Name; id = [int]$r.DeviceLogId; dev = (Str $r.DeviceId); code = (Str $r.UserId); at = (Iso $r.LogDate); dir = $dir; dl = (Iso $r.DownloadDate) })
      $maxIds[$t.Name] = [int]$r.DeviceLogId
      $stats.last_punch = Iso $r.LogDate
    }
  }
  $now = Get-Date
  $body = @{ punches = $punches.ToArray() }
  $sendDevices = (-not $state.devices_at) -or (($now - [datetime]$state.devices_at).TotalMinutes -ge 5)
  $sendPeople = (-not $state.people_at) -or (($now - [datetime]$state.people_at).TotalMinutes -ge 30)
  if ($sendDevices) { $body.devices = Get-Devices }
  if ($sendPeople) { $body.people = Get-People }
  # audit only once the backlog is sent, so eSSL's counts and ours describe the same rows
  $sendAudit = (-not $more) -and ((-not $state.audit_at) -or (($now - [datetime]$state.audit_at).TotalMinutes -ge 15))
  if ($sendAudit) { try { $body.audit = Get-Audit $tables } catch { $sendAudit = $false; Log "audit skipped: $($_.Exception.Message)" } }
  $body.agent = [ordered]@{ pc = $env:COMPUTERNAME; version = $Version; started = $started; interval_sec = $Interval; last_ok = $stats.last_ok;
    last_error = $stats.last_error; last_punch = $stats.last_punch; sent_total = $stats.sent; cursors = $state.cursors; tables = @($tables | ForEach-Object { "$($_.Schema).$($_.Name)" }) }

  $r = Send $body
  if (-not $r.ok) { throw "server did not confirm: $($r | ConvertTo-Json -Compress)" }
  foreach ($k in $maxIds.Keys) { $state.cursors[$k] = $maxIds[$k] }
  if ($sendDevices) { $state.devices_at = $now.ToString('o') }
  if ($sendPeople) { $state.people_at = $now.ToString('o') }
  if ($sendAudit) { $state.audit_at = $now.ToString('o') }
  # keep only cursors for this month and last month
  foreach ($k in @($state.cursors.Keys)) { if (-not ($tables | Where-Object { $_.Name -eq $k })) { $state.cursors.Remove($k) } }
  Save-Json $state $StatePath
  $stats.sent += $punches.Count; $stats.saved += [int]$r.saved
  $stats.last_ok = Iso (Get-Date); $stats.last_error = $null; $stats.errors_in_row = 0
  if ($punches.Count) { Log "sent $($punches.Count), new $($r.saved)" }
  return $more
}

Log "start v$Version, every $Interval s, server $($cfg.url)"
while ($true) {
  $t0 = Get-Date
  $more = $false
  try { $more = Sync-Cycle }
  catch {
    $stats.errors_in_row++
    $stats.last_error = "$(Iso (Get-Date)) $($_.Exception.Message)"
    if ($stats.errors_in_row -le 3 -or $stats.errors_in_row % 20 -eq 0) { Log "error ($($stats.errors_in_row) in a row): $($_.Exception.Message)" }
  }
  try { Save-Json ([ordered]@{ version = $Version; pc = $env:COMPUTERNAME; started = $started; checked = (Iso (Get-Date)); last_ok = $stats.last_ok; last_error = $stats.last_error; last_punch = $stats.last_punch; sent_total = $stats.sent; new_total = $stats.saved; cursors = $state.cursors }) $StatusPath } catch {}
  if ($Once) { break }
  if ($more) { continue }                                     # backlog: keep sending without waiting
  $wait = $Interval - ((Get-Date) - $t0).TotalSeconds
  if ($stats.errors_in_row -gt 0) { $wait = [math]::Min(120, $Interval * [math]::Min($stats.errors_in_row, 4)) }   # gentle back-off while offline
  if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]($wait * 1000)) }
}
