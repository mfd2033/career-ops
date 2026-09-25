//go:build windows

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

// listenerPID returns the PID owning a LISTEN socket on port and its image name
// (best-effort "", if it can't be resolved). Returns 0, "" when nothing listens.
// Parses `netstat -ano -p TCP` — dependency-free, the same tool start-web.cmd and
// the old KillServerForPort relied on.
func listenerPID(port int) (int, string) {
	out, err := exec.Command("netstat", "-ano", "-p", "TCP").Output()
	if err != nil {
		return 0, ""
	}
	suffix := ":" + strconv.Itoa(port)
	for _, line := range strings.Split(string(out), "\n") {
		// Columns: Proto  Local Address  Foreign Address  State  PID
		f := strings.Fields(line)
		if len(f) < 5 || !strings.EqualFold(f[3], "LISTENING") {
			continue
		}
		if !strings.HasSuffix(f[1], suffix) {
			continue
		}
		pid, err := strconv.Atoi(f[4])
		if err != nil || pid <= 0 {
			continue
		}
		return pid, processImageName(pid)
	}
	return 0, ""
}

// processImageName resolves a PID to its executable name for the error dialog.
// Best-effort: any failure returns "" (the PID alone is still actionable).
func processImageName(pid int) string {
	out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
	if err != nil {
		return ""
	}
	f := strings.Fields(string(out))
	if len(f) > 0 {
		return f[0]
	}
	return ""
}

// killProcessTree force-terminates pid and its child processes (the server may
// have spawned node children), matching start-web.cmd's taskkill /T /F semantics
// — it targets whatever owns the port, not only node (ADR-0063).
func killProcessTree(pid int) error {
	return exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}

// startServer launches the dashboard server process hidden from the console
// (this exe is a GUI app with no console window).
func startServer(nodePath, serverDir, careerRoot string, port int) *exec.Cmd {
	cmd := exec.Command(nodePath, "server.js")
	cmd.Dir = serverDir
	cmd.Env = append(os.Environ(),
		"CAREER_OPS_ROOT="+careerRoot,
		"PORT="+strconv.Itoa(port),
		// Bind address, not an access URL: keep the IPv4 loopback literal. Windows
		// resolves localhost to ::1 first, so HOSTNAME=localhost would bind the
		// wrong stack. Everything user-facing opens http://localhost:<port> instead
		// (clients fall back to 127.0.0.1), see the openBrowser call sites in launcher.go.
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