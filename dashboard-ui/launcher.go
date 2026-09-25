// dashboard-ui/launcher.go
// Lightweight system-tray launcher for the career-ops web dashboard.
// Build: go build -o ..\career-dashboard-launcher.exe .
package main

import (
	"fmt"
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

// cacheVersion keys the preferred runtime directory (.dashboard-runtime\v{...}).
// The packer (build-dashboard-ui.mjs) injects the git short SHA (+ dirty marker)
// of the web build via -ldflags "-X main.cacheVersion=<sha>", so a rebuilt exe
// prefers the extraction stamped with ITS OWN build, never the newest-by-mtime
// directory (which a long-running server keeps touching — the stale-cache trap
// that made a rebuild keep serving the previous web build). MUST stay
// uninitialized: go -X only overrides string vars without an explicit
// initializer. Empty → plain `go build` without the packer → "dev".
var cacheVersion string

// webPort is the single, pinned port the dashboard server binds (ADR-0063).
// It is never changed at runtime: if it can't be taken the launcher errors out
// rather than drifting to another port. Drift would (a) orphan the browser
// extension, which only probes 3000-3040, and (b) change the localStorage origin
// so the config page's per-origin state looks wiped. Both are the exact pain
// ADR-0063 removes.
const webPort = 3000

// takeoverAction is the pure decision of what the launcher must do with port
// webPort before it can show the dashboard.
type takeoverAction int

const (
	actionReuse        takeoverAction = iota // a live career-ops web answers on webPort → open it, start nothing
	actionStartFresh                         // webPort is free → start our server
	actionKillThenStart                      // webPort is owned by a non-answering process → kill its tree, then start
)

// decideTakeover is pure (no OS, no net) so the three launcher entry points can
// share one tested rule. probeOK is whether http://localhost:webPort/api/version
// returned 200; listenerPID is the PID LISTENing on webPort (0 when free). Order
// is load-bearing: an answering server is reused even though it obviously holds
// the socket, so probeOK is checked before listenerPID.
func decideTakeover(probeOK bool, listenerPID int) takeoverAction {
	if probeOK {
		return actionReuse
	}
	if listenerPID > 0 {
		return actionKillThenStart
	}
	return actionStartFresh
}

func browserURL() string {
	return fmt.Sprintf("http://localhost:%d", webPort)
}

// cannotFreeMsg is the error shown when a squatter on webPort can't be evicted.
// It names the occupant and NEVER suggests another port (ADR-0063: pinned).
func cannotFreeMsg(pid int, image string, cause error) string {
	msg := "无法启动 dashboard：3000 端口被占用，且无法释放。"
	if pid > 0 {
		msg += "\n\n占用进程：" + image + " (PID " + strconv.Itoa(pid) + ")"
	} else {
		msg += "\n\n占用进程：未知"
	}
	if cause != nil {
		msg += "\n结束该进程失败：" + cause.Error()
	}
	return msg + "\n\n请手动结束它后重试（端口固定为 3000，不会改用其它端口）。"
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		fatal("cannot locate executable: " + err.Error())
		return
	}
	exeDir := filepath.Dir(exe)

	if !fileExists(filepath.Join(exeDir, "data", "applications.md")) &&
		!fileExists(filepath.Join(exeDir, "applications.md")) {
		fatal("career-ops data not found next to " + exe +
			"\n\nPlace career-dashboard-launcher.exe inside your career-ops directory.")
		return
	}

	nodePath, serverDir := locateSelfHostedRuntime(exeDir)
	if nodePath == "" {
		nodePath, serverDir = locateLegacyCache(exeDir)
	}
	if nodePath == "" {
		fatal("dashboard runtime not found.\n\n" +
			"Run: node dashboard-ui/build-dashboard-ui.mjs\n" +
			"or place node.exe + app/ next to career-dashboard-launcher.exe.")
		return
	}

	careerRoot := exeDir
	runtimeDir := filepath.Dir(nodePath)

	// Ensure the runtime cache has an icon so loadIcon() in runTrayLoop can
	// find it on the first lookup (.dashboard-runtime\v{N}/icon.ico).
	// The launcher itself lives next to dashboard-ui/icon.ico; copy it into
	// each extracted runtime dir so the systray gets a real icon instead of
	// silently falling back to the system default (which is invisible on
	// modern Windows with dark mode / small icon sizes).
	//
	// IMPORTANT: This runs BEFORE the httpAlive shortcut so it always fires
	// even when a server is already up (the earlier "open browser and return"
	// path must still have a visible tray icon on subsequent launches).
	iconSrc := filepath.Join(exeDir, "dashboard-ui", "icon.ico")
	if fileExists(iconSrc) {
		iconDst := filepath.Join(runtimeDir, "icon.ico")
		if !fileExists(iconDst) {
			if data, err := os.ReadFile(iconSrc); err == nil && len(data) > 0 {
				_ = os.WriteFile(iconDst, data, 0o644)
			}
		}
	}

	// ADR-0063 takeover chain — port is pinned to webPort, no LOCK file, no
	// port drift. Probe first; only look for a squatter when nothing answers.
	probeOK := httpAlive(webPort)
	pid, image := 0, ""
	if !probeOK {
		pid, image = listenerPID(webPort)
	}

	switch decideTakeover(probeOK, pid) {
	case actionReuse:
		// A live career-ops web (standalone or dev) already owns 3000. Open it and
		// exit; never start a second server, never evict a healthy instance.
		openBrowser(browserURL())
		return
	case actionKillThenStart:
		if err := killProcessTree(pid); err != nil {
			fatal(cannotFreeMsg(pid, image, err))
			return
		}
		if !waitPortFree(webPort, 10*time.Second) {
			p2, im2 := listenerPID(webPort)
			fatal(cannotFreeMsg(p2, im2, nil))
			return
		}
	case actionStartFresh:
		// webPort is free — nothing to do.
	}

	cmd := startServer(nodePath, serverDir, careerRoot, webPort)
	if cmd == nil {
		return
	}
	if !waitReady(webPort, 60*time.Second) {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		fatal("dashboard 服务在 3000 端口未能就绪（可能启动即崩溃）。\n\n请检查 " +
			filepath.Join(runtimeDir, "tray-debug.log") + " 后重试。")
		return
	}
	openBrowser(browserURL())

	setupTrayLog(filepath.Dir(nodePath))
	runTrayLoop(cmd, nodePath, serverDir, careerRoot, filepath.Dir(nodePath))
}

