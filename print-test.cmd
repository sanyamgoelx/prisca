@echo off
rem Double-click to test printing without paper: prints a test sheet to "Microsoft Print to PDF"
rem through Prisca's helper (writes test-files\print-test.pdf and print-test.log).
title Prisca print test
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\test-print.ps1" -Out "%~dp0test-files\print-test.pdf" > "%~dp0print-test.log" 2>&1
type "%~dp0print-test.log"
echo.
pause
