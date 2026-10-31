# StartupTN HR - one-time biometric test (read-only)
# Asks the office eTimeTrackLite server for punches and saves the raw replies, so we can see the exact
# data format before building the real connection. It changes nothing on the biometric system.
# Works on Windows PowerShell 5.1 (built into Windows 10/11) and PowerShell 7.

param([string]$ArgUrl, [string]$ArgSerial, [string]$ArgUser, [string]$ArgPassword, [string]$ArgDays, [string]$ArgSpeedTest)  # optional; normally asked on screen
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Ask([string]$label, [string]$default) {
  $shown = $label; if ($default) { $shown = "$label [$default]" }
  $v = Read-Host $shown
  if ([string]::IsNullOrWhiteSpace($v)) { return $default } else { return $v.Trim() }
}
function Esc([string]$s) { return [System.Security.SecurityElement]::Escape($s) }

Write-Host ''
Write-Host '  StartupTN HR - biometric test' -ForegroundColor Cyan
Write-Host '  Read-only. Saves what the biometric server sends back. Press Enter to accept a [default].'
Write-Host ''

$url    = $(if ($ArgUrl) { $ArgUrl } else { Ask 'eTimeTrackLite web service address' 'http://localhost/iclock/WebAPIService.asmx' })
$serial = $(if ($ArgSerial) { $ArgSerial } else { Ask 'Device serial number (from eTimeTrackLite > Devices)' '' })
$user   = $(if ($ArgUser) { $ArgUser } else { Ask 'eTimeTrackLite user name' '' })
if ($ArgPassword) { $pass = $ArgPassword } else {
  $sec  = Read-Host 'eTimeTrackLite password (hidden)' -AsSecureString
  $pass = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
$days   = [int]$(if ($ArgDays) { $ArgDays } else { Ask 'How many past days to fetch (1 = yesterday and today)' '1' })

$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$desk  = [Environment]::GetFolderPath('Desktop'); if (-not $desk) { $desk = (Get-Location).Path }
$out   = Join-Path $desk "stn-biometric-test-$stamp"
New-Item -ItemType Directory -Path $out -Force | Out-Null
$log = New-Object System.Collections.Generic.List[string]
function Note([string]$s) { Write-Host "  $s"; $log.Add($s) | Out-Null }

Note "Run at      : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') (PC clock, time zone $([TimeZoneInfo]::Local.Id))"
Note "PC          : $env:COMPUTERNAME"
Note "Server      : $url"
Note "Device      : $serial"
Note "User        : $user (password not saved)"
Note ''

# 1. Service description: lists the exact methods and fields this installation supports
try {
  $t0 = Get-Date
  $w = Invoke-WebRequest -Uri ($url + '?WSDL') -UseBasicParsing -TimeoutSec 30
  [IO.File]::WriteAllText((Join-Path $out '1-service-description.xml'), $w.Content)
  Note ("1. Service description: OK ({0} ms)" -f [int]((Get-Date) - $t0).TotalMilliseconds)
} catch {
  Note "1. Service description: FAILED - $($_.Exception.Message)"
  Note '   Check the address. Open it in a browser on this PC: it should show a page listing GetTransactionsLog.'
}

# 2. Punches per day, in two date styles (the manual shows 2021/05/22; some installations want 2021-05-22)
function Get-Log([string]$from, [string]$to) {
  $body = @"
<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetTransactionsLog xmlns="http://tempuri.org/">
      <FromDate>$(Esc $from)</FromDate>
      <ToDate>$(Esc $to)</ToDate>
      <SerialNumber>$(Esc $serial)</SerialNumber>
      <UserName>$(Esc $user)</UserName>
      <UserPassword>$(Esc $pass)</UserPassword>
      <strDataList></strDataList>
    </GetTransactionsLog>
  </soap:Body>
</soap:Envelope>
"@
  $t0 = Get-Date
  $r = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing -TimeoutSec 60 -ContentType 'text/xml; charset=utf-8' `
        -Headers @{ SOAPAction = '"http://tempuri.org/GetTransactionsLog"' } -Body ([Text.Encoding]::UTF8.GetBytes($body))
  return @{ Xml = $r.Content; Ms = [int]((Get-Date) - $t0).TotalMilliseconds }
}
function Read-Fields([string]$xml) {
  $res = ''; $list = ''
  try {
    [xml]$x = $xml
    $ns = New-Object Xml.XmlNamespaceManager $x.NameTable; $ns.AddNamespace('t', 'http://tempuri.org/')
    $a = $x.SelectSingleNode('//t:GetTransactionsLogResult', $ns); if ($a) { $res = $a.InnerText }
    $b = $x.SelectSingleNode('//t:strDataList', $ns); if ($b) { $list = $b.InnerText }
  } catch { }
  return @{ Result = $res; List = $list }
}

$best = $null
for ($d = $days; $d -ge 0; $d--) {
  $day = (Get-Date).Date.AddDays(-$d)
  foreach ($fmt in @('yyyy/MM/dd', 'yyyy-MM-dd')) {
    $f = $day.ToString($fmt, [Globalization.CultureInfo]::InvariantCulture)
    $tag = '{0}_{1}' -f $day.ToString('yyyy-MM-dd'), ($(if ($fmt -eq 'yyyy/MM/dd') { 'slash' } else { 'dash' }))
    try {
      $g = Get-Log $f $f
      [IO.File]::WriteAllText((Join-Path $out "2-punches-$tag.xml"), $g.Xml)
      $p = Read-Fields $g.Xml
      [IO.File]::WriteAllText((Join-Path $out "2-punches-$tag.txt"), "Result:`r`n$($p.Result)`r`n`r`nstrDataList:`r`n$($p.List)")
      $lines = @($p.List -split "`r?`n|;" | Where-Object { $_.Trim() }).Count
      Note ("2. {0} ({1}): OK in {2} ms. Result: '{3}'. Lines in strDataList: {4}" -f $day.ToString('ddd dd MMM'), $f, $g.Ms, ($p.Result -replace '\s+', ' ').Substring(0, [Math]::Min(60, ($p.Result -replace '\s+', ' ').Length)), $lines)
      if ($lines -gt 0 -and -not $best) { $best = $fmt }
    } catch {
      $msg = $_.Exception.Message
      try { $resp = $_.Exception.Response; if ($resp) { $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $txt = $sr.ReadToEnd(); [IO.File]::WriteAllText((Join-Path $out "2-error-$tag.xml"), $txt) } } catch { }
      Note ("2. {0} ({1}): FAILED - {2}" -f $day.ToString('ddd dd MMM'), $f, $msg)
    }
  }
}
if ($best) { Note "   Date style that returned punches: $best" } else { Note '   No punches came back. If the device had punches on these days, check the serial number and the user permissions.' }
Note ''

# 3. Optional: how fast a new punch reaches this server (answers the real-time question)
$go = $(if ($ArgSpeedTest) { $ArgSpeedTest } else { Ask 'Optional speed test: punch on the device now and measure how fast it shows up? (y/n)' 'n' })
if ($go -match '^[yY]') {
  $fmt = $(if ($best) { $best } else { 'yyyy/MM/dd' })
  $today = (Get-Date).ToString($fmt, [Globalization.CultureInfo]::InvariantCulture)
  try {
    $before = (Read-Fields (Get-Log $today $today).Xml).List
    Read-Host '  Now punch once on the device (finger or face), then press Enter here'
    $t0 = Get-Date; $seen = $false
    while (((Get-Date) - $t0).TotalSeconds -lt 180) {
      Start-Sleep -Seconds 3
      $now = (Read-Fields (Get-Log $today $today).Xml).List
      if ($now -ne $before) { $seen = $true; break }
    }
    if ($seen) {
      Note ("3. Speed test: new punch appeared after about {0} seconds." -f [int]((Get-Date) - $t0).TotalSeconds)
      [IO.File]::WriteAllText((Join-Path $out '3-after-test-punch.txt'), $now)
    } else { Note '3. Speed test: no new punch within 3 minutes. The device may send in batches (ask the vendor about real-time mode).' }
  } catch { Note "3. Speed test: FAILED - $($_.Exception.Message)" }
}

[IO.File]::WriteAllLines((Join-Path $out '0-summary.txt'), $log)
$zip = "$out.zip"
try { Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip -Force; $where = $zip } catch { $where = $out }
$pass = $null
Write-Host ''
Write-Host "  Done. Send this file to Naveen:" -ForegroundColor Green
Write-Host "  $where" -ForegroundColor Green
Write-Host '  (It has punch times and employee codes for the days above. No password is saved.)'
Write-Host ''
if (-not $ArgUrl) { Read-Host '  Press Enter to close' }
