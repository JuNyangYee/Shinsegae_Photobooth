[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8765
)

# Local static server (Windows PowerShell 5.1).
# Keep this file ASCII-only: PS 5.1 misreads UTF-8 without BOM.
#   /        -> src/web/index.html
#   /lib/*   -> lib/ (404 when the folder does not exist)
#   /local-api/presence-settings  GET/PUT operator presence settings (config/presence.local.json)
#   /*       -> src/web/

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$webRoot = Join-Path $projectRoot 'src\web'
$libRoot = Join-Path $projectRoot 'lib'

# Operator presence settings (task 4-3). One fixed file; clients never choose a file name or path.
$settingsApiPath = '/local-api/presence-settings'
$settingsDir = Join-Path $projectRoot 'config'
$settingsFile = Join-Path $settingsDir 'presence.local.json'
$maxSettingsBytes = 16384
$expectedHost = "localhost:$Port"
$expectedOrigin = "http://localhost:$Port"
Add-Type -AssemblyName System.Web.Extensions

if (-not (Test-Path -LiteralPath $webRoot -PathType Container)) {
    throw "Web root was not found: $webRoot"
}

$mimeTypes = @{
    '.html'  = 'text/html; charset=utf-8'
    '.js'    = 'text/javascript; charset=utf-8'
    '.mjs'   = 'text/javascript; charset=utf-8'
    '.css'   = 'text/css; charset=utf-8'
    '.json'  = 'application/json; charset=utf-8'
    '.svg'   = 'image/svg+xml'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.jpeg'  = 'image/jpeg'
    '.webp'  = 'image/webp'
    '.woff2' = 'font/woff2'
    '.wasm'  = 'application/wasm'
    '.tflite' = 'application/octet-stream'
    '.task'  = 'application/octet-stream'
}

