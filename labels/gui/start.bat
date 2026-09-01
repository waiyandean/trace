@echo off
REM Start the label GUI and open it in the browser.
REM Double-click this file; leave the window open while you are printing.
REM
REM The window is kept open whatever happens. A batch file that closes on an
REM error takes the error with it, which is the one thing you need to see.
setlocal
cd /d "%~dp0"
title trace labels

set PYTHON=
where py >nul 2>nul && set PYTHON=py
if not defined PYTHON where python >nul 2>nul && set PYTHON=python

if not defined PYTHON (
  echo.
  echo   Python 3 was not found on this machine.
  echo.
  echo   Install it from https://www.python.org/downloads/windows/
  echo   and tick "Add python.exe to PATH" in the installer, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting the label GUI with %PYTHON%.
echo   Leave this window open. Close it, or press Ctrl+C, to stop printing.
echo.
%PYTHON% server.py

echo.
echo   ------------------------------------------------------------------
echo   The server has stopped. If that was not deliberate, the reason is
echo   printed above this line.
echo   ------------------------------------------------------------------
echo.
pause
