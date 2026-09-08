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

	lockFile := filepath.Join(runtimeDir, "LOCK")
	if port, ok := readLock(lockFile); ok && httpAlive(port) {
		openBrowser(fmt.Sprintf("http://localhost:%d", port))
		return
	}

	port, err := pickFreePort()
	if err != nil {
		fatal("无法启动 dashboard：\n\n" + err.Error() +
			"\n\n请结束占用 3000-3040 任一端口的进程后重试。")
		return
	}
	cmd := startServer(nodePath, serverDir, careerRoot, port)
	if cmd == nil {
		return
	}
	if err := writeLock(lockFile, port); err != nil {
		fatal("could not write lock: " + err.Error())
		return
	}
	defer func() { _ = os.Remove(lockFile) }()

	waitReady(port, 60*time.Second)
	openBrowser(fmt.Sprintf("http://localhost:%d", port))

	setupTrayLog(filepath.Dir(nodePath))
	runTrayLoop(cmd, nodePath, serverDir, careerRoot, filepath.Dir(nodePath), port)
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

// pickFreePort returns the first free port in 3000-3040 — the exact range the
// browser extension probes (extension/background.js PORT_MIN..PORT_MAX). A port
// outside that range would be invisible to the extension ("web 服务未运行"
// forever), so when every port in the range is taken we must NOT fall back to an
// OS-assigned port; the caller surfaces the collision instead.
func pickFreePort() (int, error) {
	for p := 3000; p <= 3040; p++ {
		ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err == nil {
			_ = ln.Close()
			return p, nil
		}
	}
	return 0, fmt.Errorf("端口 3000-3040 全部被占用（浏览器扩展只探测该范围，范围外的端口将无法连接）")
}

func httpAlive(port int) bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/version", port))
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func waitReady(port int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if httpAlive(port) {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
}

func readLock(path string) (int, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	p, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || p <= 0 {
		return 0, false
	}
	return p, true
}

func writeLock(path string, port int) error {
	return os.WriteFile(path, []byte(strconv.Itoa(port)), 0o644)
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func runTrayLoop(cmd *exec.Cmd, nodePath, serverDir, careerRoot, runtimeDir string, port int) {
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
				openBrowser(fmt.Sprintf("http://localhost:%d", port))
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

func watchServer(curCmd *atomic.Pointer[exec.Cmd], serviceExit chan<- error) {
	for {
		cmd := curCmd.Load()
		if cmd == nil || cmd.Process == nil {
			return
		}
		err := cmd.Wait()
		if curCmd.Load() != cmd {
			continue
		}
		serviceExit <- err
		return
	}
}

func restartServer(curCmd *atomic.Pointer[exec.Cmd], nodePath, serverDir, careerRoot, runtimeDir string, port int) int {
	old := curCmd.Load()
	newPort, err := pickFreePort()
	if err != nil {
		// 重启只发生在托盘菜单，此时没有 fatal 的消息框路径 — 记日志并保留旧端口，
		// 让现有服务继续跑，而不是把 server 杀掉后卡死。
		log.Printf("tray: restart aborted: %v", err)
		return port
	}
	cmd := startServer(nodePath, serverDir, careerRoot, newPort)
	if cmd == nil {
		return port
	}
	curCmd.Store(cmd)
	if old != nil && old.Process != nil {
		_ = old.Process.Kill()
	}
	lockFile := filepath.Join(runtimeDir, "LOCK")
	if err := writeLock(lockFile, newPort); err != nil {
		fatal("could not write lock during restart: " + err.Error())
	}
	waitReady(newPort, 30*time.Second)
	openBrowser(fmt.Sprintf("http://localhost:%d", newPort))
	return newPort
}

func stopServer(curCmd *atomic.Pointer[exec.Cmd], runtimeDir string) {
	if cmd := curCmd.Load(); cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	_ = os.Remove(filepath.Join(runtimeDir, "LOCK"))
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
