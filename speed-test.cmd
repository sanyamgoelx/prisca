@echo off
rem Double-click: time the scanner with different settings (about 4 minutes).
title Prisca speed test
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\speed-test.ps1"
echo.
pause
