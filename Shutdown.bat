@echo off
REM Stops the kiosk Chrome and the local server (OBS only if configured). Keep this file ASCII only.
REM Extra arguments are passed to bin\shutdown.ps1 (for example -SettingsPath for tests).
setlocal EnableExtensions
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\shutdown.ps1" %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
    echo.
    echo [ERROR] Shutdown failed with exit code %RC%.
    echo         See the newest shutdown_*.log in: %~dp0logs\
    pause
)
exit /b %RC%
