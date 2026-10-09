@echo off
rem Double-click to list the scanners Windows can see (writes scanner-check.log).
title Prisca scanner check
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-scanner.ps1"
echo.
pause
