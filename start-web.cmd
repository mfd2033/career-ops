@echo off
setlocal
rem ============================================================
rem  career-ops web launcher
rem  1. stop any already-running instance on :3000 (tree-kill),
rem     so the FRESH code is the one served
rem  2. start dev server in a minimized window (logs stay there;
rem     press Ctrl+C in that window to stop)
rem  3. wait until the server responds, then open the browser
rem  Usage: double-click, or run: start-web.cmd
rem ============================================================

cd /d "%~dp0web"

rem -- 1. stop an existing instance on :3000 --
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if ($c) { $p = $c | Select-Object -ExpandProperty OwningProcess -Unique | Select-Object -First 1; if ($p) { & taskkill /PID $p /T /F 2>$null | Out-Null; Write-Host ('stopped existing server (pid ' + $p + ')') } }"

rem wait for the port to actually free up (max 15s)
powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 15;$i++){ $c = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue; if (-not $c) { break }; Start-Sleep -Seconds 1 }"

rem -- 2. start dev server in a minimized window --
start "career-ops web dev" /min cmd /c "npm run dev"

rem -- 3. poll until ready (max 30s), then open the browser --
powershell -NoProfile -ExecutionPolicy Bypass -Command "$u='http://localhost:3000'; $ok=$false; for($i=0;$i -lt 30;$i++){ try { $r=Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 1; if($r.StatusCode -eq 200){ $ok=$true; break } } catch {}; Start-Sleep -Seconds 1 }; if(-not $ok){ Write-Host 'server not ready in 30s - check the dev window logs'; exit 1 }; Start-Process $u"

if errorlevel 1 exit /b 1
echo Started: http://localhost:3000  (stop: Ctrl+C in the career-ops web dev window)
endlocal
