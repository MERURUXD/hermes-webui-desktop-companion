@echo off
rem Hermes WebUI Desktop Companion - start (desktop pet)
rem
rem The loopback sidecar is spawned automatically by the desktop pet itself
rem (main.rs Sidecar::start), which reads webui_url from the local config.json.
rem No personal deployment URL is hardcoded in this script.
setlocal

rem Repo root = parent directory of this script's folder (scripts\)
set "REPO_ROOT=%~dp0.."
cd /d "%REPO_ROOT%"

rem Native desktop pet (release build)
set "PET_EXE=%REPO_ROOT%\desktop-pet\src-tauri\target\release\hermes-webui-desktop-companion-pet.exe"
if exist "%PET_EXE%" (
  echo [companion] Starting desktop pet...
  start "" "%PET_EXE%"
) else (
  echo [companion] Release exe not found, falling back to tauri dev...
  start "Hermes Desktop Pet (dev)" cmd /k "npm run start:pet"
)

echo [companion] Running. Stop with stop-companion-win.bat.
endlocal
