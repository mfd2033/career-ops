//go:build !windows

package main

// newTray is a no-op on platforms without a system tray (the launcher is a
// Windows GUI app; the tray only exists there). Command and done channels are
// never signalled, so the main loop simply tracks the server process.
func newTray(_ []byte) *trayController {
	return &trayController{
		commands: make(chan trayCommand, 8),
		done:     make(chan struct{}),
		quit:     func() {},
	}
}