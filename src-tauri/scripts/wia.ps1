# Prisca scanner worker.
# Talks to scanners through Windows Image Acquisition (WIA), which every
# scanner and all-in-one printer driver on Windows provides.
# Protocol: one JSON request per line on stdin, one JSON reply per line on stdout.
#   {"id":1,"cmd":"devices"}
#   {"id":2,"cmd":"scan","device":"<DeviceID>","dpi":200,"intent":"grey","source":"flatbed","out":"C:\\...\\scans"}
# Replies: {"id":1,"ok":true,...} or {"id":1,"ok":false,"error":"...","code":"..."}

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$FMT_PNG = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
$FMT_BMP = '{B96B3CAB-0728-11D3-9D7B-0000F81EF32E}'

# WIA property IDs
$P_DOC_CAPS   = 3086   # document handling capabilities (1 feeder, 2 flatbed, 4 duplex)
$P_DOC_SELECT = 3088   # document handling select (1 feeder, 2 flatbed)
$P_PAGES      = 3096   # pages to scan from the feeder (0 = all)
$P_BED_W      = 3074   # flatbed width, 1/1000 inch
$P_BED_H      = 3075   # flatbed height, 1/1000 inch
$P_INTENT     = 6146   # 1 colour, 2 greyscale, 4 text (black and white)
$P_XRES       = 6147
$P_YRES       = 6148
$P_XPOS       = 6149
$P_YPOS       = 6150
$P_XEXT       = 6151
$P_YEXT       = 6152
$P_DEPTH      = 4104

$Errors = @{
    0x80210001 = @('general', 'The scanner reported an error. Turn it off and on, then try again.')
    0x80210002 = @('jam', 'Paper is jammed in the scanner.')
    0x80210003 = @('empty', 'There is no paper in the document feeder.')
    0x80210004 = @('problem', 'The scanner has a problem. Check it and try again.')
    0x80210005 = @('offline', 'The scanner is offline. Check that it is on and connected.')
    0x80210006 = @('busy', 'The scanner is busy. Wait for it to finish, then try again.')
    0x80210007 = @('warming', 'The scanner is warming up. Try again in a few seconds.')
    0x80210008 = @('attention', 'The scanner needs attention. Check its lights or display.')
    0x80210009 = @('notfound', 'The scanner was disconnected.')
    0x8021000A = @('offline', 'Lost contact with the scanner. Check the cable and that it is on.')
    0x8021000B = @('unsupported', 'The scanner does not support that request.')
    0x8021000C = @('setting', 'The scanner rejected these settings. Try another resolution.')
    0x8021000D = @('locked', 'The scanner is locked. Unlock its scan head.')
    0x8021000E = @('driver', 'The scanner driver failed. Turn the scanner off and on.')
    0x8021000F = @('driver', 'The scanner driver failed. Turn the scanner off and on.')
    0x80210015 = @('notfound', 'No scanner was found.')
    0x80210016 = @('cover', 'The scanner lid is open.')
    0x80210017 = @('lamp', 'The scanner lamp is off.')
    0x80210020 = @('multifeed', 'More than one sheet went through the feeder.')
    0x800704C7 = @('cancelled', 'Scanning was cancelled.')
    0x80070015 = @('offline', 'The scanner is not ready. Check that it is on and connected.')
    0x8007001F = @('offline', 'The scanner stopped responding. Check the cable.')
    0x80070079 = @('offline', 'The scanner stopped responding. Check the cable.')
    0x80070057 = @('unsupported', 'The scanner does not support that request.')
}

function Write-Reply($obj) {
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
}

# Diagnostics go to stderr, which Prisca keeps in a log file.
function Log([string]$m) {
    try { [Console]::Error.WriteLine("$(Get-Date -Format 'HH:mm:ss.fff') $m"); [Console]::Error.Flush() } catch {}
}

function Get-HResult($err) {
    $e = $err.Exception
    while ($e) {
        if ($e.HResult -and (($e.HResult -band 0xFFFF0000) -eq 0x80210000)) { return $e.HResult }
        if ($e -is [System.Runtime.InteropServices.COMException]) { return $e.HResult }
        $e = $e.InnerException
    }
    return $err.Exception.HResult
}

function Norm-HResult($v) {
    $n = [int64]$v
    if ($n -lt 0) { $n += 4294967296 }
    return $n
}

