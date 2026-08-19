@echo off
rem Hermes WebUI Desktop Companion - stop (desktop pet)
rem
rem The loopback sidecar is spawned by the pet and lives in a Job Object with
rem KILL_ON_JOB_CLOSE, so stopping the pet also tears down the sidecar. The
rem node kill below is kept as a best-effort fallback in case a sidecar ever
rem escapes the Job Object.
setlocal
echo [companion] Stopping desktop pet...
taskkill /IM "hermes-webui-desktop-companion-pet.exe" /F >nul 2>&1

echo [companion] Stopping sidecar...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*loopback-server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; 'killed pid ' + $_.ProcessId }"

echo [companion] Stopped.
endlocal
