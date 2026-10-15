@echo off
REM Registers Launch.bat to run at sign-in (current user). Use -Remove to unregister.
REM Keep this file ASCII only.
setlocal EnableExtensions
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\setup-startup.ps1" %*
set "RC=%errorlevel%"
echo.
pause
exit /b %RC%