function Describe-Error($err) {
    $key = Norm-HResult (Get-HResult $err)
    foreach ($k in $Errors.Keys) {
        if ((Norm-HResult $k) -eq $key) { return @{ code = $Errors[$k][0]; error = $Errors[$k][1]; hresult = ('0x{0:X8}' -f $key) } }
    }
    $m = $err.Exception; while ($m.InnerException) { $m = $m.InnerException }
    return @{ code = 'unknown'; error = "$($m.Message)".Trim(); hresult = ('0x{0:X8}' -f $key) }
}

function Find-Prop($props, [int]$id) {
    foreach ($p in $props) { if ($p.PropertyID -eq $id) { return $p } }
    return $null
}

function Read-Prop($props, [int]$id) {
    $p = Find-Prop $props $id
    if ($p) { try { return $p.Value } catch { return $null } }
    return $null
}

function Set-Prop($props, [int]$id, $value) {
    $p = Find-Prop $props $id
    if (-not $p) { return $false }
    try { $p.Value = $value; return $true } catch {
        try {
            [void][System.__ComObject].InvokeMember('Value', [Reflection.BindingFlags]::SetProperty, $null, $p, @($value))
            return $true
        } catch { Log "set $id=$value refused: $($_.Exception.Message)"; return $false }
    }
}

# Nearest value the driver accepts for a property (range or list).
function Nearest-Allowed($prop, [int]$want) {
    try {
        if ($prop.SubType -eq 1) {        # range
            $min = [int]$prop.SubTypeMin; $max = [int]$prop.SubTypeMax
            $step = [int]$prop.SubTypeStep; if ($step -le 0) { $step = 1 }
            $v = [Math]::Min([Math]::Max($want, $min), $max)
            $r = [int]($min + [Math]::Round(($v - $min) / $step) * $step)
            return [Math]::Min([Math]::Max($r, $min), $max)
        }
        if ($prop.SubType -eq 2) {        # list
            $best = $null
            foreach ($v in $prop.SubTypeValues) {
                if ($best -eq $null -or [Math]::Abs([int]$v - $want) -lt [Math]::Abs([int]$best - $want)) { $best = [int]$v }
            }
            if ($best -ne $null) { return $best }
        }
    } catch {}
    return $want
}

function Get-Devices {
    $dm = New-Object -ComObject WIA.DeviceManager
    $list = @()
    foreach ($di in $dm.DeviceInfos) {
        if ($di.Type -ne 1) { continue }   # scanners only
        $name = ''; $maker = ''
        try { $name = $di.Properties.Item('Name').Value } catch {}
        try { $maker = $di.Properties.Item('Manufacturer').Value } catch {}
        $feeder = $false; $flatbed = $true
        try {
            $dev = $di.Connect()
            $caps = Read-Prop $dev.Properties $P_DOC_CAPS
            if ($caps -ne $null) {
                $feeder = (([int]$caps -band 1) -ne 0)
                $flatbed = (([int]$caps -band 2) -ne 0) -or -not $feeder
            }
            if (-not $feeder) {
                foreach ($it in $dev.Items) {
                    try { if ("$($it.Properties.Item('Item Name').Value)" -match 'feeder|adf') { $feeder = $true } } catch {}
                }
            }
        } catch { Log "devices: couldn't open $name : $($_.Exception.Message)" }
        $list += @{ id = $di.DeviceID; name = "$name"; manufacturer = "$maker"; feeder = $feeder; flatbed = $flatbed }
    }
    return ,$list
}

# The saved scanner, by id, then by name (ids can change after re-plugging),
# else the first one. Retries once if the scanner is busy or waking up.
function Connect-Device([string]$deviceId, [string]$deviceName) {
    for ($try = 1; $try -le 2; $try++) {
        $dm = New-Object -ComObject WIA.DeviceManager
        $byId = $null; $byName = $null; $first = $null
        foreach ($di in $dm.DeviceInfos) {
            if ($di.Type -ne 1) { continue }
            if (-not $first) { $first = $di }
            if ($deviceId -and $di.DeviceID -eq $deviceId) { $byId = $di }
            $n = ''; try { $n = "$($di.Properties.Item('Name').Value)" } catch {}
            if ($deviceName -and $n -eq $deviceName -and -not $byName) { $byName = $di }
        }
        $pick = if ($byId) { $byId } elseif ($byName) { $byName } else { $first }
        if (-not $pick) { throw [System.Runtime.InteropServices.COMException]::new('No scanner found', [int]0x80210015) }
        try { return $pick.Connect() } catch {
            $d = Describe-Error $_
            if ($try -lt 2 -and $d.code -in @('busy', 'warming', 'offline')) { Log "connect: $($d.code), retrying"; Start-Sleep -Seconds 3; continue }
            throw
        }
    }
}

