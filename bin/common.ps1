# Shared helpers for launch.ps1, shutdown.ps1 and setup-startup.ps1.
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.
# Dot-source it; it defines functions and $ProjectRoot only.

Set-StrictMode -Version Latest

$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ServerScript = Join-Path $ProjectRoot 'bin\server\serve.ps1'
$script:LogPath = $null

# ---------------------------------------------------------------- logging

# Keeps the newest $Keep log files of this kind, counting the new one.
function Start-LogFile([string]$Prefix, [int]$Keep = 20) {
    $logDir = Join-Path $ProjectRoot 'logs'
    try {
        [void][IO.Directory]::CreateDirectory($logDir)
        Remove-OldLogs -Pattern "${Prefix}_*.log" -Keep ($Keep - 1)
        $script:LogPath = Join-Path $logDir ('{0}_{1}.log' -f $Prefix, (Get-Date -Format 'yyyyMMdd_HHmmss_fff'))
    }
    catch {
        # Logging must never block the launch itself.
        $script:LogPath = $null
        Write-Host "Log file could not be created: $($_.Exception.Message)"
    }
}

function Remove-OldLogs([string]$Pattern, [int]$Keep) {
    $logDir = Join-Path $ProjectRoot 'logs'
    $old = @(Get-ChildItem -LiteralPath $logDir -Filter $Pattern -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -Skip $Keep)
    foreach ($file in $old) {
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
}

function Write-Log([string]$Message, [string]$Level = 'INFO') {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
    if ($Level -eq 'ERROR') { [Console]::Error.WriteLine($line) } else { Write-Host $line }
    if ($script:LogPath) {
        try { Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 } catch { }
    }
}

# ---------------------------------------------------------------- settings

$KeyLinePattern = '^\s*([A-Za-z0-9_]+)\s*=(.*)$'

# Creates settings.ini from the example, or appends keys missing from an
# existing file. Existing values are never overwritten.
function Initialize-SettingsFile([string]$SettingsPath, [string]$ExamplePath) {
    if (-not (Test-Path -LiteralPath $ExamplePath -PathType Leaf)) {
        throw "Settings example was not found: $ExamplePath"
    }
    if (-not (Test-Path -LiteralPath $SettingsPath)) {
        [IO.File]::Copy($ExamplePath, $SettingsPath, $false)
        Write-Log "Created $SettingsPath from the example."
        return
    }
    if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
        throw "Settings path is not a file: $SettingsPath"
    }

    $present = @{}
    foreach ($line in [IO.File]::ReadAllLines($SettingsPath)) {
        if ($line -match $KeyLinePattern) { $present[$Matches[1].ToLowerInvariant()] = $true }
    }
    $missing = New-Object Collections.Generic.List[string]
    foreach ($line in [IO.File]::ReadAllLines($ExamplePath)) {
        if ($line -match $KeyLinePattern -and -not $present.ContainsKey($Matches[1].ToLowerInvariant())) {
            $missing.Add($line.Trim())
        }
    }
    if ($missing.Count -eq 0) { return }

    $text = [IO.File]::ReadAllText($SettingsPath)
    $append = ''
    if ($text.Length -gt 0 -and -not $text.EndsWith("`n")) { $append = "`r`n" }
    $append += ($missing -join "`r`n") + "`r`n"
    [IO.File]::AppendAllText($SettingsPath, $append)
    Write-Log "Added missing settings keys: $(($missing | ForEach-Object { ($_ -split '=', 2)[0] }) -join ', ')"
}

function Read-Settings([string]$Path) {
    $settings = @{}
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match $KeyLinePattern) {
            $settings[$Matches[1].ToLowerInvariant()] = $Matches[2].Trim()
        }
    }
    return $settings
}

function Get-SettingText([hashtable]$Settings, [string]$Key) {
    if ($Settings.ContainsKey($Key)) { return [string]$Settings[$Key] }
    return ''
}

function Get-SettingBool([hashtable]$Settings, [string]$Key, [bool]$Default) {
    $text = Get-SettingText $Settings $Key
    if ($text -eq '') { return $Default }
    [bool]$value = $false
    if (-not [bool]::TryParse($text, [ref]$value)) {
        throw "Setting '$Key' must be true or false (got '$text')."
    }
    return $value
}

