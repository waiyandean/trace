@echo off
REM Installs the label app (server.py) as a Windows service, the same way
REM install-relay-service.bat does for the print relay -- starts on boot,
REM restarts itself if it crashes, no terminal window to remember to leave
REM open.
REM
REM Needs NSSM first. Download the win64 build from https://nssm.cc/download,
REM extract nssm.exe, and put it in this same folder next to server.py.
REM Close any copy of the app you started by hand (start.bat/update.bat)
REM before running this -- two copies fighting over the same port otherwise.
setlocal
cd /d "%~dp0"
title trace labels - service install

if not exist "nssm.exe" (
  echo.
  echo   nssm.exe not found in this folder.
  echo   Download it from https://nssm.cc/download, extract nssm.exe here,
  echo   and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "server.py" (
  echo.
  echo   server.py not found in this folder. Run update.bat first.
  echo.
  pause
  exit /b 1
)

REM Resolved here rather than left as the bare word "python" -- a service
REM usually runs as Local System, whose PATH is not the interactive user's
REM PATH, so the python.exe the installer put on *your* PATH would otherwise
REM silently not be found when Windows actually starts the service.
set PY=
for /f "delims=" %%P in ('where python 2^>nul') do if not defined PY set PY=%%P
if not defined PY for /f "delims=" %%P in ('where py 2^>nul') do if not defined PY set PY=%%P

if not defined PY (
  echo.
  echo   Python 3 was not found on this machine.
  echo   Install it from https://www.python.org/downloads/windows/
  echo   and tick "Add python.exe to PATH" in the installer, then run this again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Installing the service, using %PY%...
echo.

nssm stop trace-label-app >nul 2>nul
nssm remove trace-label-app confirm >nul 2>nul

nssm install trace-label-app "%PY%"
REM The trailing dot matters: %~dp0 always ends in a backslash, and a
REM quoted argument ending "\" immediately before the closing quote is
REM read by a real program's own argv parsing (not a cmd builtin -- nssm
REM is a normal .exe) as an escaped literal quote character, not "end of
REM path". Without it NSSM is handed a directory with a stray trailing "
REM baked into the name, which does not exist, and the service dies on
REM every start with no more explanation than "unexpected SERVICE_STOPPED"
REM (found the hard way installing trace-print-relay, 2026-09-16).
nssm set trace-label-app AppDirectory "%~dp0."
REM --no-browser: nothing under a service has a desktop session to open one
REM in, and webbrowser.open would otherwise error or silently do nothing.
nssm set trace-label-app AppParameters "server.py --no-browser"
nssm set trace-label-app Start SERVICE_AUTO_START
nssm set trace-label-app AppStdout "%~dp0app-service.log"
nssm set trace-label-app AppStderr "%~dp0app-service.log"
nssm set trace-label-app AppRotateFiles 1
nssm set trace-label-app AppRotateBytes 1048576
nssm set trace-label-app AppExit Default Restart
nssm set trace-label-app AppThrottle 5000
nssm set trace-label-app AppRestartDelay 5000

nssm start trace-label-app

echo.
echo   Installed and started as a Windows service: trace-label-app
echo   It will now start on its own every time this machine boots.
echo   Open it in a browser at whatever this machine's address is, port 8642.
echo.
echo   Check it with:    nssm status trace-label-app
echo   Stop it with:      nssm stop trace-label-app
echo   Remove it with:    nssm remove trace-label-app confirm
echo   Logs are at app-service.log in this folder.
echo.
pause