function Item-Name($it) {
    try { return "$($it.Properties.Item('Item Name').Value)" } catch { return '' }
}

function Pick-Item($dev, [string]$source) {
    $items = @(); foreach ($it in $dev.Items) { $items += $it }
    $glass = $null
    if ($items.Count -eq 0) { throw 'The scanner has nothing to scan from.' }
    Log ("items: " + (($items | ForEach-Object { Item-Name $_ }) -join ', '))
    if ($source -eq 'feeder') {
        foreach ($it in $items) { if ((Item-Name $it) -match 'feeder|adf') { return $it } }
    } else {
        foreach ($it in $items) { if ((Item-Name $it) -match 'flatbed|platen|glass') { return $it } }
        # A WIA 2 "Auto" item or a feeder item is not the glass.
        foreach ($it in $items) { if ((Item-Name $it) -notmatch 'feeder|adf|auto') { $glass = $it; break } }
    }
    # Older (WIA 1) drivers: one item, the source is a device property.
    [void](Set-Prop $dev.Properties $P_DOC_SELECT ($(if ($source -eq 'feeder') { 1 } else { 2 })))
    if ($source -eq 'feeder') { [void](Set-Prop $dev.Properties $P_PAGES 1) }
    if ($glass) { return $glass }
    return $items[0]
}

# Sets colour, resolution and the whole bed. Each step re-reads the item's
# properties: their allowed ranges change with the previous step.
# Returns the resolution the driver actually took.
function Configure-Item($dev, $item, [int]$dpi, [string]$intent, [switch]$Minimal) {
    $color = $intent -eq 'color'
    if (-not $Minimal) {
        # Black and white is made in Prisca from a grey scan: drivers' 1-bit output looks rough.
        [void](Set-Prop $item.Properties $P_INTENT $(if ($color) { 1 } else { 2 }))
        [void](Set-Prop $item.Properties 4103 $(if ($color) { 3 } else { 2 }))   # data type, for drivers that ignore intent
        [void](Set-Prop $item.Properties $P_DEPTH $(if ($color) { 24 } else { 8 }))
    }
    $props = $item.Properties
    $xr = Find-Prop $props $P_XRES
    if ($xr) { [void](Set-Prop $props $P_XRES (Nearest-Allowed $xr $dpi)) }
    $props = $item.Properties
    $real = Read-Prop $props $P_XRES
    $real = if ($real) { [int]$real } else { $dpi }
    $yr = Find-Prop $props $P_YRES
    if ($yr) { [void](Set-Prop $props $P_YRES (Nearest-Allowed $yr $real)) }
    if (-not $Minimal) {
        [void](Set-Prop $props $P_XPOS 0)
        [void](Set-Prop $props $P_YPOS 0)
        # Whole bed: the largest extent the driver allows at this resolution.
        $props = $item.Properties
        foreach ($set in @(@($P_XEXT, $P_BED_W, 6165), @($P_YEXT, $P_BED_H, 6166))) {
            $p = Find-Prop $props $set[0]
            if (-not $p) { continue }
            $max = $null
            try { if ($p.SubType -eq 1) { $max = [int]$p.SubTypeMax } } catch {}
            if (-not $max) {
                $bed = Read-Prop $dev.Properties $set[1]
                if (-not $bed) { $bed = Read-Prop $props $set[2] }   # item max width/height
                if ($bed) { $max = [int][Math]::Floor([int]$bed * $real / 1000) }
            }
            if ($max) { [void](Set-Prop $props $set[0] $max) }
        }
    }
    $props = $item.Properties
    $got = Read-Prop $props $P_XRES
    if ($got) { $real = [int]$got }
    Log ("configured: dpi=$real intent=$(Read-Prop $props $P_INTENT) depth=$(Read-Prop $props $P_DEPTH) " +
         "ext=$(Read-Prop $props $P_XEXT)x$(Read-Prop $props $P_YEXT) minimal=$Minimal")
    return $real
}

