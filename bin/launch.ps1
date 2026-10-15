[CmdletBinding()]
param(
    # Alternative settings file (testing). Default: settings.ini in the project root.
    [string]$SettingsPath
)

# Site launcher: OBS (virtual camera) -> local server -> Chrome kiosk.
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$ServerReadyTimeoutSeconds = 15
$ObsStartCheckSeconds = 3
$LogKeep = 20

# OBS 32.x flags, checked against obs64.exe 32.2.1 --help text:
#   --startvirtualcam              start the virtual camera on launch
#   --minimize-to-tray             keep the OBS window out of the kiosk screen
#   --disable-updater              no update dialog over the kiosk
#   --disable-missing-files-check  no "missing files" dialog over the kiosk
# OBS 32 has no --disable-shutdown-check; see Clear-ObsCrashMarkers.
$ObsArguments = @('--startvirtualcam', '--minimize-to-tray', '--disable-updater', '--disable-missing-files-check')

# OBS 32 writes %APPDATA%\obs-studio\.sentinel\run_<id> while running and
# removes it on a clean exit. A leftover marker makes the next start show the
# "OBS Studio Crash Detected / Run in Safe Mode?" dialog, which would stop the
# virtual camera from starting. Call only when no obs64 process is running.
function Clear-ObsCrashMarkers {
    $dir = Join-Path $env:APPDATA 'obs-studio\.sentinel'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return 0 }
    $markers = @(Get-ChildItem -LiteralPath $dir -File -Force -Filter 'run_*')
    foreach ($marker in $markers) {
        Remove-Item -LiteralPath $marker.FullName -Force
    }
    return $markers.Count
}

