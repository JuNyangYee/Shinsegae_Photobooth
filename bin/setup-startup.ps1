[CmdletBinding()]
param(
    # Remove the shortcut instead of creating it.
    [switch]$Remove
)

# Adds (or removes with -Remove) a Launch.bat shortcut in the current user's
# Startup folder. No administrator rights, no Task Scheduler.
# Keep this file ASCII-only: Windows PowerShell 5.1 misreads UTF-8 without BOM.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'common.ps1')

$ShortcutName = 'Shinsegae Photobooth.lnk'
$ShortcutDescription = 'Shinsegae Christmas Photobooth launcher (Launch.bat)'

$exitCode = 0
$shell = $null
$shortcut = $null
try {
    $launchPath = Join-Path $ProjectRoot 'Launch.bat'
    $startupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    if ([string]::IsNullOrWhiteSpace($startupDir)) {
        throw 'The Startup folder of the current user was not found.'
    }
    $shortcutPath = Join-Path $startupDir $ShortcutName
    $shell = New-Object -ComObject WScript.Shell

    # Touch only a shortcut this script made (same description or target).
    $exists = Test-Path -LiteralPath $shortcutPath -PathType Leaf
    if ($exists) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        if ($shortcut.Description -ne $ShortcutDescription -and $shortcut.TargetPath -ne $launchPath) {
            throw "A different shortcut already uses this name; left unchanged: $shortcutPath"
        }
    }

    if ($Remove) {
        if ($exists) {
            Remove-Item -LiteralPath $shortcutPath -Force
            Write-Host "[OK] Removed startup shortcut: $shortcutPath"
        }
        else {
            Write-Host "[OK] No startup shortcut to remove: $shortcutPath"
        }
    }
    else {
        if (-not (Test-Path -LiteralPath $launchPath -PathType Leaf)) {
            throw "Launch.bat was not found: $launchPath"
        }
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $launchPath
        $shortcut.WorkingDirectory = $ProjectRoot
        $shortcut.Arguments = ''
        $shortcut.Description = $ShortcutDescription
        $shortcut.WindowStyle = 1
        $shortcut.Save()
        Write-Host "[OK] Startup shortcut saved: $shortcutPath"
        Write-Host "     Target: $launchPath"
        Write-Host '     Launch.bat runs at the next sign-in. Nothing was started now.'
    }
}
catch {
    [Console]::Error.WriteLine("[ERROR] Startup setup failed: $($_.Exception.Message)")
    $exitCode = 1
}
finally {
    foreach ($com in @($shortcut, $shell)) {
        if ($null -ne $com) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($com) }
    }
}
exit $exitCode
