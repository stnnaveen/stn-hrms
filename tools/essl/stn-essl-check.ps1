# StartupTN HR - eSSL eTimeTrackLite server check (v2).
# READ ONLY: reads settings and database structure, changes nothing, sends nothing.
# Writes the result to Desktop\stn-essl-check.txt. No passwords are read or written.
# Run: right-click Run-Check.bat > Run as administrator.

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$desk = [Environment]::GetFolderPath('Desktop'); if (-not $desk) { $desk = (Get-Location).Path }
$out = Join-Path $desk 'stn-essl-check.txt'
$log = New-Object System.Collections.Generic.List[string]
function W($s) { $t = [string]$s; $log.Add($t); Write-Host $t }
trap { W "  error: $($_.Exception.Message)"; continue }
function Tbl($dt) { if ($dt -and $dt.Rows.Count) { W (($dt | Format-Table -AutoSize | Out-String -Width 500).TrimEnd()) } else { W '  (no rows)' } }
function Q([string]$srv, [string]$db, [string]$sql) {
  $cs = "Server=$srv;Database=$db;Integrated Security=True;Connect Timeout=15"
  $c = New-Object System.Data.SqlClient.SqlConnection
  $c.ConnectionString = $cs
  $c.Open()
  try {
    $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 60
    $da = New-Object System.Data.SqlClient.SqlDataAdapter
    $da.SelectCommand = $cmd
    $dt = New-Object System.Data.DataTable; [void]$da.Fill($dt); return ,$dt
  } finally { $c.Close() }
}
function TryTbl([string]$srv, [string]$db, [string]$sql) { try { Tbl (Q $srv $db $sql) } catch { W "  error: $($_.Exception.Message)" } }

W "== StartupTN eSSL check v2  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$os = Get-CimInstance Win32_OperatingSystem
W "PC: $env:COMPUTERNAME | $($os.Caption) $($os.Version) | Up since: $($os.LastBootUpTime) | user: $env:USERNAME"

W ''; W '== Power (0 = never sleeps)'
foreach ($k in 'STANDBYIDLE', 'HIBERNATEIDLE') {
  $l = powercfg /q SCHEME_CURRENT SUB_SLEEP $k 2>$null | Select-String 'Current AC Power Setting Index'
  if ($l) { W "  $k on power: $([Convert]::ToInt32(($l.Line -split ':')[1].Trim(), 16)) sec" }
}

