# dashboard-ui/

Self-contained Windows launcher for the career-ops **web dashboard** — packages the
web UI (`web/`) into a single double-clickable `career-dashboard-ui.exe`.

## What it is

The exe embeds:

- the **Next.js standalone server** build of the web app (`app/`),
- a **Node runtime** (`node.exe`),
- the application **icon + version resources** (via go-winres).

On launch it:

1. anchors the career-ops root on its **own executable directory** — it reads
   `cv.md` / `data/` / `reports/` from wherever the exe sits (like the Go TUI),
2. extracts the embedded runtime to a `.dashboard-runtime\v{N}` dir next to the
   exe on first use (cached; repeat launches start near-instantly),
3. picks a free port (3000+), starts the server with `CAREER_OPS_ROOT` / `PORT` /
   `HOSTNAME` set, and waits until it answers,
4. opens the default browser at `http://localhost:<port>` (the server binds
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

It is a Windows GUI app (`-H windowsgui`): no console window, no Node install
required on the user's machine.

## Layout

| File | Purpose |
|------|---------|
| `main.go` | Go launcher — embed, extract, run server, tray life cycle |
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

## Build

```bash
node dashboard-ui/build-dashboard-ui.mjs
```

The script:

1. runs `next build` (standalone output) in `web/`,
2. copies `.next/static` into the standalone tree (Next doesn't do this),
3. strips dev/traced junk (`src/`, `tests/`, logs, configs) from the standalone tree,
4. copies the clean tree into `app/` (Go embed source) and the running Node
   binary into `node.exe`,
5. regenerates the `.syso` resources with go-winres (icon + manifest + version),
6. compiles `career-dashboard-ui.exe` into the repo root.

Requires **Node 20+** (Next 16 engines floor), **Go 1.24+**, and **go-winres**
(auto-installed on first run into `.gobin/`). Check the prerequisites:

```bash
node --version   # ≥ v20
go version       # ≥ go1.24
```

### What the build produces

The script builds `web/` (Next standalone), embeds it with the running Node
binary, and compiles the launcher into the repo root:

- **Output:** `career-dashboard-ui.exe` (≈120 MB) at the repo root
- **Time:** ~1–3 minutes on a typical machine (longer on first run, when
  go-winres is installed). Running a `next dev` server alongside does not
  conflict — the build writes to a separate output.
- **Embedded cache version:** bump `cacheVersion` in `main.go` whenever the
  embedded app changes, so existing installs re-extract instead of reusing a
  stale `.dashboard-runtime\v{N}` cache.

### Verifying a build

```bash
# 1. Confirm the exe exists and its timestamp is fresh
Get-Item career-dashboard-ui.exe

# 2. Smoke-test: launch it (GUI app, no console) and wait a few seconds
.\career-dashboard-ui.exe

# 3. It extracts `.dashboard-runtime\v{N}` next to the exe, picks a free port
#    (3000+), and serves the dashboard — verify the API answers:
#    (the port is written to .dashboard-runtime\v{N}\LOCK)
Invoke-WebRequest "http://127.0.0.1:3000/api/version"   # expect HTTP 200

# 4. Diagnostics: if anything looks wrong, read the tray log
Get-Content .dashboard-runtime\v{N}\tray-debug.log
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `go: command not found` | Install Go 1.24+ and add it to `PATH` |
| go-winres install fails on first run | Check network / `GOPROXY`; retry — it is cached in `.gobin/` afterwards |
| exe launches but nothing appears | Read `.dashboard-runtime\v{N}\tray-debug.log` (always written) |
| Old web version still shows after a rebuild | You forgot to bump `cacheVersion` in `main.go` — stale cache is being reused |
| Server "exited unexpectedly" dialog | Check the tray log; use the tray menu "重启服务" to retry |

The exe is a Windows GUI app (`-H windowsgui`): it has **no console output** by
design — the tray log is the one and only diagnostics channel.

## Notes

- `app/`, `node.exe`, `.gobin/`, and `*.syso` are build outputs and git-ignored.
- Bump `cacheVersion` in `main.go` whenever the embedded app changes so stale
  caches are re-extracted instead of being reused.
- The web build self-hosts its fonts (`web/public/fonts`, via Fontsource +
  `next/font/local`) so the production build works offline — no
  `fonts.googleapis.com` access required.
