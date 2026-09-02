# dashboard-ui/

Windows launcher for the career-ops **web dashboard** — packages the web UI
(`web/`) into a double-clickable launcher. Two build variants, both compiled
from the same Go source (`launcher.go`):

- **`career-dashboard-ui.exe`** — GUI subsystem (`-H windowsgui`, no console
  window), ships a `cacheVersion` stamp injected by the packager. This is the
  normal double-click target.
- **`career-dashboard-launcher.exe`** — console-subsystem variant (same
  program, no `-H windowsgui`), useful when you want launcher output on stdout
  instead of the tray log. Built alone with `BUILDFULL=0`.

## What it is

Neither exe embeds the Node runtime. On launch the launcher resolves a runtime
next to its own directory, in order:

1. `node.exe` + `app/server.js` sitting next to the exe
   (`locateSelfHostedRuntime`), or
2. an extracted runtime cache at `.dashboard-runtime\v{N}\` (node.exe + app/)
   — the layout produced by a prior run of the full build.

If neither exists the launcher reports `dashboard runtime not found` and exits.

Once a runtime is found it:

1. anchors the career-ops root on its **own executable directory** — it reads
   `cv.md` / `data/` / `reports/` from wherever the exe sits (like the Go TUI),
2. picks a free port (3000+), starts the server with `CAREER_OPS_ROOT` / `PORT` /
   `HOSTNAME` set, and waits until it answers,
3. opens the default browser at `http://localhost:<port>` (the server binds
   127.0.0.1, but the browser opens "localhost" so the origin matches the dev
   workflow's `http://localhost:3000` and localStorage prefs are shared), then stays alive
   (reusing an already-running instance if one is up — double-clicking again
   just re-opens the browser).

Once up, the process lives in the **system tray** (not the taskbar). Right-click
the tray icon for a menu:

- **打开面板** — re-open the dashboard in the default browser,
- **重启服务** — kill and restart the embedded server (picks a fresh free
  port, updates the lock file, re-opens the browser),
- **退出** — stop the server, remove the lock file, and exit the launcher.

Left-clicking the tray icon does nothing (menu only, matching the tray menu
wording). The icon reuses the embedded `icon.ico`.

The launcher always redirects the tray library's log output to
`.dashboard-runtime\v{N}\tray-debug.log` next to the exe (append-only, small), so
troubleshooting never requires setting an environment variable — just launch the exe,
reproduce, and read the log. Each line carries the launcher PID.

The GUI variant (`-H windowsgui`) shows no console window; the console variant
prints its own lifecycle logs to stdout in addition to the tray log.

## Layout

| File | Purpose |
|------|---------|
| `launcher.go` | Go launcher — locate runtime, start server, tray life cycle |
| `tray.go` | Tray controller interface (commands channel, quit/done) |
| `tray_windows.go` | Windows tray implementation (systray menu: 打开面板/重启服务/退出) |
| `tray_other.go` | Non-Windows tray stub (no-op) |
| `platform_windows.go` / `platform_other.go` | Platform `startServer` (hidden window vs no-op) |
| `open_windows.go` / `open_other.go` | Platform open-browser / error-dialog helpers |
| `go.mod` / `go.sum` | Module (deps: `golang.org/x/sys` + `fyne.io/systray`, the latter `replace`d by the local vendored fork) |
| `third_party/systray/` | Local vendored fork of `fyne.io/systray` v1.12.2 with a one-line Windows fix (see `third_party/systray/PATCH.md`) — upstream never posts `WM_NULL` after `TrackPopupMenu`, so the tray context menu only showed on the first right-click |
| `gen-icon.py` | Pillow script that draws the app icon (`icon.ico`) |
| `winres/winres.json` | go-winres resource definition (icon + version info) |
| `winres/icon.ico` | The app icon (tracked; regenerable via `gen-icon.py`) |
| `build-dashboard-ui.mjs` | End-to-end packager script |
| `start-dashboard.js` | Electron-based launcher alternative (`node dashboard-ui/start-dashboard.js`) — see `README-script.md` |

