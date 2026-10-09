# Times the scanner with different settings (about 3-4 minutes; the glass can be empty,
# keep the lid closed). Results go to speed-test.log.
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'speed-test.log'
$wia = Join-Path $root 'src-tauri\scripts\wia.ps1'
$out = Join-Path $env:TEMP 'prisca-bench'
"Prisca speed test $(Get-Date -Format s)" | Set-Content -Path $log -Encoding UTF8
Write-Host 'Prisca speed test: about 4 minutes. Keep the lid closed; the glass can be empty.' -ForegroundColor Cyan
$runs = @(
    @{ label = 'grey 200 full (Document)'; dpi = 200; intent = 'grey'; height = 1; preview = 0 },
    @{ label = 'grey 200 full again (warm)'; dpi = 200; intent = 'grey'; height = 1; preview = 0 },
    @{ label = 'grey 150 full'; dpi = 150; intent = 'grey'; height = 1; preview = 0 },
    @{ label = 'grey 100 full'; dpi = 100; intent = 'grey'; height = 1; preview = 0 },
    @{ label = 'grey 75 full'; dpi = 75; intent = 'grey'; height = 1; preview = 0 },
    @{ label = 'grey 200 half height'; dpi = 200; intent = 'grey'; height = 0.5; preview = 0 },
    @{ label = 'grey 200 preview mode'; dpi = 200; intent = 'grey'; height = 1; preview = 1 },
    @{ label = 'colour 300 full (Photo)'; dpi = 300; intent = 'color'; height = 1; preview = 0 }
)
$req = @{ id = 1; cmd = 'bench'; device = ''; deviceName = ''; out = $out; runs = $runs } | ConvertTo-Json -Compress -Depth 5
$reply = $req | powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $wia 2>$null | Where-Object { $_ -match '"id":1' }
$reply | Add-Content -Path $log -Encoding UTF8
try {
    $r = $reply | ConvertFrom-Json
    "" | Add-Content -Path $log
    foreach ($x in $r.results) {
        $line = if ($x.ok) { "{0,-28} setup {1,5} ms   scan {2,6} ms   {3}" -f $x.label, $x.setupMs, $x.scanMs, $x.size } else { "{0,-28} FAILED {1}" -f $x.label, $x.error }
        Write-Host $line
        $line | Add-Content -Path $log -Encoding UTF8
    }
} catch { Write-Host "Couldn't read the results: $reply" }
Write-Host "`nSaved to $log" -ForegroundColor Green
