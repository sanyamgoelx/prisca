@echo off
rem Double-click to start Prisca (development build).
title Prisca
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-dev.ps1"
echo.
pause
