# Lists the scanners Windows Image Acquisition can see, the same way Prisca does.
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'scanner-check.log'
$wia = Join-Path $root 'src-tauri\scripts\wia.ps1'
"Prisca scanner check $(Get-Date -Format s)" | Set-Content -Path $log -Encoding UTF8
"Windows: $([Environment]::OSVersion.VersionString)  PowerShell: $($PSVersionTable.PSVersion)" | Add-Content -Path $log -Encoding UTF8
$svc = Get-Service stisvc -ErrorAction SilentlyContinue
"Windows Image Acquisition service: $(if ($svc) { $svc.Status } else { 'missing' })" | Add-Content -Path $log -Encoding UTF8
"--- Imaging devices (scanners) ---" | Add-Content -Path $log -Encoding UTF8
Get-PnpDevice -Class Image -ErrorAction SilentlyContinue | Format-Table -AutoSize Status, FriendlyName, InstanceId | Out-String -Width 200 | Add-Content -Path $log -Encoding UTF8
"--- Printers ---" | Add-Content -Path $log -Encoding UTF8
Get-Printer -ErrorAction SilentlyContinue | Format-Table -AutoSize Name, DriverName, PortName, PrinterStatus | Out-String -Width 200 | Add-Content -Path $log -Encoding UTF8
"--- USB / other devices that look like the printer ---" | Add-Content -Path $log -Encoding UTF8
Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'HP|Deskjet|Officejet|Canon|Epson|Brother|scan|print|MFP' } | Format-Table -AutoSize Status, Class, FriendlyName | Out-String -Width 200 | Add-Content -Path $log -Encoding UTF8
"--- What Prisca sees ---" | Add-Content -Path $log -Encoding UTF8
$out = '{"id":1,"cmd":"devices"}' | powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $wia 2>&1
$out | Add-Content -Path $log -Encoding UTF8
# If a scanner is there, also record everything its driver reports (for tuning Prisca).
if ("$out" -match '"devices":\[\{') {
    "--- Scanner details (probe) ---" | Add-Content -Path $log -Encoding UTF8
    $req = '{"id":1,"cmd":"probe","device":"","deviceName":""}'
    $req | powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $wia 2>&1 | Add-Content -Path $log -Encoding UTF8
}
Get-Content $log | Write-Host