func locateSelfHostedRuntime(exeDir string) (nodePath, serverDir string) {
	candidateNode := filepath.Join(exeDir, "node.exe")
	candidateApp := filepath.Join(exeDir, "app", "server.js")
	if fileExists(candidateNode) && fileExists(candidateApp) {
		return candidateNode, filepath.Join(exeDir, "app")
	}
	return "", ""
}

func locateLegacyCache(exeDir string) (nodePath, serverDir string) {
	cacheBase := filepath.Join(exeDir, ".dashboard-runtime")
	entries, err := os.ReadDir(cacheBase)
	if err != nil {
		return "", ""
	}
	// The extracted runtime keyed to THIS exe's build wins outright — the
	// directory name is `v{sha}[-dirty]`, stamped by the packer into
	// cacheVersion. Picking it by name (not by mtime) is what stops a rebuilt
	// exe from serving a stale extraction: a long-running server keeps
	// touching its own .dashboard-runtime dir, so "newest mtime" converges on
	// the OLD build and a rebuild silently serves the previous web version.
	preferred := "v" + cacheVersion
	if cacheVersion == "" {
		preferred = "vdev"
	}
	for _, e := range entries {
		if !e.IsDir() || e.Name() != preferred {
			continue
		}
		dir := filepath.Join(cacheBase, e.Name())
		node := filepath.Join(dir, "node.exe")
		app := filepath.Join(dir, "app", "server.js")
		if fileExists(node) && fileExists(app) {
			return node, filepath.Join(dir, "app")
		}
	}
	// No versioned match (legacy cache written before the cacheVersion stamp,
	// or a plain `go build` with no injected version) — fall back to the
	// newest valid runtime as a best effort.
	var best string
	var bestMod time.Time
	for _, e := range entries {
		if !e.IsDir() || !strings.HasPrefix(e.Name(), "v") {
			continue
		}
		dir := filepath.Join(cacheBase, e.Name())
		node := filepath.Join(dir, "node.exe")
		app := filepath.Join(dir, "app", "server.js")
		if !fileExists(node) || !fileExists(app) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if best == "" || info.ModTime().After(bestMod) {
			best = dir
			bestMod = info.ModTime()
		}
	}
	if best == "" {
		return "", ""
	}
	return filepath.Join(best, "node.exe"), filepath.Join(best, "app")
}

