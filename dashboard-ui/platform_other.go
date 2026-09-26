//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// listenerPID is a non-Windows compilation stub. The packaged launcher is
// Windows-only; port eviction relies on netstat/taskkill there. Here we report
// "nothing listening" so the launcher takes the start-fresh path.
func listenerPID(port int) (int, string) { return 0, "" }

// killProcessTree is a non-Windows compilation stub (see listenerPID).
func killProcessTree(pid int) error { return nil }

// startServer launches the dashboard server process. Non-Windows builds are
// only used for compilation checks; keep the server on a visible console.
func startServer(nodePath, serverDir, careerRoot string, port int, sink *lineSink) *exec.Cmd {
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
	if sink != nil {
		cmd.Stdout = newPrefixWriter(sink, "server")
		cmd.Stderr = newPrefixWriter(sink, "server")
	}
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "failed to start the dashboard server: "+err.Error())
		return nil
	}
	return cmd
}

// initConsole is a non-Windows compilation stub — there is no Windows console
// code page to switch; UTF-8 is native on these platforms.
func initConsole() {}
