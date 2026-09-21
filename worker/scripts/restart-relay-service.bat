@echo off
REM Stops and starts the print-relay Windows service, so a newly synced
REM print-relay.py/brother_seal.py actually gets picked up. A running
REM Python process never reloads its own code on its own -- only a fresh
REM process does, and "restart" here is a hard stop-then-start rather than
REM a single combined command, to be sure the old process is really gone
REM before the new one starts.
REM
REM Run this after syncing new files into this folder (e.g. after
REM package.sh has copied a new brother_seal.py here), before printing.
setlocal
cd /d "%~dp0"
title trace print relay - restart

if not exist "nssm.exe" (
  echo.
  echo   nssm.exe not found in this folder. Either the service was never
  echo   installed with install-relay-service.bat, or this isn't that
  echo   folder. Stop/start it by hand via Services if you know it's
  echo   running somewhere else.
  echo.
  pause
  exit /b 1
)

echo.
echo   Stopping trace-print-relay...
nssm stop trace-print-relay

REM "nssm stop" can return while the old process is still shutting down.
REM Starting straight away then fails with "unexpected status
REM SERVICE_START_PENDING" (or the new process cannot bind the port the old
REM one still holds), so wait until Windows says it is stopped.
for /l %%i in (1,1,15) do (
  nssm status trace-print-relay | find "SERVICE_STOPPED" >nul && goto stopped
  timeout /t 1 /nobreak >nul
)
echo   It did not report stopped after 15 seconds; starting anyway.
:stopped

echo   Starting trace-print-relay...
nssm start trace-print-relay

REM Give it a few seconds to either settle or die, so the status below is the
REM real one and not just "starting".
timeout /t 4 /nobreak >nul

echo.
echo   Status:
nssm status trace-print-relay
echo.
echo   Last lines of print-relay.log:
echo   ------------------------------------------------------------------
if exist "print-relay.log" (
  powershell -NoProfile -Command "Get-Content -Tail 25 'print-relay.log'"
) else (
  echo   No print-relay.log in this folder.
)
echo   ------------------------------------------------------------------
echo.
echo   If the status is not SERVICE_RUNNING, the reason is in the log above.
echo.
pause
