@echo off
rem Double-click: release setup (see scripts\release-setup.ps1).
title Prisca release setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\release-setup.ps1"
echo.
pause
