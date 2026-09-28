# dashboard-ui/

Windows launcher for the career-ops **web dashboard** — packages the web UI
(`web/`) into a double-clickable launcher. The packager's daily double-click
entry is **`career-dashboard-launcher.exe`**:

- **GUI subsystem** (`-H windowsgui`): a double-click never creates a console
  window. This is the root fix — when Windows Terminal is the default terminal
  the console window belongs to the WT host process, and in-process
  `GetConsoleWindow()` only returns an invisible `PseudoConsoleWindow` that
  `ShowWindow(SW_HIDE)` cannot hide (measured; see ADR-0066 revision 2).
- **Silent start**: you get a tray icon and the background service — the log
  window starts hidden and is recalled from the tray (a hidden or minimized
  window both come back to the foreground).
- Launched from a terminal/script the launcher attaches to the parent console
  (`AttachConsole`) so its log still reaches that terminal; `> file` / pipe
  redirection is left untouched.
- The packager validates PE Subsystem=GUI(2) after building and refuses to
  publish anything else (regression guard).

## What it is

Neither the launcher embeds the Node runtime. On launch the launcher resolves a
runtime next to its own directory, in order:

1. `node.exe` + `app/server.js` sitting next to the exe
   (`locateSelfHostedRuntime`), or
2. an extracted runtime cache at `.dashboard-runtime\v{N}\` (node.exe + app/)
   — the layout produced by a prior run of the full build.

If neither exists the launcher reports `dashboard runtime not found` and exits.

Once a runtime is found it:

1. anchors the career-ops root on its **own executable directory** — it reads
   `cv.md` / `data/` / `reports/` from wherever the exe sits (like the Go TUI),
2. probes port 3000 (pinned by ADR-0063 — no free-port picking, no lock file):
   reuses a live instance, evicts a non-answering squatter, or starts fresh, then
   launches the server with `CAREER_OPS_ROOT` / `PORT=3000` / `HOSTNAME=127.0.0.1`
   and waits until it answers,
3. opens the default browser at `http://localhost:<port>` — **every access URL
   handed to the user or to a health poll in this launcher is `localhost`, never
   `127.0.0.1`** (fork house rule in `modes/_custom.md`; the browser extension
   still probes `127.0.0.1` — see `extension/background.js`). `HOSTNAME` is the
   *bind* address and stays an explicit
   IPv4 literal: Windows resolves `localhost` to `::1` first, so binding
   `localhost` would put the server on the IPv6 loopback only. Binding `127.0.0.1`
   is still reachable as `localhost` — Chromium, .NET and Node (autoSelectFamily)
   all fall back — and the origin matches the dev workflow's
   `http://localhost:3000`, so localStorage prefs are shared. Then the launcher
   stays alive (reusing an already-running instance if one is up — double-clicking
   again just re-opens the browser).

Once up, the process lives in the **system tray** (not the taskbar). Right-click
the tray icon for a menu:

- **打开面板** — re-open the dashboard in the default browser,
- **显示日志窗口** — re-show the hidden log window (see "Run log"),
- **重启服务** — kill and restart the embedded server (port stays 3000; re-opens
  the browser),
- **退出** — stop the server and exit the launcher.

The tray tooltip reflects live service state: `就绪 :3000` / `服务已退出` /
`启动失败`. Left-clicking the tray icon does nothing (menu only). The icon
reuses the embedded `icon.ico`.

## Run log (工单 01–02 / ADR-0066 revision 2)

The launcher folds its **own decisions** (takeover / evict squatter / start /
ready) and the **dashboard server child's stdout/stderr** into one timeline,
line-prefixed `[HH:MM:SS] [launcher|server]`, sent to both its own **log window**
(a Win32 read-only edit box, scrolling live) and the file
**`.career-ops-web/launcher.log`** (reset on every launcher process start).

- **Silent by default**: the window is created hidden and keeps collecting
  lines; the tray's "显示日志窗口" recalls it (`SW_RESTORE` — brings back both a
  hidden and a minimized window).