W ''; W '== eTimeTrackLite web service'
foreach ($u in 'http://localhost:8081/iclock/WebAPIService.asmx?WSDL', 'http://localhost/iclock/WebAPIService.asmx?WSDL', 'http://localhost:8081/ESSL/iclock/WebAPIService.asmx?WSDL') {
  try {
    $p = Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 15
    $ops = [regex]::Matches($p.Content, 'operation name="(\w+)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
    W "  $u -> OK: $($ops -join ', ')"
  } catch { W "  $u -> $($_.Exception.Message)" }
}

W ''; W '== SQL Server'
$servers = @()
Get-Service -Name 'MSSQL*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | ForEach-Object {
  if ($_.Name -eq 'MSSQLSERVER') { $servers += 'localhost' } else { $servers += ('localhost\' + ($_.Name -replace '^MSSQL\$', '')) }
}
foreach ($srv in $servers) {
  try { $dbs = Q $srv 'master' "select name from sys.databases where database_id > 4 order by name" }
  catch { W "  $srv : cannot open - $($_.Exception.Message)"; continue }
  W "  $srv : databases: $(($dbs.Rows | ForEach-Object { $_.name }) -join ', ')"
  TryTbl $srv 'master' "select @@VERSION as version"
  foreach ($db in @($dbs.Rows | ForEach-Object { $_.name })) {
    W ''; W "  ======== database [$db]: tables and row counts"
    try {
      $t = Q $srv $db "select s.name + '.' + t.name as tbl, sum(p.rows) as rows_ from sys.tables t join sys.schemas s on s.schema_id = t.schema_id join sys.partitions p on p.object_id = t.object_id and p.index_id in (0,1) group by s.name, t.name order by t.name"
    } catch { W "  error: $($_.Exception.Message)"; continue }
    Tbl $t
    $all = @($t.Rows | ForEach-Object { ($_.tbl -split '\.', 2)[1] })
    $logs = @($all | Where-Object { $_ -match '^DeviceLogs' } | Sort-Object { if ($_ -match '_(\d+)_(\d{4})$') { [int]$Matches[2] * 100 + [int]$Matches[1] } else { 0 } } -Descending)
    W "  punch log tables (newest first): $($logs -join ', ')"
    $want = @($all | Where-Object { $_ -match '^(Devices?|Employees?|Locations?|Branch\w*|Departments?|Companies|Company|DeviceCommands|AttendanceLogs|Users|DeviceTypes)$' }) + @($logs | Select-Object -First 1)
    foreach ($tn in ($want | Select-Object -Unique)) {
      W ''; W "  ---- columns of [$tn]"
      TryTbl $srv $db "select COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH as len, IS_NULLABLE from INFORMATION_SCHEMA.COLUMNS where TABLE_NAME = '$tn' order by ORDINAL_POSITION"
    }
    foreach ($tn in @($all | Where-Object { $_ -match '^(Devices?|Locations?|Branch\w*|DeviceTypes)$' })) {
      W ''; W "  ---- rows of [$tn]"; TryTbl $srv $db "select top 50 * from [$tn]"
    }
    if ($logs.Count) {
      $lt = $logs[0]
      W ''; W "  ---- latest 10 rows of [$lt]"
      TryTbl $srv $db "select top 10 * from [$lt] order by 1 desc"
      W ''; W "  ---- [$lt] summary"
      TryTbl $srv $db "select min(DeviceLogId) as min_id, max(DeviceLogId) as max_id, max(LogDate) as last_punch, max(DownloadDate) as last_download, count(*) as n, count(distinct DeviceId) as devices, count(distinct UserId) as people from [$lt]"
      W ''; W "  ---- [$lt] punches per day, last 7 days"
      TryTbl $srv $db "select cast(LogDate as date) as day, count(*) as punches, count(distinct UserId) as people from [$lt] where LogDate >= dateadd(day, -7, getdate()) group by cast(LogDate as date) order by day desc"
      W ''; W "  ---- [$lt] gap between punch time and arrival in the database, last 50 punches (seconds)"
      TryTbl $srv $db "select min(datediff(second, LogDate, DownloadDate)) as min_s, avg(datediff(second, LogDate, DownloadDate)) as avg_s, max(datediff(second, LogDate, DownloadDate)) as max_s from (select top 50 LogDate, DownloadDate from [$lt] order by DeviceLogId desc) x"
      foreach ($old in ($logs | Select-Object -Skip 1 -First 3)) { TryTbl $srv $db "select '$old' as tbl, count(*) as n, min(LogDate) as first_punch, max(LogDate) as last_punch from [$old]" }
    }
    if ($all -match '^Employees$') {
      W ''; W '  ---- [Employees] count and 5 codes (no names)'
      TryTbl $srv $db "select count(*) as staff from Employees"
      TryTbl $srv $db "select top 5 EmployeeCode from Employees order by EmployeeId desc"
    }
    W ''; W '  ---- who can read this database'
    TryTbl $srv $db "select dp.name, dp.type_desc from sys.database_principals dp where dp.type in ('S','U','G') and dp.name not like '##%' order by dp.name"
  }
  W ''; W '  ---- SQL logins'
  TryTbl $srv 'master' "select name, type_desc, is_disabled from sys.server_principals where type in ('S','U','G') and name not like '##%' order by name"
}

W ''; W "== done. File: $out"
$log | Set-Content -Path $out -Encoding UTF8
