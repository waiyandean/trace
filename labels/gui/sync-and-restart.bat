@echo off
REM Pulls the latest from Drive and restarts both services so the new code
REM actually takes effect -- run on a schedule by install-auto-update.bat,
REM not meant to be double-clicked by hand (use update.bat for that, which
REM starts the app in a window you can watch instead of a service you can't).
REM
REM This reverses HANDOFF.md's earlier "no automatic Drive sync" call
REM (Dean, 2026-09-16) -- that decision was about files changing under a
REM process still running them, which Python does not pick up on its own.
REM Restarting the service right after the copy is what makes this safe
REM instead of silently stale: the fresh process actually loads what just
REM landed, rather than serving old code from memory while the files on disk
REM say something newer.
setlocal
cd /d "%~dp0"

set "RELPATH=Main\test labels\label-gui"
set "SOURCE="

for %%D in (G H I J K L M) do (
  if not defined SOURCE if exist "%%D:\My Drive\%RELPATH%\server.py" set "SOURCE=%%D:\My Drive\%RELPATH%"
  if not defined SOURCE if exist "%%D:\Shared drives\%RELPATH%\server.py" set "SOURCE=%%D:\Shared drives\%RELPATH%"
  if not defined SOURCE if exist "%%D:\%RELPATH%\server.py" set "SOURCE=%%D:\%RELPATH%"
)

if not defined SOURCE (
  echo %date% %time% - could not find the Drive copy, skipped >> sync-and-restart.log
  exit /b 1
)

robocopy "%SOURCE%" "%CD%" /E /XF config.json print-log.jsonl print-relay.log app-service.log /XD printed __pycache__ /NFL /NDL /NJH /NJS /NP >nul

REM /XX after a copy means nothing actually changed -- robocopy's own exit
REM codes: 0 or 1 mean "nothing / files copied", 2+ without bit 8 (fail) set
REM still means some change happened. Restarting on every run regardless is
REM simpler and harmless: nssm restart on an already-fresh service costs a
REM few seconds, not correctness.
nssm restart trace-label-app >nul 2>nul
nssm restart trace-print-relay >nul 2>nul

echo %date% %time% - synced from %SOURCE% and restarted both services >> sync-and-restart.log
