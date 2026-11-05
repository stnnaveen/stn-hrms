param([string]$Sql, [hashtable]$Params, [string]$Dir)
function T([string[]]$cols) { $dt = New-Object System.Data.DataTable; foreach ($c in $cols) { [void]$dt.Columns.Add($c, [object]) }; return ,$dt }
$n = Get-Date; $p = $n.AddMonths(-1)
$cur = "DeviceLogs_$($n.Month)_$($n.Year)"; $prev = "DeviceLogs_$($p.Month)_$($p.Year)"
if ($Sql -match 'from sys.tables') { $dt = T 'sch','tbl'; [void]$dt.Rows.Add('essl', $cur); [void]$dt.Rows.Add('essl', $prev); return ,$dt }
if ($Sql -match 'dbo.Devices') { $dt = T 'DeviceId','DeviceFName','SerialNumber','IpAddress','LastPing','LastLogDownloadDate'
  [void]$dt.Rows.Add(14,'Biometric','TDBD241800565','192.168.1.252',[datetime]'2026-11-05 12:00:00',[DBNull]::Value); [void]$dt.Rows.Add(1,'Manual Entry(Attendance)','','',[DBNull]::Value,[DBNull]::Value); return ,$dt }
if ($Sql -match 'dbo.Employees') { $dt = T 'EmployeeCodeInDevice','EmployeeCode','EmployeeName'; [void]$dt.Rows.Add('56','STN056','Test A'); [void]$dt.Rows.Add('16','016','Test B'); return ,$dt }
if ($Sql -match 'from \[essl\]\.\[(DeviceLogs_\d+_\d+)\]') {
  $tbl = $Matches[1]; $count = [int](Get-Content (Join-Path $Dir "$tbl.count") -ErrorAction SilentlyContinue); if (-not $count) { $count = 0 }
  $dt = T 'DeviceLogId','DeviceId','UserId','LogDate','Direction','AttDirection','DownloadDate'
  $from = [int]$Params['@cur'] + 1
  for ($i = $from; $i -le $count -and $dt.Rows.Count -lt 500; $i++) { [void]$dt.Rows.Add($i, 14, $(if ($i % 2) {'56'} else {'16'}), ([datetime]'2026-11-05 09:00:00').AddMinutes($i), 'in', [DBNull]::Value, ([datetime]'2026-11-05 09:00:05').AddMinutes($i)) }
  return ,$dt }
throw "fake: unknown query $Sql"