function Transfer-One($item, [string]$outDir, [string]$stem, [int]$dpi) {
    # Every driver must offer BMP; PNG only when the item lists it.
    $fmts = @(); try { foreach ($f in $item.Formats) { $fmts += "$f".ToUpper() } } catch {}
    $order = @(); if ($fmts -contains $FMT_PNG) { $order += $FMT_PNG }
    $order += $FMT_BMP; $order += $null
    $img = $null
    foreach ($fmt in $order) {
        try {
            $img = if ($fmt) { $item.Transfer($fmt) } else { $item.Transfer() }
            if ($img) { break }
        } catch {
            $d = Describe-Error $_
            Log "transfer $fmt failed: $($d.code) $($d.hresult) $($d.error)"
            if (($d.code -notin @('unknown', 'unsupported', 'general')) -or -not $fmt) { throw }
        }
    }
    if (-not $img) { throw [System.Runtime.InteropServices.COMException]::new('Scanning was cancelled.', [int]0x800704C7) }
    $ext = "$($img.FileExtension)".Trim('.').ToLower()
    if (-not $ext) { $ext = 'bmp' }
    $path = Join-Path $outDir ("$stem.$ext")
    if (Test-Path $path) { Remove-Item $path -Force }
    $img.SaveFile($path)
    $fileDpi = 0; try { $fileDpi = [int]$img.HorizontalResolution } catch {}
    Log "saved $path $($img.Width)x$($img.Height) fileDpi=$fileDpi"
    return @{ path = $path; width = $img.Width; height = $img.Height; dpi = $dpi; fileDpi = $fileDpi }
}

# One page from the glass, waiting out "warming up" / "busy" (HP all-in-ones
# warm up on the first scan after power-on, and stay busy after a cancel).
function Transfer-Patient($item, [string]$outDir, [string]$stem, [int]$dpi) {
    for ($try = 1; ; $try++) {
        try { return (Transfer-One $item $outDir $stem $dpi) }
        catch {
            $d = Describe-Error $_
            if ($d.code -in @('warming', 'busy') -and $try -lt 8) { Log "transfer: $($d.code), waiting"; Start-Sleep -Seconds 4; continue }
            throw
        }
    }
}

# The scanner stays connected and set up between scans with the same settings,
# so a batch only pays for connecting once; the next scan goes straight to the
# transfer. Prisca sends 'release' when it has been idle for a while.
$script:Ready = @{ key = ''; item = $null; dev = $null; real = 0; minimal = $false }
$script:NeedsMinimal = @{}
function Drop-Ready { $script:Ready = @{ key = ''; item = $null; dev = $null; real = 0; minimal = $false } }

function Do-Scan($req) {
    $t0 = [Diagnostics.Stopwatch]::StartNew()
    New-Item -ItemType Directory -Force -Path $req.out | Out-Null
    $source = if ($req.source) { "$($req.source)" } else { 'flatbed' }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
    $key = "$($req.device)|$($req.deviceName)|$source|$($req.dpi)|$($req.intent)"
    Log "scan: device=$($req.deviceName) dpi=$($req.dpi) intent=$($req.intent) source=$source warm=$($script:Ready.key -eq $key)"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $warm = ($attempt -eq 1 -and $script:Ready.key -eq $key -and $script:Ready.item)
        if ($warm) {
            $item = $script:Ready.item; $real = $script:Ready.real; $minimal = $script:Ready.minimal
        } else {
            Drop-Ready
            $minimal = [bool]$script:NeedsMinimal["$($req.device)"] -or ($attempt -eq 3)
            $dev = Connect-Device "$($req.device)" "$($req.deviceName)"
            $item = Pick-Item $dev $source
            $real = Configure-Item $dev $item ([int]$req.dpi) "$($req.intent)" -Minimal:$minimal
            $script:Ready = @{ key = $key; item = $item; dev = $dev; real = $real; minimal = $minimal }
        }
        $setupMs = $t0.ElapsedMilliseconds
        $pages = @()
        try {
            if ($source -eq 'feeder') {
                for ($n = 1; $n -le 200; $n++) {
                    try { $pages += (Transfer-One $item $req.out "scan-$stamp-$n" $real) }
                    catch {
                        $d = Describe-Error $_
                        if ($d.code -eq 'empty' -and $pages.Count -gt 0) { break }
                        throw
                    }
                }
            } else {
                $pages += (Transfer-Patient $item $req.out "scan-$stamp" $real)
            }
            $total = $t0.ElapsedMilliseconds
            Log "scan done: setup=${setupMs}ms total=${total}ms warm=$warm"
            return @{ pages = $pages; dpi = $real; simple = $minimal; setupMs = $setupMs; totalMs = $total; warm = [bool]$warm }
        } catch {
            $d = Describe-Error $_
            Drop-Ready
            if ($pages.Count -gt 0 -or $d.code -in @('cancelled', 'empty', 'jam', 'cover', 'multifeed', 'locked', 'attention')) { throw }
            if ($warm) {
                # The kept connection went stale (printer slept, re-plugged): connect afresh.
                Log "kept connection failed ($($d.code) $($d.hresult)); reconnecting"
                [GC]::Collect(); [GC]::WaitForPendingFinalizers()
                $attempt = 1; $script:Ready.key = '__retry__'
                continue
            }
            if (-not $minimal -and $d.code -in @('setting', 'unsupported', 'unknown', 'general')) {
                # The driver didn't like our settings: use its own defaults from now on
                # (Prisca makes grey and black-and-white itself, so colour is fine).
                Log "scan failed with our settings ($($d.code) $($d.hresult)); using the driver's defaults"
                $script:NeedsMinimal["$($req.device)"] = $true
                [GC]::Collect(); [GC]::WaitForPendingFinalizers()
                continue
            }
            throw
        }
    }
}

