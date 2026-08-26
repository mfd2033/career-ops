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
2. extracts the embedded runtime to `%LOCALAPPDATA%\career-ops-dashboard-ui\v{N}`
   on first use (cached; repeat launches start near-instantly),
3. picks a free port (3000+), starts the server with `CAREER_OPS_ROOT` / `PORT` /
   `HOSTNAME` set, and waits until it answers,
4. opens the default browser at `http://127.0.0.1:<port>`, then stays alive
   (reusing an already-running instance if one is up — double-clicking again
   just re-opens the browser).

It is a Windows GUI app (`-H windowsgui`): no console window, no Node install
required on the user's machine.

## Layout

| File | Purpose |
|------|---------|
| `main.go` | Go launcher — embed, extract, run server, open browser |
| `open_windows.go` / `open_other.go` | Platform open-browser / error-dialog helpers |
| `go.mod` / `go.sum` | Module (only dependency: `golang.org/x/sys`) |
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
(auto-installed on first run into `.gobin/`).

## Notes

- `app/`, `node.exe`, `.gobin/`, and `*.syso` are build outputs and git-ignored.
- Bump `cacheVersion` in `main.go` whenever the embedded app changes so stale
  caches are re-extracted instead of being reused.
- The web build self-hosts its fonts (`web/public/fonts`, via Fontsource +
  `next/font/local`) so the production build works offline — no
  `fonts.googleapis.com` access required.