## Build

```bash
node dashboard-ui/build-dashboard-ui.mjs      # both variants
BUILDFULL=0 node dashboard-ui/build-dashboard-ui.mjs   # launcher only (~9 MB)
```

The script:

1. runs `next build` (standalone output) in `web/`,
2. copies `.next/static` into the standalone tree (Next doesn't do this),
3. strips dev/traced junk (`src/`, `tests/`, logs, configs) from the standalone tree,
4. copies the clean tree into `app/` (the runtime source the launcher reads) and the
   running Node binary into `node.exe`,
5. stamps `app/build-info.json` with the build's git SHA / timestamp / cacheVersion,
6. regenerates the `.syso` resources with go-winres (icon + manifest + version),
7. compiles the variants into the repo root (`career-dashboard-ui.exe`, and
   `career-dashboard-launcher.exe` unless `BUILDFULL=0`).

Requires **Node 20+** (Next 16 engines floor), **Go 1.24+**, and **go-winres**
(auto-installed on first run into `.gobin/`). Check the prerequisites:

```bash
node --version   # ≥ v20
go version       # ≥ go1.24
```

### What the build produces

- **Output:** `career-dashboard-ui.exe` and `career-dashboard-launcher.exe`
  (each ~9 MB) at the repo root. Neither embeds a runtime — the server binary
  (`node.exe`) and Next standalone tree live in `app/` / `node.exe` under
  `dashboard-ui/` (build outputs, git-ignored) and must be present next to the
  exe or in `.dashboard-runtime\v{N}\` at launch.
- **Time:** ~1–3 minutes on a typical machine (longer on first run, when
  go-winres is installed). Running a `next dev` server alongside does not
  conflict — the build writes to a separate output.
- **Cache version:** `cacheVersion` is injected automatically from the build's
  git SHA (+ `-dirty` when the tree is dirty), so a rebuild never reuses a
  stale `.dashboard-runtime\v{N}` extraction.

### Verifying a build

```bash
# 1. Confirm the exe exists and its timestamp is fresh
Get-Item career-dashboard-launcher.exe

# 2. Provide a runtime next to the exe (node.exe + app/server.js), or run the
#    launcher once — it reads .dashboard-runtime\v{N}\ if present.

# 3. Launch and verify the API answers (the port is written to
#    .dashboard-runtime\v{N}\LOCK):
.\career-dashboard-launcher.exe
Invoke-WebRequest "http://127.0.0.1:3000/api/version"   # expect HTTP 200

# 4. Diagnostics: if anything looks wrong, read the tray log
Get-Content .dashboard-runtime\v{N}\tray-debug.log
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `go: command not found` | Install Go 1.24+ and add it to `PATH` |
| go-winres install fails on first run | Check network / `GOPROXY`; retry — it is cached in `.gobin/` afterwards |
| "dashboard runtime not found" on launch | Put `node.exe` + `app/server.js` next to the exe, or extract a runtime into `.dashboard-runtime\v{N}\` (a full build run prepares `dashboard-ui/app` + `dashboard-ui/node.exe`) |
| exe launches but nothing appears | Read `.dashboard-runtime\v{N}\tray-debug.log` (always written) |
| Old web version still shows after a rebuild | `cacheVersion` derives from git SHA + dirty flag; a clean rebuild produces a fresh `.dashboard-runtime\v{N}` dir — if it didn't, check the exe timestamp is actually newer |
| Server "exited unexpectedly" dialog | Check the tray log; use the tray menu "重启服务" to retry |

The GUI variant (`-H windowsgui`) has **no console output** by design — the tray
log is its diagnostics channel. The console variant also logs to stdout.

## Notes

- `app/`, `node.exe`, `.gobin/`, and `*.syso` are build outputs and git-ignored.
- The web build self-hosts its fonts (`web/public/fonts`, via Fontsource +
  `next/font/local`) so the production build works offline — no
  `fonts.googleapis.com` access required.
