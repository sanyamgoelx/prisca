@echo off
rem Double-click to build the Prisca installer (dist\Prisca_x.y.z_x64-setup.exe).
title Prisca build
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build.ps1"
echo.
pause
