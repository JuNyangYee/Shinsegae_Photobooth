[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8765
)

# Development static server (Windows PowerShell 5.1).
# Keep this file ASCII-only: PS 5.1 misreads UTF-8 without BOM.
#   /        -> src/web/index.html
#   /lib/*   -> lib/ (404 when the folder does not exist)
#   /*       -> src/web/

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$webRoot = Join-Path $projectRoot 'src\web'
$libRoot = Join-Path $projectRoot 'lib'

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

function Send-Response($context) {
    $request = $context.Request
    $response = $context.Response
    $status = 200
    $contentType = 'text/plain; charset=utf-8'
    $body = [byte[]]@()

    if (-not (Test-LoopbackRequest $request)) {
        $status = 403
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

    if ($status -ne 200) {
        $body = [Text.Encoding]::ASCII.GetBytes("$status`n")
    }

    $response.StatusCode = $status
    $response.ContentType = $contentType
    $response.Headers['Cache-Control'] = 'no-store'
    $response.Headers['X-Content-Type-Options'] = 'nosniff'
    $response.ContentLength64 = $body.LongLength
    if ($request.HttpMethod -ne 'HEAD' -and $body.Length -gt 0) {
        $response.OutputStream.Write($body, 0, $body.Length)
    }
    Write-Host ("{0} {1} -> {2}" -f $request.HttpMethod, $request.RawUrl, $status)
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
