@echo off
REM Copy the latest label GUI down from the shared Drive folder, then start it.
REM Double-click this instead of start.bat when you want the newest version.
REM
REM The app is deliberately run from this local folder rather than from inside
REM Google Drive. Drive rewrites files as it syncs, and the app writes its own
REM settings and print log beside itself; running in there means the two take
REM turns overwriting each other.
setlocal
cd /d "%~dp0"
title trace labels - update

set "RELPATH=Main\test labels\label-gui"
set "SOURCE="

REM Drive for desktop mounts as a letter that moves between machines, and the
REM shared folder may be reached either directly or through a shortcut in My
REM Drive, so both are tried rather than one being assumed.
for %%D in (G H I J K L M) do (
  if not defined SOURCE if exist "%%D:\My Drive\%RELPATH%\server.py" set "SOURCE=%%D:\My Drive\%RELPATH%"
  if not defined SOURCE if exist "%%D:\Shared drives\%RELPATH%\server.py" set "SOURCE=%%D:\Shared drives\%RELPATH%"
  if not defined SOURCE if exist "%%D:\%RELPATH%\server.py" set "SOURCE=%%D:\%RELPATH%"
)

if not defined SOURCE (
  echo.
  echo   Could not find the Drive copy of the label GUI.
  echo.
  echo   Looked for "%RELPATH%\server.py" on drives G to M.
  echo   Check Google Drive for desktop is running and the folder has synced,
  echo   then edit RELPATH at the top of this file if it lives somewhere else.
  echo.
  pause
  exit /b 1
)

echo.
echo   Updating from: %SOURCE%
echo.

REM /E copies every subfolder. No /MIR and no /PURGE: this only ever brings
REM files down, so nothing here can be deleted by a bad sync. The exclusions
REM are the files that belong to this machine -- the printer settings and the
REM print log -- which must never be overwritten by a copy made elsewhere.
robocopy "%SOURCE%" "%CD%" /E /XF config.json print-log.jsonl /XD printed __pycache__ /NFL /NDL /NJH /NJS /NP
if errorlevel 8 (
  echo.
  echo   The copy failed. Nothing has been started.
  echo.
  pause
  exit /b 1
)

echo   Up to date.
call "%~dp0start.bat"
