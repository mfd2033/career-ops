//go:build windows

package main

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

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