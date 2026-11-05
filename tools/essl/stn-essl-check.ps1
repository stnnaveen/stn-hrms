# StartupTN HR - eSSL eTimeTrackLite server check.
# READ ONLY: reads settings and database structure, changes nothing, sends nothing.
# Writes the result to Desktop\stn-essl-check.txt. Passwords are masked.
# Run in PowerShell (as Administrator):
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\stn-essl-check.ps1"

$ErrorActionPreference = 'Continue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$desk = [Environment]::GetFolderPath('Desktop'); if (-not $desk) { $desk = (Get-Location).Path }
$out = Join-Path $desk 'stn-essl-check.txt'
$log = New-Object System.Collections.Generic.List[string]
function W($s) { $t = [string]$s; $log.Add($t); Write-Host $t }
function Mask($s) { return ($s -replace '(?i)(password|pwd)\s*=\s*[^;]*', '$1=*****') }
function Tbl($dt) { if ($dt -and $dt.Rows.Count) { W (($dt | Format-Table -AutoSize | Out-String -Width 400).TrimEnd()) } else { W '  (no rows)' } }
function Q($cs, $sql) {
  $c = New-Object System.Data.SqlClient.SqlConnection $cs
  $c.Open()
  try {
    $cmd = $c.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 60
    $da = New-Object System.Data.SqlClient.SqlDataAdapter $cmd
    $dt = New-Object System.Data.DataTable; [void]$da.Fill($dt); return ,$dt
  } finally { $c.Close() }
}

W "== StartupTN eSSL check  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
$os = Get-CimInstance Win32_OperatingSystem
W "PC: $env:COMPUTERNAME | $($os.Caption) $($os.Version) | 64-bit: $([Environment]::Is64BitOperatingSystem)"
W "PowerShell: $($PSVersionTable.PSVersion) | Time zone: $((Get-TimeZone).Id) | Up since: $($os.LastBootUpTime)"
W "RAM GB: $([math]::Round($os.TotalVisibleMemorySize/1MB,1)) | Free disk C: GB: $([math]::Round((Get-PSDrive C).Free/1GB,1))"

W ''; W '== Power (0 = never sleeps)'
foreach ($k in 'STANDBYIDLE', 'HIBERNATEIDLE') {
  $l = powercfg /q SCHEME_CURRENT SUB_SLEEP $k 2>$null | Select-String 'Current AC Power Setting Index'
  if ($l) { W "  $k AC: $([Convert]::ToInt32(($l.Line -split ':')[1].Trim(), 16)) sec" }
}

W ''; W '== Clock'
W "  $((w32tm /query /status 2>&1 | Select-String 'Source|Last Successful' | ForEach-Object { $_.Line.Trim() }) -join ' | ')"

W ''; W '== Services (SQL, IIS, eSSL)'
Get-Service | Where-Object { $_.Name -like 'MSSQL*' -or $_.Name -like 'SQLAgent*' -or $_.Name -eq 'W3SVC' -or $_.DisplayName -match 'eTime|eSSL|iclock|ADMS|Biometric' } |
  ForEach-Object { W ("  {0} | {1} | {2} | start: {3}" -f $_.Name, $_.DisplayName, $_.Status, $_.StartType) }

W ''; W '== Internet to StartupTN cloud'
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://johnyztppvetjdcjuqan.supabase.co/functions/v1/check-in' -Method Options -TimeoutSec 15
  W "  reachable, HTTP $($r.StatusCode)"
} catch { W "  $($_.Exception.Message)" }

W ''; W '== eTimeTrackLite web API (localhost:8081)'
try {
  $p = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:8081/iclock/WebAPIService.asmx' -TimeoutSec 15
  $ops = [regex]::Matches($p.Content, 'op=(\w+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
  W "  operations: $($ops -join ', ')"
} catch { W "  $($_.Exception.Message)" }

W ''; W '== App folders and connection strings (passwords masked)'
$paths = New-Object System.Collections.Generic.List[string]
$appcmd = Join-Path $env:windir 'system32\inetsrv\appcmd.exe'
if (Test-Path $appcmd) {
  & $appcmd list vdir 2>$null | ForEach-Object {
    W "  IIS: $_"
    if ($_ -match 'physicalPath:([^)]+)\)') { $paths.Add([Environment]::ExpandEnvironmentVariables($Matches[1].Trim())) }
  }
}
foreach ($root in 'C:\inetpub', $env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\') {
  if ($root -and (Test-Path $root)) {
    Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'eTime|eSSL|iclock|ESSL' } | ForEach-Object { $paths.Add($_.FullName) }
  }
}
$conns = New-Object System.Collections.Generic.List[string]
$mdbs = New-Object System.Collections.Generic.List[string]
foreach ($pp in ($paths | Select-Object -Unique)) {
  W "  folder: $pp"
  Get-ChildItem -Path $pp -Recurse -Include 'web.config', '*.exe.config', '*.ini', '*.mdb', '*.accdb' -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object {
    if ($_.Extension -in '.mdb', '.accdb') { $mdbs.Add($_.FullName); W "    Access DB: $($_.FullName)  $([math]::Round($_.Length/1MB,1)) MB  modified $($_.LastWriteTime)" }
    else {
      $txt = Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue
      foreach ($m in [regex]::Matches($txt, '(?i)connectionString\s*=\s*"([^"]+)"')) { $conns.Add($m.Groups[1].Value); W "    $($_.Name): $(Mask $m.Groups[1].Value)" }
    }
  }
}

