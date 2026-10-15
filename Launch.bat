@echo off
REM Site launcher: OBS -> local server -> Chrome kiosk. Keep this file ASCII only.
REM Extra arguments are passed to bin\launch.ps1 (for example -SettingsPath for tests).
setlocal EnableExtensions
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\launch.ps1" %*
set "RC=%errorlevel%"
if not "%RC%"=="0" (
    echo.
    echo [ERROR] Launch failed with exit code %RC%.
    echo         See the newest launch_*.log in: %~dp0logs\
    pause
)
exit /b %RC%
