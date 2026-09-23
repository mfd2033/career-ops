//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// startServer launches the dashboard server process. Non-Windows builds are
// only used for compilation checks; keep the server on a visible console.
func startServer(nodePath, serverDir, careerRoot string, port int) *exec.Cmd {
	cmd := exec.Command(nodePath, "server.js")
	cmd.Dir = serverDir
	cmd.Env = append(os.Environ(),
		"CAREER_OPS_ROOT="+careerRoot,
		"PORT="+strconv.Itoa(port),
		// Bind address, not an access URL — same rationale as platform_windows.go:
		// bind the explicit IPv4 loopback, hand the user an http://localhost:<port>
		// URL (the openBrowser call sites in launcher.go).
		"HOSTNAME=127.0.0.1",
	)
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "failed to start the dashboard server: "+err.Error())
		return nil
	}
	return cmd
}