W ''; W '== SQL Server'
$cands = New-Object System.Collections.Generic.List[string]
foreach ($cs in $conns) { if ($cs -match '(?i)(data source|server)\s*=') { $cands.Add($cs) } }
Get-Service -Name 'MSSQL*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' } | ForEach-Object {
  $inst = if ($_.Name -eq 'MSSQLSERVER') { 'localhost' } else { 'localhost\' + ($_.Name -replace '^MSSQL\$', '') }
  $cands.Add("Server=$inst;Integrated Security=True;Connect Timeout=10")
}
$done = @{}
foreach ($cs in $cands) {
  $b = New-Object System.Data.SqlClient.SqlConnectionStringBuilder $cs
  $b.ConnectTimeout = 10
  try { $dbs = Q $b.ConnectionString "select name from sys.databases where database_id > 4 order by name" }
  catch { W "  cannot open $(Mask $cs): $($_.Exception.Message)"; continue }
  W "  connected: $(Mask $cs)"
  W "  databases: $(($dbs.Rows | ForEach-Object { $_.name }) -join ', ')"
  $names = @($dbs.Rows | ForEach-Object { $_.name } | Where-Object { $_ -match '(?i)etime|essl|att|biometric' -or $_ -eq $b.InitialCatalog })
  foreach ($db in $names) {
    $key = "$($b.DataSource)|$db"; if ($done[$key]) { continue }; $done[$key] = 1
    $b.InitialCatalog = $db; $c2 = $b.ConnectionString
    W ''; W "  ---- database [$db] tables and row counts"
    try {
      $t = Q $c2 "select t.name as tbl, sum(p.rows) as rows_ from sys.tables t join sys.partitions p on p.object_id = t.object_id and p.index_id in (0,1) group by t.name order by t.name"
      Tbl $t
      $all = @($t.Rows | ForEach-Object { $_.tbl })
      $logs = @($all | Where-Object { $_ -like 'DeviceLogs*' } | Sort-Object { if ($_ -match '_(\d+)_(\d{4})$') { [int]$Matches[2] * 100 + [int]$Matches[1] } else { 0 } } -Descending)
      $keyT = @('Devices', 'Employees', 'Departments', 'Locations', 'AttendanceLogs', 'DeviceCommands') + @($logs | Select-Object -First 1)
      foreach ($tn in ($keyT | Where-Object { $all -contains $_ })) {
        W ''; W "  ---- columns of [$tn]"
        Tbl (Q $c2 "select COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH as len, IS_NULLABLE from INFORMATION_SCHEMA.COLUMNS where TABLE_NAME = '$tn' order by ORDINAL_POSITION")
      }
      if ($all -contains 'Devices') { W ''; W '  ---- [Devices] rows'; Tbl (Q $c2 "select top 50 * from Devices") }
      if ($logs.Count) {
        $lt = $logs[0]
        W ''; W "  ---- latest 5 rows of [$lt]"
        Tbl (Q $c2 "select top 5 * from [$lt] order by 1 desc")
        W ''; W "  ---- [$lt] id range and last punch"
        Tbl (Q $c2 "select min(DeviceLogId) as min_id, max(DeviceLogId) as max_id, max(LogDate) as last_punch, max(DownloadDate) as last_download, count(*) as n from [$lt]")
        W "  log tables: $($logs -join ', ')"
      }
      if ($all -contains 'Employees') {
        W ''; W '  ---- [Employees] count and 5 codes (no names)'
        Tbl (Q $c2 "select count(*) as staff from Employees")
        try { Tbl (Q $c2 "select top 5 EmployeeCode from Employees order by EmployeeId desc") } catch { W "  $($_.Exception.Message)" }
      }
    } catch { W "  error: $($_.Exception.Message)" }
  }
}

if ($mdbs.Count) {
  W ''; W '== Access databases (tables only)'
  foreach ($f in $mdbs) {
    foreach ($prov in 'Microsoft.ACE.OLEDB.12.0', 'Microsoft.Jet.OLEDB.4.0') {
      try {
        $c = New-Object System.Data.OleDb.OleDbConnection "Provider=$prov;Data Source=$f;Mode=Read"
        $c.Open(); $s = $c.GetSchema('Tables'); $c.Close()
        W "  $f via $prov : $((($s.Rows | Where-Object { $_.TABLE_TYPE -eq 'TABLE' }) | ForEach-Object { $_.TABLE_NAME }) -join ', ')"
        break
      } catch { W "  $f via $prov : $($_.Exception.Message)" }
    }
  }
}

W ''; W "== done. File: $out"
$log | Set-Content -Path $out -Encoding UTF8
