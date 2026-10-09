@echo off
rem Double-click: publish github (see scripts\publish-github.ps1).
title Prisca publish github
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-github.ps1"
echo.
pause
