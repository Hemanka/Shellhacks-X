@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Wayfinder.ps1" -Tunnel
if errorlevel 1 pause
