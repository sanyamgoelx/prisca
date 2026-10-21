# Prints a test sheet to "Microsoft Print to PDF" through Prisca's helper (no paper, no dialog).
# Used by the Build workflow; on a PC double-click print-test.cmd (writes test-files\print-test.pdf).
param([string]$Out = '')
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$dir = Join-Path $env:TEMP 'prisca-print-test'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
# A 100 x 60 mm picture at 300 dpi with a black frame.
$bmp = New-Object System.Drawing.Bitmap 1181, 709
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.DrawRectangle((New-Object System.Drawing.Pen ([System.Drawing.Color]::Black), 12), 6, 6, 1169, 697)
$g.DrawString('Prisca print test', (New-Object System.Drawing.Font 'Arial', 48), [System.Drawing.Brushes]::Black, 80, 300)
$g.Dispose()
$jpg = Join-Path $dir 'page.jpg'
$bmp.Save($jpg, [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
$pdf = if ($Out) { $Out } else { Join-Path $dir 'test.pdf' }
New-Item -ItemType Directory -Force -Path (Split-Path $pdf) | Out-Null
if (Test-Path $pdf) { Remove-Item $pdf }

$printer = 'Microsoft Print to PDF'
if (-not ([System.Drawing.Printing.PrinterSettings]::InstalledPrinters -contains $printer)) {
    "$printer isn't installed here: printing test skipped."
    exit 0
}
$job = @{
    printer = $printer; paper = 9; color = $true; draft = $false; copies = 1; title = 'Prisca print test'; toFile = $pdf
    sheets = @(
        @{ landscape = $false; items = @(@{ path = $jpg; x = 55; y = 20; w = 100; h = 60; cx = 10; cy = 10; cw = 190; ch = 277 }) },
        @{ landscape = $true; items = @(@{ path = $jpg; x = 10; y = 10; w = 100; h = 60; cx = 10; cy = 10; cw = 277; ch = 190 }) }
    )
}
$reqs = @(
    (@{ id = 1; cmd = 'printers' } | ConvertTo-Json -Compress),
    (@{ id = 2; cmd = 'printer'; name = $printer; paper = 9 } | ConvertTo-Json -Compress),
    (@{ id = 3; cmd = 'print'; job = $job } | ConvertTo-Json -Compress -Depth 8)
)
$worker = Join-Path $PSScriptRoot '..\src-tauri\scripts\wia.ps1'
$out = $reqs | powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $worker
$out
# Replies are one JSON object per line, but a redirected console can hand them back joined.
$text = ($out | Out-String)
$replies = @([regex]::Split($text, '(?<=\})\s+(?=\{)') | Where-Object { $_.Trim() -match '^\{' } | ForEach-Object { $_.Trim() | ConvertFrom-Json })
foreach ($id in 1, 2, 3) {
    $r = $replies | Where-Object { $_.id -eq $id }
    if (-not $r -or -not $r.ok) { throw "request $id failed: $($r.error)" }
}
if (-not (($replies | Where-Object { $_.id -eq 1 }).printers | Where-Object { $_.name -eq $printer })) { throw "$printer not listed" }
$info = $replies | Where-Object { $_.id -eq 2 }
if (-not ($info.sizes | Where-Object { $_.kind -eq 9 })) { throw 'A4 not listed' }
if (($replies | Where-Object { $_.id -eq 3 }).sheets -ne 2) { throw 'expected 2 sheets' }
for ($i = 0; $i -lt 20 -and -not (Test-Path $pdf); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path $pdf) -or (Get-Item $pdf).Length -lt 1000) { throw 'no PDF written' }
"Printed $((Get-Item $pdf).Length) bytes to $pdf"

# Prisca opens PDFs with Windows' own renderer: read the test PDF back as pages.
$outDir = Join-Path $dir 'pages'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$req = @{ id = 5; cmd = 'pdf'; path = $pdf; dpi = 100; max = 10; out = $outDir } | ConvertTo-Json -Compress
$out2 = $req | powershell -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $worker
$text2 = ($out2 | Out-String)
$r5 = @([regex]::Split($text2, '(?<=\})\s+(?=\{)') | Where-Object { $_.Trim() -match '^\{' } | ForEach-Object { $_.Trim() | ConvertFrom-Json }) | Where-Object { $_.id -eq 5 }
if (-not $r5 -or -not $r5.ok) { $text2; throw "PDF pages failed: $($r5.error)" }
if ($r5.count -ne 2 -or @($r5.pages).Count -ne 2) { throw "expected 2 PDF pages, got $($r5.count)" }
$img = [System.Drawing.Image]::FromFile(@($r5.pages)[0].path)
try {
    # A4 at 100 dpi is about 827 x 1169.
    if ([Math]::Abs($img.Width - 827) -gt 3 -or [Math]::Abs($img.Height - 1169) -gt 3) { throw "page 1 rendered at $($img.Width) x $($img.Height)" }
    "PDF pages: $($r5.count), page 1 $($img.Width) x $($img.Height) at 100 dpi"
} finally { $img.Dispose() }
