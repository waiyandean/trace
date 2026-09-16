@echo off
REM Installs print-relay.py as a Windows service, using NSSM, so it starts on
REM boot and restarts itself if it crashes -- the same "keeps running without
REM anybody remembering to start it" property cloudflared already has once
REM installed with `cloudflared service install`.
REM
REM Needs NSSM first. Download the win64 build from https://nssm.cc/download,
REM extract nssm.exe, and put it in this same folder next to print-relay.py.
REM Run this file after that, once. Re-running it is safe -- it just
REM reconfigures the same service.
setlocal
cd /d "%~dp0"
title trace print relay - service install

if not exist "nssm.exe" (
  echo.
  echo   nssm.exe not found in this folder.
  echo   Download it from https://nssm.cc/download, extract nssm.exe here,
  echo   and run this again.
  echo.
  pause
  exit /b 1
)

if not exist "print-relay.py" (
  echo.
  echo   print-relay.py not found in this folder. Run update.bat first.
  echo.
  pause
  exit /b 1
)

REM Resolved here, in this script's own shell, rather than left as the bare
REM word "python" for the service to look up itself -- a service usually runs
REM as Local System, whose PATH is not the interactive user's PATH, and the
REM python.exe the installer put on *your* PATH would otherwise silently not
REM be found when Windows actually starts the service.
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

set /p PRINTER_IP="Printer address [192.168.0.166]: "
if "%PRINTER_IP%"=="" set PRINTER_IP=192.168.0.166

echo.
echo   Installing the service, using %PY%...
echo.

nssm stop trace-print-relay >nul 2>nul
nssm remove trace-print-relay confirm >nul 2>nul

nssm install trace-print-relay "%PY%"
REM The trailing dot matters: %~dp0 always ends in a backslash, and a
REM quoted argument ending "\" immediately before the closing quote is
REM read by a real program's own argv parsing (not a cmd builtin -- nssm
REM is a normal .exe) as an escaped literal quote character, not "end of
REM path". Without it NSSM was handed a directory with a stray trailing
REM " baked into the name, which does not exist, and the service died on
REM every start with no more explanation than "unexpected SERVICE_STOPPED".
nssm set trace-print-relay AppDirectory "%~dp0."
nssm set trace-print-relay AppParameters "print-relay.py --printer %PRINTER_IP%"
nssm set trace-print-relay Start SERVICE_AUTO_START
nssm set trace-print-relay AppStdout "%~dp0print-relay.log"
nssm set trace-print-relay AppStderr "%~dp0print-relay.log"
REM Kept small and rotated, rather than left to grow for as long as the
REM laptop stays on -- the same reasoning labels/gui's own print log follows.
nssm set trace-print-relay AppRotateFiles 1
nssm set trace-print-relay AppRotateBytes 1048576
REM Restart on crash, capped so a printer that is genuinely unreachable does
REM not spin the service in a tight restart loop forever.
nssm set trace-print-relay AppExit Default Restart
nssm set trace-print-relay AppThrottle 5000
nssm set trace-print-relay AppRestartDelay 5000

nssm start trace-print-relay

echo.
echo   Installed and started as a Windows service: trace-print-relay
echo   It will now start on its own every time this machine boots.
echo.
echo   Check it with:    nssm status trace-print-relay
echo   Stop it with:      nssm stop trace-print-relay
echo   Remove it with:    nssm remove trace-print-relay confirm
echo   Logs are at print-relay.log in this folder.
echo.
pause