- **No console window**: the double-click entry is GUI subsystem, so no console
  appears at any point; started from a terminal/script the log additionally goes
  to that terminal's stdout.
- The log window's × only **hides** it; launcher and server keep running.
- A failed start no longer vanishes the process: after the error box closes the
  launcher stays in the tray so you can re-show the window and read the full cause.
- The old `.dashboard-runtime\v{N}\tray-debug.log` channel is retired (path drifted
  per version; pre-ready logs were lost).

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
node dashboard-ui/build-dashboard-ui.mjs      # pack the launcher (includes the web build, ~1-3 min)
# Preferred for a local repack: node local/pack-launcher.mjs (stop old instance -> clean caches -> build -> start+verify -> clean old runtime)
```

The script:

1. runs `next build` (standalone output) in `web/`,
2. copies `.next/static` into the standalone tree (Next doesn't do this),
3. strips dev/traced junk (`src/`, `tests/`, logs, configs) from the standalone tree,
4. copies the clean tree into `app/` (the runtime source the launcher reads) and the
   running Node binary into `node.exe`,
5. stamps `app/build-info.json` with the build's git SHA / timestamp / cacheVersion,
6. regenerates the `.syso` resources with go-winres (icon + manifest + version),
7. compiles the launcher into the repo root with
   `go build -ldflags "-H windowsgui -X main.cacheVersion=..."` (GUI subsystem —
   no console window on double-click) and validates PE Subsystem=GUI(2),
   refusing to publish a console-subsystem artifact.

Requires **Node 20+** (Next 16 engines floor), **Go 1.24+**, and **go-winres**
(auto-installed on first run into `.gobin/`). Check the prerequisites:

```bash
node --version   # ≥ v20
go version       # ≥ go1.24
```

### What the build produces

- **Output:** `career-dashboard-launcher.exe` (~9 MB) at the repo root. It does
  not embed a runtime — the server binary
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
#    Subsystem must be GUI: PE optional header +0x44 (2=GUI, 3=Console)

# 2. Provide a runtime next to the exe (node.exe + app/server.js), or run the
#    launcher once — it reads .dashboard-runtime\v{N}\ if present.

# 3. Launch and verify the API answers (port pinned to 3000, no lock file —
#    see ADR-0063):
.\career-dashboard-launcher.exe
Invoke-WebRequest "http://localhost:3000/api/version"   # expect HTTP 200

# 4. Diagnostics: if anything looks wrong, use the tray "显示日志窗口" or read the log
Get-Content .career-ops-web\launcher.log
```

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `go: command not found` | Install Go 1.24+ and add it to `PATH` |
| go-winres install fails on first run | Check network / `GOPROXY`; retry — it is cached in `.gobin/` afterwards |
| "dashboard runtime not found" on launch | Put `node.exe` + `app/server.js` next to the exe, or extract a runtime into `.dashboard-runtime\v{N}\` (a full build run prepares `dashboard-ui/app` + `dashboard-ui/node.exe`) |
| exe launches but nothing appears | Tray "显示日志窗口" or read `.career-ops-web/launcher.log` (always written) |
| A console window shows up on double-click | The artifact is not GUI subsystem — rebuild (the packager rejects non-GUI output); also check you double-clicked the right exe |
| Rebuild still shows old web version | `cacheVersion` derives from git SHA + dirty flag; a clean rebuild produces a fresh `.dashboard-runtime\v{N}` dir — if it didn't, check the exe timestamp is actually newer |
| "服务意外退出" / "启动失败" dialog | After the box closes the launcher stays in the tray; use "显示日志窗口" to read the full cause, "重启服务" to retry |

The log window and `.career-ops-web/launcher.log` share one timeline; the window
starts hidden, its × only hides, and the tray recalls it with `SW_RESTORE`
(工单 02 / revision 2).

## Notes

- `app/`, `node.exe`, `.gobin/`, and `*.syso` are build outputs and git-ignored.
- The web build self-hosts its fonts (`web/public/fonts`, via Fontsource +
  `next/font/local`) so the production build works offline — no
  `fonts.googleapis.com` access required.
