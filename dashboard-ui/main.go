// career-dashboard-ui — self-contained Windows launcher for the career-ops web
// dashboard.
//
// It embeds a Next.js standalone server (the `app/` tree) plus a node runtime
// (node.exe) and, on launch:
//
//  1. anchors the career-ops root on its OWN executable directory (so it reads
//     cv.md / data/ / reports/ from wherever the exe sits, like the Go TUI),
//  2. lazily extracts the embedded runtime to %LOCALAPPDATA%\career-ops-dashboard-ui
//     (versioned, so repeat launches start near-instantly),
//  3. picks a free port, starts the server with CAREER_OPS_ROOT / PORT /
//     HOSTNAME set, waits until it answers,
//  4. opens the default browser at http://127.0.0.1:<port>, and
//  5. stays alive (reusing a running instance if one is already up).
package main

import (
	"embed"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed all:app
var appFS embed.FS

//go:embed node.exe
var nodeExe []byte

// Bump cacheVersion whenever the embedded app changes so stale caches are
// re-extracted instead of being reused.
const cacheVersion = "2"

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

	cacheBase := filepath.Join(appDataDir(), "career-ops-dashboard-ui")
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
	defer func() { _ = os.Remove(filepath.Join(runtimeDir, "LOCK")) }()
	if err := writeLock(runtimeDir, port); err != nil {
		fatal("could not write lock: " + err.Error())
		return
	}

	waitReady(port, 60*time.Second)
	openBrowser(fmt.Sprintf("http://127.0.0.1:%d", port))

	// Stay alive for as long as the server does.
	_ = cmd.Wait()
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

// startServer launches node server.js hidden from the console, pointed at the
// career-ops root anchored on the exe's own directory.
func startServer(nodePath, serverDir, careerRoot string, port int) *exec.Cmd {
	cmd := exec.Command(nodePath, "server.js")
	cmd.Dir = serverDir
	cmd.Env = append(os.Environ(),
		"CAREER_OPS_ROOT="+careerRoot,
		"PORT="+strconv.Itoa(port),
		"HOSTNAME=127.0.0.1",
	)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	if err := cmd.Start(); err != nil {
		fatal("failed to start the dashboard server: " + err.Error())
		return nil
	}
	return cmd
}

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

func appDataDir() string {
	if d := os.Getenv("LOCALAPPDATA"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "AppData", "Local")
}
