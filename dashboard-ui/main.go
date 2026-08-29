// career-dashboard-ui — self-contained Windows launcher for the career-ops web
// dashboard.
//
// It embeds a Next.js standalone server (the `app/` tree) plus a node runtime
// (node.exe) and, on launch:
//
//  1. anchors the career-ops root on its OWN executable directory (so it reads
//     cv.md / data/ / reports/ from wherever the exe sits, like the Go TUI),
//  2. lazily extracts the embedded runtime to a `.dashboard-runtime` dir next
//     to the exe (versioned, so repeat launches start near-instantly),
//  3. picks a free port, starts the server with CAREER_OPS_ROOT / PORT /
//     HOSTNAME set, waits until it answers,
//  4. opens the default browser at http://127.0.0.1:<port>, and
//  5. stays alive (reusing a running instance if one is already up).
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

//go:embed all:app
var appFS embed.FS

//go:embed node.exe
var nodeExe []byte

//go:embed icon.ico
var trayIcon []byte

// Bump cacheVersion whenever the embedded app changes so stale caches are
// re-extracted instead of being reused.
const cacheVersion = "8"

func main() {
	exe, err := os.Executable()
	if err != nil {
		fatal("cannot locate executable: " + err.Error())
		return
	}
	careerRoot := filepath.Dir(exe)

	// Sanity-check that we sit inside a career-ops checkout (data files).
	if !fileExists(filepath.Join(careerRoot, "data", "applications.md")) &&
		!fileExists(filepath.Join(careerRoot, "applications.md")) {
		fatal("career-ops data not found next to " + exe +
			"\n\nPlace career-dashboard-ui.exe inside your career-ops directory.")
		return
	}

	// Keep the extracted runtime next to the exe (inside the career-ops
	// directory) rather than %LOCALAPPDATA%: everything lives in one place,
	// and deleting the directory deletes the cached runtime with it.
	cacheBase := filepath.Join(careerRoot, ".dashboard-runtime")
	runtimeDir := filepath.Join(cacheBase, "v"+cacheVersion)
	if err := ensureRuntime(runtimeDir); err != nil {
		fatal("setup failed: " + err.Error())
		return
	}

	nodePath := filepath.Join(runtimeDir, "node.exe")
	serverDir := filepath.Join(runtimeDir, "app")

	// Reuse an already-running instance if one is alive on the locked port.
	if port, ok := readLock(runtimeDir); ok && httpAlive(port) {
		openBrowser(fmt.Sprintf("http://127.0.0.1:%d", port))
		return
	}

	port := pickFreePort()
	cmd := startServer(nodePath, serverDir, careerRoot, port)
	if cmd == nil {
		return // fatal already shown
	}
	if err := writeLock(runtimeDir, port); err != nil {
		fatal("could not write lock: " + err.Error())
		return
	}
	defer func() { _ = os.Remove(filepath.Join(runtimeDir, "LOCK")) }()

	waitReady(port, 60*time.Second)
	openBrowser(fmt.Sprintf("http://127.0.0.1:%d", port))

	// Live with the system tray until the user asks to quit: the tray's menu
	// (Open / Restart / Quit) drives the rest of the process life cycle.
	setupTrayLog(runtimeDir)
	runTrayLoop(cmd, nodePath, serverDir, careerRoot, runtimeDir, port)
}