function Get-SettingPort([hashtable]$Settings) {
    [int]$port = 0
    $text = Get-SettingText $Settings 'server_port'
    if (-not [int]::TryParse($text, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "Setting 'server_port' must be an integer between 1 and 65535 (got '$text')."
    }
    return $port
}

# Returns $null for an empty value, otherwise @(a, b) for "a,b".
function Get-SettingPair([hashtable]$Settings, [string]$Key, [int]$Min) {
    $text = Get-SettingText $Settings $Key
    if ($text -eq '') { return $null }
    $parts = $text -split ','
    [int]$a = 0
    [int]$b = 0
    if ($parts.Count -ne 2 -or
        -not [int]::TryParse($parts[0].Trim(), [ref]$a) -or
        -not [int]::TryParse($parts[1].Trim(), [ref]$b) -or
        $a -lt $Min -or $b -lt $Min) {
        throw "Setting '$Key' must look like '<number>,<number>' (got '$text')."
    }
    return @($a, $b)
}

# Expands %VAR% and returns a full path, or '' for an empty value.
function Get-SettingPath([hashtable]$Settings, [string]$Key) {
    $text = (Get-SettingText $Settings $Key).Trim('"')
    if ($text -eq '') { return '' }
    $expanded = [Environment]::ExpandEnvironmentVariables($text)
    if ($expanded -notmatch '^(?:[A-Za-z]:\\|\\\\)') {
        throw "Setting '$Key' must be an absolute path (got '$text')."
    }
    return [IO.Path]::GetFullPath($expanded)
}

function Get-ChromeProfileDir([hashtable]$Settings) {
    $dir = Get-SettingPath $Settings 'chrome_profile_dir'
    if ($dir -eq '') {
        $dir = Join-Path $env:LOCALAPPDATA 'ShinsegaePhotobooth\ChromeProfile'
    }
    $dir = $dir.TrimEnd('\')
    # The profile holds the camera permission and browser data; keep it out of Git.
    if (($dir + '\').StartsWith($ProjectRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Setting 'chrome_profile_dir' must be outside the project folder: $dir"
    }
    return $dir
}

# ---------------------------------------------------------------- programs

function Resolve-Program([string]$Configured, [string]$Key, [string[]]$Candidates) {
    if ($Configured -ne '') {
        if (-not (Test-Path -LiteralPath $Configured -PathType Leaf)) {
            throw "Setting '$Key' points to a missing file: $Configured"
        }
        return $Configured
    }
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw "Program was not found. Set '$Key' in settings.ini. Looked in: $($Candidates -join ', ')"
}

function Get-RegistryDefault([string]$Path) {
    $item = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($item -and $item.PSObject.Properties['(default)']) { return [string]$item.'(default)' }
    return $null
}

function Resolve-ChromePath([hashtable]$Settings) {
    $appPath = 'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
    return Resolve-Program (Get-SettingPath $Settings 'chrome_path') 'chrome_path' @(
        (Get-RegistryDefault "HKLM:\$appPath"),
        (Get-RegistryDefault "HKCU:\$appPath"),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
}

function Resolve-ObsPath([hashtable]$Settings) {
    $installDir = Get-RegistryDefault 'HKLM:\SOFTWARE\OBS Studio'
    $fromRegistry = $null
    if ($installDir) { $fromRegistry = Join-Path $installDir 'bin\64bit\obs64.exe' }
    return Resolve-Program (Get-SettingPath $Settings 'obs_path') 'obs_path' @(
        $fromRegistry,
        (Join-Path $env:ProgramFiles 'obs-studio\bin\64bit\obs64.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'obs-studio\bin\64bit\obs64.exe')
    )
}

# ---------------------------------------------------------------- processes

# Chrome processes started with this exact --user-data-dir, plus their
# descendants. A normal Chrome uses a different profile and never matches.
function Get-ProfileChromeIds([string]$ProfileDir) {
    $records = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction Stop)
    $pattern = '(?i)--user-data-dir=(?:"{0}\\?"|{0}\\?)(?=\s|$)' -f [Regex]::Escape($ProfileDir)
    $ids = New-Object 'Collections.Generic.HashSet[int]'
    foreach ($record in $records) {
        if ($record.CommandLine -and $record.CommandLine -match $pattern) {
            [void]$ids.Add([int]$record.ProcessId)
        }
    }
    do {
        $added = $false
        foreach ($record in $records) {
            if ($ids.Contains([int]$record.ParentProcessId) -and $ids.Add([int]$record.ProcessId)) {
                $added = $true
            }
        }
    } while ($added)
    return @($ids)
}

# PowerShell hosts running this project's serve.ps1 (matched by full path).
function Get-ServerProcessIds {
    $pattern = '(?i)-File\s+(?:"{0}"|{0})(?=\s|$)' -f [Regex]::Escape($ServerScript)
    return @(Get-CimInstance Win32_Process -ErrorAction Stop |
            Where-Object {
                ($_.Name -eq 'powershell.exe' -or $_.Name -eq 'pwsh.exe') -and
                $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine -match $pattern
            } |
            ForEach-Object { [int]$_.ProcessId })
}

function Wait-ProcessExit([int[]]$Ids, [int]$TimeoutMs) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    do {
        $alive = @($Ids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($alive.Count -eq 0) { return @() }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    return $alive
}

# Asks windows to close first so Chrome can save a clean exit, then forces
# whatever is left. Returns the number of processes that had to be forced.
function Stop-ProcessIds([int[]]$Ids, [int]$GraceMs) {
    if ($Ids.Count -eq 0) { return 0 }
    $asked = $false
    foreach ($id in $Ids) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
            try { [void]$process.CloseMainWindow(); $asked = $true } catch { }
        }
    }
    $remaining = @($Ids)
    if ($asked) { $remaining = @(Wait-ProcessExit $Ids $GraceMs) }
    foreach ($id in $remaining) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    $left = @(Wait-ProcessExit $remaining 3000)
    if ($left.Count -gt 0) {
        throw "Processes could not be stopped: $($left -join ', ')"
    }
    return $remaining.Count
}