# Returns @{ Status = <int>; File = <full path or $null> }.
function Resolve-RequestFile([string]$rawUrl) {
    $pathPart = $rawUrl.Split('?')[0]
    $decoded = [Uri]::UnescapeDataString($pathPart)

    # Reject anything that could escape the root or confuse Windows paths:
    # backslashes, drive/stream colons, wildcard chars, control chars,
    # and segments that are or end with dots/spaces (".", "..", "... ").
    if (-not $decoded.StartsWith('/') -or $decoded -match '[\\:*?"<>|\x00-\x1f\x7f]') {
        return @{ Status = 400; File = $null }
    }
    foreach ($segment in $decoded.Split('/')) {
        if ($segment.StartsWith('.') -or $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
            return @{ Status = 400; File = $null }
        }
    }

    if ($decoded -eq '/') {
        $root = $webRoot
        $relative = 'index.html'
    }
    elseif ($decoded -eq '/lib' -or $decoded.StartsWith('/lib/')) {
        $root = $libRoot
        $relative = $decoded.Substring(4).TrimStart('/')
    }
    else {
        $root = $webRoot
        $relative = $decoded.TrimStart('/')
    }

    if ($relative.Length -eq 0) {
        return @{ Status = 404; File = $null }
    }

    # Final guard: the resolved path must stay inside the chosen root.
    $file = [IO.Path]::GetFullPath((Join-Path $root ($relative -replace '/', '\')))
    $rootPrefix = $root.TrimEnd('\') + '\'
    if (-not $file.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        return @{ Status = 403; File = $null }
    }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        return @{ Status = 404; File = $null }
    }
    return @{ Status = 200; File = $file }
}

# The "localhost" prefix only matches the Host header; http.sys still accepts
# connections on every local address. Serve only clients on this machine.
function Test-LoopbackRequest($request) {
    $endPoint = $request.RemoteEndPoint
    if ($null -eq $endPoint) {
        return $false
    }
    $address = $endPoint.Address
    if ($address.IsIPv4MappedToIPv6) {
        $address = $address.MapToIPv4()
    }
    return [Net.IPAddress]::IsLoopback($address)
}

function New-ApiResult([int]$status, [string]$note) {
    return @{ Status = $status; ContentType = 'text/plain; charset=utf-8'; Body = [byte[]]@(); Note = $note }
}

# Writes from this page only. Loopback alone does not stop another web page on this PC
# from sending requests to localhost (CSRF), so a PUT must look like our own same-origin fetch:
# custom header + JSON content type force a CORS preflight for other origins, and we never
# answer a preflight with CORS headers. Host/Origin/Sec-Fetch-Site are checked as well.
# Returns $null when allowed, otherwise an API result.
function Test-SettingsWrite($request) {
    if ($request.Headers['Host'] -ne $expectedHost) {
        return New-ApiResult 403 'host not allowed'
    }
    if ($request.Headers['X-Photobooth'] -ne '1') {
        return New-ApiResult 403 'missing X-Photobooth header'
    }
    $origin = $request.Headers['Origin']
    if ($null -ne $origin -and $origin -ne $expectedOrigin) {
        return New-ApiResult 403 'origin not allowed'
    }
    $site = $request.Headers['Sec-Fetch-Site']
    if ($null -ne $site -and $site -ne 'same-origin') {
        return New-ApiResult 403 'cross-site request'
    }
    $type = $request.ContentType
    if ($null -eq $type) {
        return New-ApiResult 415 'content type must be application/json'
    }
    $parts = $type.Split(';')
    if ($parts[0].Trim() -ne 'application/json') {
        return New-ApiResult 415 'content type must be application/json'
    }
    for ($i = 1; $i -lt $parts.Length; $i++) {
        $pair = $parts[$i].Split('=')
        if ($pair[0].Trim() -eq 'charset' -and $pair.Length -gt 1 -and $pair[1].Trim().Trim('"') -ne 'utf-8') {
            return New-ApiResult 415 'charset must be utf-8'
        }
    }
    return $null
}

# Reads at most $limit bytes. Returns $null when the body is larger (also for chunked bodies).
function Read-LimitedBody($request, [int]$limit) {
    if ($request.ContentLength64 -gt $limit) {
        return $null
    }
    $stream = $request.InputStream
    $buffer = New-Object byte[] ($limit + 1)
    $total = 0
    while ($total -le $limit) {
        $read = $stream.Read($buffer, $total, $buffer.Length - $total)
        if ($read -le 0) { break }
        $total += $read
    }
    if ($total -gt $limit) {
        return $null
    }
    $body = New-Object byte[] $total
    [Array]::Copy($buffer, $body, $total)
    return ,$body
}

# Only checks that the body is a UTF-8 JSON object. The page normalizes the values
# (presence-settings.js), so any stored content still loads safely.
function Test-JsonObject([byte[]]$bytes) {
    $strict = New-Object Text.UTF8Encoding($false, $true)
    try {
        $text = $strict.GetString($bytes)
    }
    catch {
        return 'body is not valid UTF-8'
    }
    $serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
    try {
        $value = $serializer.DeserializeObject($text)
    }
    catch {
        return 'body is not valid JSON'
    }
    if (-not ($value -is [Collections.Generic.IDictionary[string, object]])) {
        return 'JSON must be an object'
    }
    return $null
}

# File.Replace / Move can fail briefly while another request or process holds the file.
function Invoke-WithRetry([scriptblock]$action) {
    for ($attempt = 1; ; $attempt++) {
        try {
            & $action
            return
        }
        catch [IO.IOException], [UnauthorizedAccessException] {
            if ($attempt -ge 5) { throw }
            Start-Sleep -Milliseconds 50
        }
    }
}

# Atomic write: write a temp file in the same folder, flush it to disk, then replace the target.
# Readers always see either the old or the new complete file.
function Write-SettingsFile([byte[]]$bytes) {
    [void][IO.Directory]::CreateDirectory($settingsDir)
    $temp = Join-Path $settingsDir ('presence.local.json.{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
    try {
        $stream = New-Object IO.FileStream($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        }
        finally {
            $stream.Dispose()
        }
        Invoke-WithRetry {
            if ([IO.File]::Exists($settingsFile)) {
                # [NullString]::Value: PowerShell would pass $null to a string parameter as "" (invalid backup path).
                [IO.File]::Replace($temp, $settingsFile, [NullString]::Value)
            }
            else {
                [IO.File]::Move($temp, $settingsFile)
            }
        }
    }
    finally {
        if ([IO.File]::Exists($temp)) {
            [IO.File]::Delete($temp)
        }
    }
}

function Read-SettingsFile {
    for ($attempt = 1; ; $attempt++) {
        try {
            return ,[IO.File]::ReadAllBytes($settingsFile)
        }
        catch [IO.IOException], [UnauthorizedAccessException] {
            if ($attempt -ge 5) { throw }
            Start-Sleep -Milliseconds 50
        }
    }
}

function Invoke-SettingsApi($request) {
    # Exact path only: no query, no other names, no encoded variants.
    if (-not ($request.RawUrl -ceq $settingsApiPath)) {
        return New-ApiResult 404 'unknown local api'
    }
    if ($request.HttpMethod -eq 'GET') {
        if (-not [IO.File]::Exists($settingsFile)) {
            return New-ApiResult 404 'no settings file'
        }
        $bytes = Read-SettingsFile
        return @{ Status = 200; ContentType = 'application/json; charset=utf-8'; Body = $bytes; Note = '' }
    }
    if ($request.HttpMethod -ne 'PUT') {
        # Includes OPTIONS: a preflight gets no CORS headers, so other origins cannot send the PUT.
        $result = New-ApiResult 405 'method not allowed'
        $result.Allow = 'GET, PUT'
        return $result
    }
    $rejected = Test-SettingsWrite $request
    if ($null -ne $rejected) {
        return $rejected
    }
    $bytes = Read-LimitedBody $request $maxSettingsBytes
    if ($null -eq $bytes) {
        return New-ApiResult 413 "body larger than $maxSettingsBytes bytes"
    }
    $problem = Test-JsonObject $bytes
    if ($null -ne $problem) {
        return New-ApiResult 400 $problem
    }
    Write-SettingsFile $bytes
    return New-ApiResult 204 "saved $($bytes.Length) bytes"
}

function Send-Response($context) {
    $request = $context.Request
    $response = $context.Response
    $status = 200
    $contentType = 'text/plain; charset=utf-8'
    $body = [byte[]]@()
    $note = ''

    if (-not (Test-LoopbackRequest $request)) {
        $status = 403
    }
    elseif ($request.RawUrl.StartsWith('/local-api', [StringComparison]::OrdinalIgnoreCase)) {
        $result = Invoke-SettingsApi $request
        $status = $result.Status
        $contentType = $result.ContentType
        $body = $result.Body
        $note = $result.Note
        if ($result.ContainsKey('Allow')) {
            $response.Headers['Allow'] = $result.Allow
        }
    }
    elseif ($request.HttpMethod -ne 'GET' -and $request.HttpMethod -ne 'HEAD') {
        $status = 405
        $response.Headers['Allow'] = 'GET, HEAD'
    }
    else {
        $resolved = Resolve-RequestFile $request.RawUrl
        $status = $resolved.Status
        if ($status -eq 200) {
            $extension = [IO.Path]::GetExtension($resolved.File).ToLowerInvariant()
            $contentType = 'application/octet-stream'
            if ($mimeTypes.ContainsKey($extension)) {
                $contentType = $mimeTypes[$extension]
            }
            $body = [IO.File]::ReadAllBytes($resolved.File)
        }
    }

    if ($status -ne 200 -and $status -ne 204) {
        $text = "$status`n"
        if ($note) {
            $text = "$status $note`n"
        }
        $body = [Text.Encoding]::ASCII.GetBytes($text)
    }

    $response.StatusCode = $status
    $response.ContentType = $contentType
    $response.Headers['Cache-Control'] = 'no-store'
    $response.Headers['X-Content-Type-Options'] = 'nosniff'
    $response.ContentLength64 = $body.LongLength
    if ($request.HttpMethod -ne 'HEAD' -and $body.Length -gt 0) {
        $response.OutputStream.Write($body, 0, $body.Length)
    }
    $suffix = ''
    if ($note) {
        $suffix = " ($note)"
    }
    Write-Host ("{0} {1} -> {2}{3}" -f $request.HttpMethod, $request.RawUrl, $status, $suffix)
}

$url = "http://localhost:$Port/"
$listener = New-Object Net.HttpListener
$listener.Prefixes.Add($url)

try {
    $listener.Start()
    Write-Host "Serving $webRoot"
    Write-Host "Open $url  (Ctrl+C to stop)"

    while ($listener.IsListening) {
        # Wait in short slices so Ctrl+C can interrupt between them.
        $pending = $listener.GetContextAsync()
        while (-not $pending.Wait(250)) { }
        $context = $pending.Result

        try {
            Send-Response $context
        }
        catch {
            [Console]::Error.WriteLine("Request failed: $($_.Exception.Message)")
            try { $context.Response.StatusCode = 500 } catch { }
        }
        finally {
            try { $context.Response.Close() } catch { }
        }
    }
}
finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
    $listener.Close()
    Write-Host 'Server stopped.'
}
