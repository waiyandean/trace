@echo off
REM Runs brother_diag.py, which reports what the Brother QL-600 driver says
REM about its page (resolution, page size, saved paper settings). It does not
REM print anything. The result is shown here and also saved to
REM brother-diag.txt beside this file, so it can be sent on as is.
setlocal
cd /d "%~dp0"
title trace brother diagnostic

if not exist "brother_diag.py" (
  echo.
  echo   brother_diag.py not found in this folder. Run update.bat first.
  echo.
  pause
  exit /b 1
)

set PYTHON=
where py >nul 2>nul && set PYTHON=py
if not defined PYTHON where python >nul 2>nul && set PYTHON=python

if not defined PYTHON (
  echo.
  echo   Python 3 was not found on this machine.
  echo   Install it from https://www.python.org/downloads/windows/
  echo   and tick "Add python.exe to PATH" in the installer, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Printers Windows knows about:
powershell -NoProfile -Command "Get-Printer | ForEach-Object { '    ' + $_.Name }"
echo.

set "BROTHER_NAME=Brother QL-600"
set /p BROTHER_NAME="Printer name from the list above [Brother QL-600]: "
if "%BROTHER_NAME%"=="" set "BROTHER_NAME=Brother QL-600"

%PYTHON% brother_diag.py "%BROTHER_NAME%" > brother-diag.txt 2>&1
echo.
type brother-diag.txt
echo.
echo   Saved to %~dp0brother-diag.txt
echo.
pause
