@echo off
rem ARP: check, test, build, compare and deploy to Cloudflare Pages (see release.ps1)
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1" -Deploy %*
echo.
pause