# Everything the driver says about itself, for diagnosing odd scanners.
function Dump-Props($props) {
    $o = @()
    foreach ($p in $props) {
        $e = @{ id = $p.PropertyID; name = "$($p.Name)"; ro = $p.IsReadOnly; sub = $p.SubType }
        try { $e.value = "$($p.Value)" } catch {}
        try {
            if ($p.SubType -eq 1) { $e.min = $p.SubTypeMin; $e.max = $p.SubTypeMax; $e.step = $p.SubTypeStep }
            elseif ($p.SubType -ge 2) { $e.values = @(foreach ($v in $p.SubTypeValues) { "$v" }) }
        } catch {}
        $o += $e
    }
    return ,$o
}
function Do-Probe($req) {
    $dev = Connect-Device "$($req.device)" "$($req.deviceName)"
    $items = @()
    foreach ($it in $dev.Items) {
        $f = @(); try { foreach ($x in $it.Formats) { $f += "$x" } } catch {}
        $items += @{ name = (Item-Name $it); formats = $f; props = (Dump-Props $it.Properties) }
    }
    return @{ device = (Dump-Props $dev.Properties); items = $items }
}

# ---------- Text recognition (Windows OCR) ----------
$script:OcrReady = $false
function Init-Ocr {
    if ($script:OcrReady) { return }
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:AsTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    [void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
    [void][Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
    [void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
    [void][Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics,ContentType=WindowsRuntime]
    [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
    $script:OcrReady = $true
}
function Await($op, [Type]$type) {
    $task = $script:AsTask.MakeGenericMethod($type).Invoke($null, @($op))
    [void]$task.Wait(-1)
    return $task.Result
}
function Do-Ocr([string]$path) {
    Init-Ocr
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) { return @{ available = $false; lines = @() } }
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    } finally { $stream.Dispose() }
    $lines = @()
    foreach ($line in $result.Lines) {
        $words = @()
        foreach ($w in $line.Words) {
            $r = $w.BoundingRect
            $words += @{ t = $w.Text; x = [Math]::Round($r.X, 1); y = [Math]::Round($r.Y, 1); w = [Math]::Round($r.Width, 1); h = [Math]::Round($r.Height, 1) }
        }
        $lines += @{ words = $words }
    }
    return @{ available = $true; language = "$($engine.RecognizerLanguage.LanguageTag)"; lines = $lines; max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension }
}

Write-Reply @{ id = 0; ok = $true; ready = $true }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($line -eq $null) { break }
    if (-not $line.Trim()) { continue }
    $id = 0
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        switch ($req.cmd) {
            'devices' { Write-Reply @{ id = $id; ok = $true; devices = (Get-Devices) } }
            'scan'    { $r = Do-Scan $req; Write-Reply @{ id = $id; ok = $true; pages = $r.pages; dpi = $r.dpi; simple = $r.simple; setupMs = $r.setupMs; totalMs = $r.totalMs; warm = $r.warm } }
            'release' { Drop-Ready; Write-Reply @{ id = $id; ok = $true } }
            'probe'   { Write-Reply @{ id = $id; ok = $true; probe = (Do-Probe $req) } }
            'ocr'     { $r = Do-Ocr "$($req.path)"; Write-Reply @{ id = $id; ok = $true; available = $r.available; language = $r.language; lines = $r.lines; max = $r.max } }
            'ping'    { Write-Reply @{ id = $id; ok = $true } }
            default   { Write-Reply @{ id = $id; ok = $false; code = 'badcmd'; error = "Unknown command $($req.cmd)" } }
        }
    } catch {
        $d = Describe-Error $_
        Log "error: $($d.code) $($d.hresult) $($d.error)"
        Write-Reply @{ id = $id; ok = $false; code = $d.code; error = $d.error; hresult = $d.hresult }
    } finally {
        # Let go of the scanner between requests, so other apps (and the next scan) can use it.
        [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    }
}
