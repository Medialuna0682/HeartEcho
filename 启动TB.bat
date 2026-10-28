@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  "%~dp0node.exe" "%~dp0tools\supervisor.mjs" --tb --tray --open-panel
) else (
  node "%~dp0tools\supervisor.mjs" --tb --tray --open-panel
)
if errorlevel 1 pause
endlocal
