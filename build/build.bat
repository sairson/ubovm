@echo off
setlocal
set "UBOVM_ACTION=%~1"
set "UBOVM_ARGUMENT=%~2"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1"
exit /b %ERRORLEVEL%
