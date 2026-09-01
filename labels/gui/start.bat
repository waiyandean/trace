@echo off
REM Start the label GUI and open it in the browser.
REM Double-click this file; leave the window open while you are printing.
cd /d "%~dp0"

REM py is the Windows launcher and is on PATH even when python is not.
where py >nul 2>nul && (py server.py & goto :eof)
where python >nul 2>nul && (python server.py & goto :eof)

echo Python 3 was not found on this machine.
echo Install it from https://www.python.org/downloads/windows/
echo and tick "Add python.exe to PATH" in the installer.
pause
