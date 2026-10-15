[CmdletBinding()]
param(
    # Alternative settings file (testing). Default: settings.ini in the project root.
    [string]$SettingsPath
)

# Stops what Launch.bat started: the kiosk Chrome (identified by its dedicated
# --user-data-dir, never a normal Chrome) and this project's serve.ps1.
# OBS is closed only when obs_stop_on_shutdown=true.
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

Start-LogFile -Prefix 'shutdown' -Keep 20
$failures = New-Object Collections.Generic.List[string]

function Invoke-Step([string]$Name, [scriptblock]$Action) {
    try { & $Action }
    catch {
        Write-Log "$Name failed: $($_.Exception.Message)" 'ERROR'
        $failures.Add($Name)
    }
}

$settings = @{}
Invoke-Step 'settings' {
    if (-not $SettingsPath) {
        $SettingsPath = Join-Path $ProjectRoot 'settings.ini'
        if (-not (Test-Path -LiteralPath $SettingsPath -PathType Leaf)) {
            $SettingsPath = Join-Path $ProjectRoot 'settings.example.ini'
        }
    }
    $script:settings = Read-Settings $SettingsPath
    Write-Log "Settings: $SettingsPath"
}

Invoke-Step 'kiosk Chrome' {
    $profileDir = Get-ChromeProfileDir $settings
    $ids = @(Get-ProfileChromeIds $profileDir)
    if ($ids.Count -eq 0) {
        Write-Log "Kiosk Chrome is not running (profile $profileDir)."
        return
    }
    $forced = Stop-ProcessIds $ids 5000
    Write-Log "Kiosk Chrome stopped: $($ids.Count) process(es), forced $forced (profile $profileDir)."
}

Invoke-Step 'server' {
    $ids = @(Get-ServerProcessIds)
    if ($ids.Count -eq 0) {
        Write-Log 'Server is not running.'
        return
    }
    [void](Stop-ProcessIds $ids 0)
    Write-Log "Server stopped: PID $($ids -join ', ')"
}

Invoke-Step 'OBS' {
    if (-not (Get-SettingBool $settings 'obs_stop_on_shutdown' $false)) {
        Write-Log 'OBS left running (obs_stop_on_shutdown=false).'
        return
    }
    # Only the OBS executable this project uses, matched by full path.
    $obsPath = Resolve-ObsPath $settings
    $ids = @(Get-CimInstance Win32_Process -Filter "Name = 'obs64.exe'" -ErrorAction Stop |
            Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $obsPath } |
            ForEach-Object { [int]$_.ProcessId })
    if ($ids.Count -eq 0) {
        Write-Log 'OBS is not running.'
        return
    }
    # OBS in the tray has no main window; a forced stop leaves a crash marker
    # that launch.ps1 clears before the next start.
    $forced = Stop-ProcessIds $ids 10000
    Write-Log "OBS stopped: PID $($ids -join ', '), forced $forced."
}

if ($failures.Count -gt 0) {
    Write-Log "Shutdown finished with failures: $($failures -join ', ')" 'ERROR'
    exit 1
}
Write-Log 'Shutdown completed.'
exit 0
