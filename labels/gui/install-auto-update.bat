@echo off
REM Schedules sync-and-restart.bat to run every 4 hours, so the label app and
REM print relay catch up with what has been pushed to Drive without anybody
REM having to remember to run update.bat (Dean, 2026-09-16 -- every few hours
REM rather than tightly, so a restart mid-shift is rare rather than routine).
REM
REM Run once. Re-running replaces the same task rather than duplicating it.
setlocal
cd /d "%~dp0"
title trace labels - schedule auto-update

if not exist "sync-and-restart.bat" (
  echo.
  echo   sync-and-restart.bat not found in this folder. Run update.bat first.
  echo.
  pause
  exit /b 1
)

schtasks /create /tn "trace-labels-auto-update" ^
  /tr "\"%~dp0sync-and-restart.bat\"" ^
  /sc hourly /mo 4 ^
  /rl highest /f

if errorlevel 1 (
  echo.
  echo   Could not create the scheduled task. Try running this as Administrator.
  echo.
  pause
  exit /b 1
)

echo.
echo   Scheduled: sync-and-restart.bat runs every 4 hours.
echo   Check it in Task Scheduler under "trace-labels-auto-update", or with:
echo     schtasks /query /tn trace-labels-auto-update
echo   Remove it with:
echo     schtasks /delete /tn trace-labels-auto-update /f
echo.
pause
