# Manual filter updates. ASCII only; no Node runtime, no downloaded script execution.
$filterStateFile = Join-Path $settingsDir 'filter.local.json'
$filterSourceUrl = 'https://nau-filter-gallery.vercel.app/nau-filter/nau-filter.js'
$filterGalleryUrl = 'https://nau-filter-gallery.vercel.app/'
$filterRoutes = @('/local-api/filter-state', '/local-api/filter-check', '/local-api/filter-candidate', '/local-api/filter-apply', '/local-api/filter-rollback')
$filterSource = $null
$filterCandidate = $null
$filterExpected = $null
$filterParserPath = Join-Path $PSScriptRoot 'filter-source.cs'
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
function Initialize-FilterParser {
    if (-not ('FilterSourceParser' -as [type])) { Add-Type -Path $filterParserPath -ReferencedAssemblies 'System.Web.Extensions','System.Core' }
}
function Test-FilterBundle($b) {
    Initialize-FilterParser
    [FilterSourceParser]::Validate($filterSerializer.Serialize($b))
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
        $script:filterExpected = $null
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
            if ($null -eq $script:filterExpected) {
                Initialize-FilterParser
                $baselineJson = [IO.File]::ReadAllText((Join-Path $webRoot 'config\filter-builtin.json'))
                $expectedJson = [FilterSourceParser]::Extract($script:filterSource.module, $script:filterSource.gallery, $baselineJson)
                $expected = $filterSerializer.DeserializeObject($expectedJson)
                Test-FilterBundle $expected
                $script:filterExpected = $expected
            }
            # Compare every property, type, array position, number and shader byte.
            # Persist only the server-derived object, never the submitted candidate.
            if (-not [FilterSourceParser]::Equal($data, $script:filterExpected)) { throw 'candidate differs from independently parsed source' }
            $script:filterCandidate = $script:filterExpected
            return Filter-Json @{ id = ($data.meta.sha256 + ':' + $data.meta.htmlSha256) }
        } catch { return New-ApiResult 400 $_.Exception.Message }
    }
    try {
        $state = Read-FilterState
        if ($data.revision -ne $state.revision) { return New-ApiResult 409 'revision changed; reload' }
        if ($request.RawUrl -ceq '/local-api/filter-state') {
            Test-FilterSettings $data.settings
            if ($null -eq $state.active) { throw 'no active bundle' }
            if ($null -ne $state.active.bundle) { Test-FilterBundle $state.active.bundle }
            $state.active.settings = $data.settings
        } elseif ($request.RawUrl -ceq '/local-api/filter-apply') {
            Test-FilterSettings $data.settings
            Test-FilterSettings $data.before
            if ($null -eq $script:filterCandidate -or $data.id -cne ($script:filterCandidate.meta.sha256 + ':' + $script:filterCandidate.meta.htmlSha256)) { throw 'no matching candidate' }
            Test-FilterBundle $script:filterCandidate
            $state.previous = if ($null -ne $state.active) { $state.active } else { @{ bundle = $null; settings = $data.before } }
            $state.active = @{ bundle = $script:filterCandidate; settings = $data.settings }
        } else {
            if ($null -eq $state.previous) { throw 'no previous version' }
            if ($null -ne $state.previous.bundle) { Test-FilterBundle $state.previous.bundle }
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
