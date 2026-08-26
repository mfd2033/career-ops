//go:build !windows

package main

import (
	"fmt"
	"os"
)

// openBrowser is a no-op on non-Windows platforms (the packaged launcher is
// Windows-only; kept for cross-platform compilation of the module).
func openBrowser(url string) {}

// fatal prints to stderr on non-Windows platforms.
func fatal(msg string) {
	_, _ = fmt.Fprintln(os.Stderr, msg)
}