func setupTrayLog(dir string) {
	f, err := os.OpenFile(filepath.Join(dir, "tray-debug.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	log.SetOutput(f)
	log.Printf("launcher started: pid=%d", os.Getpid())
}

// portFree reports whether webPort can be bound on the IPv4 loopback — the same
// address the server binds (HOSTNAME in platform_*.go), so "free here" and
// "bindable there" agree. Used to confirm a squatter really released the port.
func portFree(port int) bool {
	ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

// waitPortFree polls portFree up to timeout (covers the brief TIME_WAIT after a
// kill). Returns false if the port stays owned, so the caller surfaces an error
// instead of drifting to another port.
func waitPortFree(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if portFree(port) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func httpAlive(port int) bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	// Access URL uses localhost per the house rule (_custom.md); Go's dialer
	// walks the resolved address list, so ::1 refusing falls back to 127.0.0.1.
	resp, err := c.Get(fmt.Sprintf("http://localhost:%d/api/version", port))
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func waitReady(port int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if httpAlive(port) {
			return true
		}
		time.Sleep(300 * time.Millisecond)
	}
	return false
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func runTrayLoop(cmd *exec.Cmd, nodePath, serverDir, careerRoot, runtimeDir string) {
	iconData := loadIcon(runtimeDir)
	tray := newTray(iconData)
	defer tray.Quit()

	curCmd := &atomic.Pointer[exec.Cmd]{}
	curCmd.Store(cmd)

	serviceExit := make(chan error, 1)
	go watchServer(curCmd, serviceExit)

	for {
		select {
		case err := <-serviceExit:
			msg := "The dashboard server exited unexpectedly."
			if err != nil {
				msg += "\n\n" + err.Error()
			}
			fatal(msg + "\n\nUse the tray menu to restart the server or quit.")

		case c := <-tray.Commands():
			switch c {
			case trayOpen:
				log.Printf("tray: open command")
				openBrowser(browserURL())
			case trayRestart:
				log.Printf("tray: restart command")
				restartServer(curCmd, nodePath, serverDir, careerRoot)
				log.Printf("tray: restart done")
			case trayQuit:
				log.Printf("tray: quit command")
				stopServer(curCmd)
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

func watchServer(curCmd *atomic.Pointer[exec.Cmd], serviceExit chan<- error) {
	for {
		cmd := curCmd.Load()
		if cmd == nil || cmd.Process == nil {
			// A tray restart is in progress (curCmd was nil-ed on purpose, because
			// the pinned port forces kill-old-before-start-new). Idle until the new
			// cmd lands — do NOT treat the old child's exit as a crash.
			time.Sleep(100 * time.Millisecond)
			continue
		}
		err := cmd.Wait()
		if curCmd.Load() != cmd {
			continue
		}
		serviceExit <- err
		return
	}
}

// restartServer relaunches on the same pinned port (ADR-0063): kill our own
// child, make sure 3000 is free (evicting any squatter that grabbed it in the
// interim), then start fresh. There is no "pick a new port" branch — if the
// port can't be reclaimed the restart is aborted in the log, leaving the tray
// alive, rather than silently drifting.
func restartServer(curCmd *atomic.Pointer[exec.Cmd], nodePath, serverDir, careerRoot string) {
	if old := curCmd.Load(); old != nil && old.Process != nil {
		// Nil the pointer first so watchServer ignores the deliberate kill.
		curCmd.Store(nil)
		_ = old.Process.Kill()
	}
	if !waitPortFree(webPort, 10*time.Second) {
		if pid, image := listenerPID(webPort); pid != 0 {
			_ = killProcessTree(pid)
			if !waitPortFree(webPort, 5*time.Second) {
				log.Printf("tray: restart aborted, port still owned by %s (pid=%d)", image, pid)
				return
			}
		}
	}
	cmd := startServer(nodePath, serverDir, careerRoot, webPort)
	if cmd == nil {
		return
	}
	curCmd.Store(cmd)
	if waitReady(webPort, 30*time.Second) {
		openBrowser(browserURL())
	} else {
		log.Printf("tray: restarted server not ready on %d within 30s", webPort)
	}
}

func stopServer(curCmd *atomic.Pointer[exec.Cmd]) {
	if cmd := curCmd.Load(); cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func loadIcon(runtimeDir string) []byte {
	candidates := []string{
		filepath.Join(runtimeDir, "icon.ico"),
		filepath.Join(runtimeDir, "..", "icon.ico"),
		filepath.Join(runtimeDir, "..", "..", "icon.ico"),
	}
	for _, p := range candidates {
		if b, err := os.ReadFile(p); err == nil && len(b) > 0 {
			return b
		}
	}
	return nil
}