function Start-Obs([hashtable]$Settings) {
    $running = @(Get-Process -Name 'obs64' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        Write-Log "OBS is already running (PID $(($running | ForEach-Object { $_.Id }) -join ', ')); left untouched."
        return
    }
    if (-not (Get-SettingBool $Settings 'obs_autostart' $true)) {
        Write-Log 'OBS is not running and obs_autostart=false; not starting it. The page waits for a camera.' 'WARN'
        return
    }

    $obsPath = Resolve-ObsPath $Settings
    $version = (Get-Item -LiteralPath $obsPath).VersionInfo.FileVersion
    Write-Log "OBS $version found: $obsPath"
    if ($version -notmatch '^32\.') {
        Write-Log "Launch flags and crash-dialog handling were checked on OBS 32.x only (this is $version)." 'WARN'
    }

    $cleared = Clear-ObsCrashMarkers
    if ($cleared -gt 0) {
        Write-Log "Removed $cleared leftover OBS crash marker(s) from an unclean exit."
    }

    Write-Log "Starting OBS: $($ObsArguments -join ' ')"
    $process = Start-Process -FilePath $obsPath -ArgumentList $ObsArguments `
        -WorkingDirectory (Split-Path $obsPath -Parent) -PassThru
    Start-Sleep -Seconds $ObsStartCheckSeconds
    if ($process.HasExited) {
        throw "OBS exited right after start (exit code $($process.ExitCode))."
    }
    Write-Log "OBS started (PID $($process.Id))."
}

# Returns the HTTP status code, or 0 when nothing answered.
function Get-HttpStatus([string]$Url) {
    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create($Url)
        $request.Proxy = $null
        $request.Timeout = 2000
        $response = $request.GetResponse()
        return [int]$response.StatusCode
    }
    catch {
        $ex = $_.Exception
        while ($ex -and -not ($ex -is [Net.WebException])) { $ex = $ex.InnerException }
        if ($ex -and $ex.Response) {
            $response = $ex.Response
            return [int]$response.StatusCode
        }
        return 0
    }
    finally {
        if ($response) { $response.Close() }
    }
}

function Start-Server([int]$Port) {
    if (-not (Test-Path -LiteralPath $ServerScript -PathType Leaf)) {
        throw "Server script was not found: $ServerScript"
    }

    $previous = @(Get-ServerProcessIds)
    if ($previous.Count -gt 0) {
        Write-Log "Stopping previous server process(es): PID $($previous -join ', ')"
        [void](Stop-ProcessIds $previous 0)
    }

    $url = "http://localhost:$Port/"
    $status = Get-HttpStatus $url
    if ($status -ne 0) {
        throw "Port $Port is already used by another program (HTTP $status at $url). Change server_port or close that program."
    }

    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
    $logDir = Join-Path $ProjectRoot 'logs'
    $outLog = Join-Path $logDir "server_$stamp.out.log"
    $errLog = Join-Path $logDir "server_$stamp.err.log"
    # Two files (out, err) per run; keep the newest $LogKeep runs.
    Remove-OldLogs -Pattern 'server_*.log' -Keep (($LogKeep - 1) * 2)

    $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}" -Port {1}' -f $ServerScript, $Port
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Write-Log "Server started hidden (PID $($process.Id)); output: $outLog"

    $deadline = [DateTime]::UtcNow.AddSeconds($ServerReadyTimeoutSeconds)
    while ($true) {
        if ($process.HasExited) {
            $detail = ''
            if (Test-Path -LiteralPath $errLog) { $detail = ((Get-Content -LiteralPath $errLog -Tail 5) -join ' ').Trim() }
            throw "Server exited (exit code $($process.ExitCode)). $detail"
        }
        $status = Get-HttpStatus $url
        if ($status -eq 200) { break }
        if ([DateTime]::UtcNow -gt $deadline) {
            throw "Server did not answer GET $url with 200 within $ServerReadyTimeoutSeconds s (last status $status)."
        }
        Start-Sleep -Milliseconds 300
    }
    Write-Log "Server ready: GET $url -> 200"
    return $url
}

# True when the text is a JSON object whose hardware_acceleration_mode.enabled is true.
function Test-HardwareAccelerationJson([string]$Text) {
    try {
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
        $serializer.MaxJsonLength = [int]::MaxValue
        $value = $serializer.DeserializeObject($Text)
    }
    catch {
        return $false
    }
    if (-not ($value -is [Collections.Generic.IDictionary[string, object]])) { return $false }
    if (-not $value.ContainsKey('hardware_acceleration_mode')) { return $false }
    $mode = $value['hardware_acceleration_mode']
    if (-not ($mode -is [Collections.Generic.IDictionary[string, object]])) { return $false }
    return ($mode.ContainsKey('enabled') -and $mode['enabled'] -eq $true)
}

# Chrome keeps "hardware_acceleration_mode.enabled" in Local State when the
# user turns it off in settings. The detector needs WebGL, so turn it back on.
# Only that value changes. The new text goes to a temp file in the same folder,
# is checked (valid JSON, value now true), then replaces the file atomically.
# On any problem the original file stays as it was and only a warning is logged.
function Enable-HardwareAcceleration([string]$ProfileDir) {
    $path = Join-Path $ProfileDir 'Local State'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
    $pattern = '("hardware_acceleration_mode"\s*:\s*\{\s*"enabled"\s*:\s*)false'
    $text = [IO.File]::ReadAllText($path)
    if ($text -notmatch $pattern) { return }
    $fixed = [Regex]::Replace($text, $pattern, '${1}true')
    $temp = Join-Path $ProfileDir ('Local State.{0}.tmp' -f [Guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($temp, $fixed, (New-Object Text.UTF8Encoding($false)))
        if (-not (Test-HardwareAccelerationJson ([IO.File]::ReadAllText($temp)))) {
            Write-Log 'Hardware acceleration is off in the kiosk profile, but Local State could not be fixed safely (not valid JSON); left it unchanged.' 'WARN'
            return
        }
        # [NullString]::Value: PowerShell would pass $null to a string parameter as "" (invalid backup path).
        [IO.File]::Replace($temp, $path, [NullString]::Value)
        Write-Log 'Hardware acceleration was off in the kiosk profile; turned it back on.' 'WARN'
    }
    catch {
        Write-Log "Hardware acceleration is off in the kiosk profile, but Local State could not be updated ($($_.Exception.Message)); left it unchanged." 'WARN'
    }
    finally {
        if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
    }
}

function Start-Chrome([hashtable]$Settings, [string]$Url) {
    $chromePath = Resolve-ChromePath $Settings
    $profileDir = Get-ChromeProfileDir $Settings
    $kiosk = Get-SettingBool $Settings 'kiosk' $true
    $position = Get-SettingPair $Settings 'window_position' ([int]::MinValue)
    $size = Get-SettingPair $Settings 'window_size' 1
    $version = (Get-Item -LiteralPath $chromePath).VersionInfo.FileVersion
    Write-Log "Chrome $version found: $chromePath"

    # A second start with the same profile would only open another window in
    # the running instance, so restart it instead.
    $existing = @(Get-ProfileChromeIds $profileDir)
    if ($existing.Count -gt 0) {
        Write-Log "Closing the kiosk Chrome that is already running ($($existing.Count) process(es))."
        $forced = Stop-ProcessIds $existing 5000
        Write-Log "Kiosk Chrome closed (forced $forced)."
    }

    [void][IO.Directory]::CreateDirectory($profileDir)
    Enable-HardwareAcceleration $profileDir

    # Minimal flags; reasons are in docs/SYSTEM.md "Chrome flags".
    $arguments = @(
        ('--user-data-dir="{0}"' -f $profileDir),
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--disable-features=Translate',
        '--disable-pinch',
        '--overscroll-history-navigation=0'
    )
    if ($position) { $arguments += ('--window-position={0},{1}' -f $position[0], $position[1]) }
    if ($kiosk) {
        $arguments += @('--kiosk', $Url)
    }
    else {
        if ($size) { $arguments += ('--window-size={0},{1}' -f $size[0], $size[1]) }
        $arguments += "--app=$Url"
    }

    Write-Log "Starting Chrome: $($arguments -join ' ')"
    Start-Process -FilePath $chromePath -ArgumentList $arguments | Out-Null

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (@(Get-ProfileChromeIds $profileDir).Count -eq 0) {
        if ([DateTime]::UtcNow -gt $deadline) {
            throw "Chrome did not start with profile $profileDir within 10 s."
        }
        Start-Sleep -Milliseconds 300
    }
    Write-Log "Chrome started (profile $profileDir, kiosk=$kiosk)."
}

Start-LogFile -Prefix 'launch' -Keep $LogKeep
$exitCode = 0
$step = 'start'
$mutex = $null
$ownsMutex = $false
try {
    $step = 'single instance'
    $mutex = New-Object Threading.Mutex($false, 'Local\ShinsegaePhotoboothLaunch')
    try { $ownsMutex = $mutex.WaitOne(0, $false) }
    catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
    if (-not $ownsMutex) {
        throw 'Another launcher is already running.'
    }

    $step = 'settings'
    if ($SettingsPath) {
        $SettingsPath = [IO.Path]::GetFullPath($SettingsPath)
        if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
            throw "Settings file was not found: $SettingsPath"
        }
    }
    else {
        $SettingsPath = Join-Path $ProjectRoot 'settings.ini'
        Initialize-SettingsFile $SettingsPath (Join-Path $ProjectRoot 'settings.example.ini')
    }
    $settings = Read-Settings $SettingsPath
    $port = Get-SettingPort $settings
    Write-Log "Settings: $SettingsPath (server_port=$port)"

    $step = 'obs'
    Start-Obs $settings

    $step = 'server'
    $url = Start-Server $port

    $step = 'chrome'
    Start-Chrome $settings $url

    Write-Log 'Launch completed.'
}
catch {
    Write-Log "Launch failed at step '$step': $($_.Exception.Message)" 'ERROR'
    $exitCode = 1
}
finally {
    if ($mutex) {
        if ($ownsMutex) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
exit $exitCode
