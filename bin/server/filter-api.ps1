# Manual filter updates. ASCII only; no Node runtime, no downloaded script execution.
$filterStateFile = Join-Path $settingsDir 'filter.local.json'
$filterSourceUrl = 'https://nau-filter-gallery.vercel.app/nau-filter/nau-filter.js'
$filterGalleryUrl = 'https://nau-filter-gallery.vercel.app/'
$filterRoutes = @('/local-api/filter-state', '/local-api/filter-check', '/local-api/filter-candidate', '/local-api/filter-apply', '/local-api/filter-rollback')
$filterSource = $null
$filterCandidate = $null
$filterSerializer = New-Object Web.Script.Serialization.JavaScriptSerializer
$filterSerializer.MaxJsonLength = 2097152

function Get-FilterHash([string]$text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Filter-Json($value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($filterSerializer.Serialize($value))
    return @{ Status = 200; ContentType = 'application/json; charset=utf-8'; Body = $bytes; Note = '' }
}
function Read-FilterState {
    if ([IO.File]::Exists($filterStateFile)) {
        return $filterSerializer.DeserializeObject([Text.Encoding]::UTF8.GetString((Read-SettingsFile $filterStateFile)))
    }
    return @{ revision = 0; active = $null; previous = $null }
}
function Receive-FilterSource([string]$url, [string]$kind, [int]$limit) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $req = [Net.HttpWebRequest]::Create($url)
    $req.AllowAutoRedirect = $false
    $req.Timeout = 15000
    $req.ReadWriteTimeout = 15000
    $req.Method = 'GET'
    $req.Headers['Cache-Control'] = 'no-cache'
    $res = $null
    try {
        $res = $req.GetResponse()
        if ([int]$res.StatusCode -ne 200 -or $res.ContentLength -gt $limit) { throw 'upstream status/size' }
        if ($kind -eq 'module' -and $res.ContentType -notmatch 'javascript|ecmascript|text/plain') { throw 'upstream module type' }
        if ($kind -eq 'gallery' -and $res.ContentType -notmatch 'text/html') { throw 'upstream html type' }
        $stream = $res.GetResponseStream()
        $mem = New-Object IO.MemoryStream
        try {
            $buf = New-Object byte[] 8192
            $deadline = [DateTime]::UtcNow.AddSeconds(20)
            while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
                if ($mem.Length + $n -gt $limit -or [DateTime]::UtcNow -gt $deadline) { throw 'upstream size/time limit' }
                $mem.Write($buf, 0, $n)
            }
            if ($res.ContentLength -ge 0 -and $mem.Length -ne $res.ContentLength) { throw 'upstream truncated' }
            $utf = New-Object Text.UTF8Encoding($false, $true)
            return $utf.GetString($mem.ToArray())
        } finally { $mem.Dispose(); $stream.Dispose() }
    } finally { if ($null -ne $res) { $res.Dispose() } }
}
function Test-FilterNumber($v, [double]$min, [double]$max) {
    return ($v -is [ValueType] -and $v -isnot [bool] -and -not [double]::IsNaN([double]$v) -and -not [double]::IsInfinity([double]$v) -and [double]$v -ge $min -and [double]$v -le $max)
}
function Test-FilterBundle($b) {
    if ($null -eq $b -or $b.schema -ne 1 -or $b.meta.source -cne $filterSourceUrl -or $b.meta.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $b.meta.htmlSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'invalid bundle metadata' }
    $ids = @('state.strength','state.size','state.boil','state.fps','state.grade','state.level','OIL.w.0','OIL.w.1','OIL.w.2','OIL.len','OIL.jit','OIL.bump','OIL.spec','OIL.canvas','OIL.refineT','OIL.eye','OIL.edge','OIL.spill','OIL.slope','OIL.halo','GRADE.keepW','state.style')
    if ($b.controls.Count -ne 22) { throw 'invalid controls' }
    $seen = @{}
    foreach ($c in $b.controls) {
        if ($ids -cnotcontains $c.id -or $seen.ContainsKey($c.id) -or $c.label -isnot [string] -or $c.label.Length -gt 100) { throw 'invalid control' }
        $seen[$c.id] = $true
        if ($c.id -ceq 'state.style') {
            if ($c.kind -cne 'select' -or ($c.options.value -join ',') -cne 'flat,3d' -or @('flat','3d') -cnotcontains $c.default) { throw 'invalid style' }; continue
        }
        if ($c.kind -cne 'number') { throw 'invalid numeric control' }
        foreach ($key in @('min','max','step','default')) { if ($c[$key] -isnot [ValueType] -or $c[$key] -is [bool] -or [double]::IsNaN([double]$c[$key]) -or [double]::IsInfinity([double]$c[$key])) { throw 'invalid number' } }
        if ($c.min -ge $c.max -or $c.min -lt -100 -or $c.max -gt 100 -or $c.step -le 0 -or $c.default -lt $c.min -or $c.default -gt $c.max) { throw 'invalid range' }
    }
    if (-not (Test-FilterNumber $b.flowDefault 0.000000000001 1)) { throw 'invalid flow default' }
    $slots = @('tfmBody','strokeStep','strokeWidth','strokeFns','finishBody','blobFragment','blb')
    if ($b.port.Count -ne $slots.Count) { throw 'invalid slots' }
    foreach ($key in $slots) { if ($b.port[$key] -isnot [string] -or $b.port[$key].Length -gt 30000 -or $b.port[$key] -match '`|\$\{|#extension|#include') { throw 'invalid shader data' } }
    if ($b.preset.layers.Count -ne 3 -or $b.preset.refine.Count -ne 5 -or $b.levels.Count -ne 6) { throw 'invalid mapping' }
    $rowIds = @('state.strength','state.size','OIL.canvas','OIL.jit','CR.nosilw','CR.tfmE')
    $rowsSeen = @{}
    foreach ($r in $b.levels) {
        if (@(4,7) -notcontains $r.Count -or $rowIds -cnotcontains $r[0] -or $rowsSeen.ContainsKey($r[0])) { throw 'invalid level row' }
        $rowsSeen[$r[0]] = $true
        for ($i=1; $i -lt $r.Count; $i++) {
            if ($null -eq $r[$i] -and $i -eq 2) { continue }
            if (-not (Test-FilterNumber $r[$i] 0 100)) { throw 'invalid level value' }
        }
    }
    foreach ($v in $b.preset.refine) { if (-not (Test-FilterNumber $v 0 200)) { throw 'invalid refine value' } }
    foreach ($layer in $b.preset.layers) { if ($layer.Count -ne 6) { throw 'invalid layer' }; foreach ($v in $layer) { if ($v -isnot [ValueType] -or $v -is [bool] -or [double]$v -lt 0 -or [double]$v -gt 200) { throw 'invalid layer value' } } }
}
function Test-FilterSettings($value) {
    if ($null -eq $value -or $value.version -ne 1 -or $value.settings -isnot [Collections.Generic.IDictionary[string,object]] -or $filterSerializer.Serialize($value).Length -gt 16384) { throw 'invalid settings' }
}
function Invoke-FilterApi($request) {
    if ($filterRoutes -cnotcontains $request.RawUrl) { return New-ApiResult 404 'unknown filter api' }
    if ($request.RawUrl -ceq '/local-api/filter-state' -and $request.HttpMethod -ceq 'GET') { return Filter-Json (Read-FilterState) }
    $method = if ($request.RawUrl -ceq '/local-api/filter-candidate' -or $request.RawUrl -ceq '/local-api/filter-state') { 'PUT' } else { 'POST' }
    if ($request.HttpMethod -cne $method) { return New-ApiResult 405 'method not allowed' }
    $bad = Test-SettingsWrite $request
    if ($null -ne $bad) { return $bad }
    $limit = if ($request.RawUrl -ceq '/local-api/filter-candidate') { 131072 } else { 32768 }
    $bytes = Read-LimitedBody $request $limit
    if ($null -eq $bytes) { return New-ApiResult 413 'filter body too large' }
    $bad = Test-JsonObject $bytes
    if ($null -ne $bad) { return New-ApiResult 400 $bad }
    try { $data = $filterSerializer.DeserializeObject([Text.Encoding]::UTF8.GetString($bytes)) }
    catch { return New-ApiResult 400 'invalid json' }
    if ($request.RawUrl -ceq '/local-api/filter-check') {
        if ($data.Count -ne 0) { return New-ApiResult 400 'check accepts no urls or data' }
        $script:filterCandidate = $null
        try {
            $module = Receive-FilterSource $filterSourceUrl 'module' 500000
            $gallery = Receive-FilterSource $filterGalleryUrl 'gallery' 800000
            $script:filterSource = @{ module = $module; gallery = $gallery }
            return Filter-Json $script:filterSource
        } catch { $script:filterSource = $null; return New-ApiResult 502 'upstream unavailable or invalid; active filter unchanged' }
    }
    if ($request.RawUrl -ceq '/local-api/filter-candidate') {
        try {
            Test-FilterBundle $data
            if ($null -eq $script:filterSource -or $data.meta.sha256 -cne (Get-FilterHash $script:filterSource.module) -or $data.meta.htmlSha256 -cne (Get-FilterHash $script:filterSource.gallery)) { throw 'source mismatch; check again' }
            $builtin = $filterSerializer.DeserializeObject([IO.File]::ReadAllText((Join-Path $webRoot 'config\filter-builtin.json')))
            if ($data.fingerprint -cne $builtin.fingerprint) { throw 'unsupported engine fingerprint' }
            # Only literal GLSL present in the downloaded source can enter a candidate.
            $source = $script:filterSource.module -replace '\s*&&\s*uMedium == 1\b','' -replace '\buMedium == 1\s*&&\s*',''
            foreach ($s in $data.port.Values) { if (-not $source.Contains($s)) { throw 'shader source mismatch' } }
            $script:filterCandidate = $data
            return Filter-Json @{ id = ($data.meta.sha256 + ':' + $data.meta.htmlSha256) }
        } catch { return New-ApiResult 400 $_.Exception.Message }
    }
    try {
        $state = Read-FilterState
        if ($data.revision -ne $state.revision) { return New-ApiResult 409 'revision changed; reload' }
        if ($request.RawUrl -ceq '/local-api/filter-state') {
            Test-FilterSettings $data.settings
            if ($null -eq $state.active) { throw 'no active bundle' }
            $state.active.settings = $data.settings
        } elseif ($request.RawUrl -ceq '/local-api/filter-apply') {
            Test-FilterSettings $data.settings
            Test-FilterSettings $data.before
            if ($null -eq $script:filterCandidate -or $data.id -cne ($script:filterCandidate.meta.sha256 + ':' + $script:filterCandidate.meta.htmlSha256)) { throw 'no matching candidate' }
            $state.previous = if ($null -ne $state.active) { $state.active } else { @{ bundle = $null; settings = $data.before } }
            $state.active = @{ bundle = $script:filterCandidate; settings = $data.settings }
        } else {
            if ($null -eq $state.previous) { throw 'no previous version' }
            $old = $state.active
            $state.active = $state.previous
            $state.previous = $old
        }
        $state.revision = [int]$state.revision + 1
        # One atomic document includes engine, definitions, user values, and previous version.
        Write-SettingsFile $filterStateFile ([Text.Encoding]::UTF8.GetBytes($filterSerializer.Serialize($state)))
        return Filter-Json $state
    } catch { return New-ApiResult 400 $_.Exception.Message }
}