// setupTrayLog redirects the standard logger to a file so the systray
// library's internal errors (written to stderr, which a GUI app discards)
// become visible for diagnostics. The log is always written — gating it on
// an environment variable proved unreliable when the exe is launched by
// double-click (Explorer doesn't inherit the caller's env, and a second
// launch while an instance is alive exits before setupTrayLog runs). The
// file is append-only and small, so it is safe to always create.
func setupTrayLog(dir string) {
	f, err := os.OpenFile(filepath.Join(dir, "tray-debug.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	log.SetOutput(f)
	log.Printf("tray log started: pid=%d", os.Getpid())
}

// ensureRuntime extracts the embedded app + node runtime to dir on first use.
// Subsequent runs (dir already marked OK) skip extraction entirely.
func ensureRuntime(dir string) error {
	ok := filepath.Join(dir, "OK")
	if fileExists(ok) && fileExists(filepath.Join(dir, "node.exe")) &&
		fileExists(filepath.Join(dir, "app", "server.js")) {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "node.exe"), nodeExe, 0o755); err != nil {
		return err
	}
	if err := extractFS(appFS, "app", filepath.Join(dir, "app")); err != nil {
		return err
	}
	return os.WriteFile(ok, []byte(cacheVersion), 0o644)
}

// extractFS copies an embed.FS subtree (root and below) onto the filesystem.
func extractFS(fsys fs.FS, root, dest string) error {
	return fs.WalkDir(fsys, root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, root)
		rel = strings.TrimPrefix(rel, "/")
		target := filepath.Join(dest, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := fs.ReadFile(fsys, path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

// startServer launches the dashboard server process hidden from the console,
// pointed at the career-ops root anchored on the exe's own directory.
// Platform-specific: see platform_windows.go (hidden window) / platform_other.go (no-op).

// pickFreePort returns a free TCP port on 127.0.0.1 (preferring 3000+).
func pickFreePort() int {
	for p := 3000; p <= 3040; p++ {
		ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err == nil {
			_ = ln.Close()
			return p
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 3000
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// httpAlive reports whether a dashboard server is already answering on port.
func httpAlive(port int) bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/version", port))
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// waitReady blocks until the server answers or the timeout elapses.
func waitReady(port int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if httpAlive(port) {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func readLock(dir string) (int, bool) {
	b, err := os.ReadFile(filepath.Join(dir, "LOCK"))
	if err != nil {
		return 0, false
	}
	p, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || p <= 0 {
		return 0, false
	}
	return p, true
}

func writeLock(dir string, port int) error {
	return os.WriteFile(filepath.Join(dir, "LOCK"), []byte(strconv.Itoa(port)), 0o644)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}



// runTrayLoop owns the process life cycle once the server is up: it installs
// the system tray, watches the server process for unexpected exits, and
// reacts to tray menu commands (Open / Restart / Quit). It returns only when
// the tray has been torn down and the caller should exit.
func runTrayLoop(cmd *exec.Cmd, nodePath, serverDir, careerRoot, runtimeDir string, port int) {
	tray := newTray(trayIcon)
	defer tray.Quit()

	// curCmd is the live server process; restart() swaps it atomically so the
	// watch loop always waits on the current one.
	curCmd := &atomic.Pointer[exec.Cmd]{}
	curCmd.Store(cmd)

	serviceExit := make(chan error, 1)
	go watchServer(curCmd, serviceExit)

	for {
		select {
		case err := <-serviceExit:
			// The server died on its own (not via our restart/quit). Keep the
			// tray alive so the user can restart the server or quit cleanly.
			msg := "The dashboard server exited unexpectedly."
			if err != nil {
				msg += "\n\n" + err.Error()
			}
			fatal(msg + "\n\nUse the tray menu to restart the server or quit.")

		case c := <-tray.Commands():
			switch c {
			case trayOpen:
				log.Printf("tray: open command")
				openBrowser(fmt.Sprintf("http://127.0.0.1:%d", port))
			case trayRestart:
				log.Printf("tray: restart command")
				port = restartServer(curCmd, nodePath, serverDir, careerRoot, runtimeDir, port)
				log.Printf("tray: restart done, new port %d", port)
			case trayQuit:
				log.Printf("tray: quit command")
				stopServer(curCmd, runtimeDir)
				log.Printf("tray: server stopped, quitting tray")
				tray.Quit()
				<-tray.Done()
				log.Printf("tray: done, exiting main loop")
				return
			}

		case <-tray.Done():
			return
		}
	}
}

// watchServer waits on the current server process. When a restart swaps
// curCmd, the old process exit is expected and the loop moves on to wait on
// the new process instead of reporting it as an unexpected exit.
func watchServer(curCmd *atomic.Pointer[exec.Cmd], serviceExit chan<- error) {
	for {
		cmd := curCmd.Load()
		if cmd == nil || cmd.Process == nil {
			return
		}
		err := cmd.Wait()
		if curCmd.Load() != cmd {
			continue // old process killed by a restart; wait on the new one
		}
		serviceExit <- err
		return
	}
}

// restartServer kills the current server and starts a fresh one on a
// newly-picked free port, then re-opens the browser. The tray icon is
// unaffected. Returns the new port.
func restartServer(curCmd *atomic.Pointer[exec.Cmd], nodePath, serverDir, careerRoot, runtimeDir string, port int) int {
	old := curCmd.Load()

	newPort := pickFreePort()
	cmd := startServer(nodePath, serverDir, careerRoot, newPort)
	if cmd == nil {
		return port // fatal already shown; keep the old port
	}

	// Swap curCmd BEFORE killing the old process: the watcher goroutine is
	// blocked in old.Wait(), and it compares curCmd against the process that
	// died to distinguish an expected restart from a crash. If we killed first
	// and stored after, the watcher could observe the old process's death
	// before the swap and report a spurious "server exited unexpectedly".
	curCmd.Store(cmd)
	if old != nil && old.Process != nil {
		_ = old.Process.Kill()
	}

	if err := writeLock(runtimeDir, newPort); err != nil {
		fatal("could not write lock during restart: " + err.Error())
	}

	waitReady(newPort, 30*time.Second)
	openBrowser(fmt.Sprintf("http://127.0.0.1:%d", newPort))
	return newPort
}

// stopServer kills the running server (if any) and clears the port lock.
func stopServer(curCmd *atomic.Pointer[exec.Cmd], runtimeDir string) {
	if cmd := curCmd.Load(); cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	_ = os.Remove(filepath.Join(runtimeDir, "LOCK"))
}
