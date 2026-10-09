@echo off
rem Double-click: release (see scripts\release.ps1).
title Prisca release
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release.ps1"
echo.
pause
