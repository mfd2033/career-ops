# Career-Ops Dashboard Launcher (Script Version)

Lightweight alternative to `career-dashboard-ui.exe`.  
Starts the Next.js dashboard and stays in the system tray.

**What it does:**
- Starts/stops/restarts the web server on a free port
- Opens the browser automatically
- Shows a tray menu: 打开面板 / 重启服务 / 退出

## Run

```powershell
powershell -File dashboard-ui\start-dashboard.ps1
```

Or double-click the `.ps1` file (if PS1 execution is enabled).

## How It Works

- **Server:** Uses the pre-built Next.js standalone server in `web\.next\standalone\server.js`
- **Port selection:** Picks first free port from 3000 upward
- **Lock file:** Writes `.dashboard-runtime\v{cache}\LOCK` with the port (same scheme as the Go exe)
- **Process management:** Reads port from lock, kills existing server if needed, spawns new one
- **Tray:** PowerShell + C# inline for system tray icon and menu
- **No console:** Runs hidden (`start-process powershell -WindowStyle Hidden`)

## Files

| File | Purpose |
|------|---------|
| `dashboard-ui/start-dashboard.ps1` | The launcher script |
| `.dashboard-runtime/` | Runtime state (lock files, logs) — gitignored |

## Notes

- Requires Node.js installed
- Requires PS1 execution (enable with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`)
- Same icon as the Go exe (shares `dashboard-ui/icon-256.png`)
- Reports in tray log: `.dashboard-runtime\v{cache}\tray-debug.log`
