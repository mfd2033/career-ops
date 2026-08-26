//go:build windows

package main

import "golang.org/x/sys/windows"

// openBrowser opens url in the default browser via ShellExecute.
func openBrowser(url string) {
	verb, _ := windows.UTF16PtrFromString("open")
	u, _ := windows.UTF16PtrFromString(url)
	_ = windows.ShellExecute(0, verb, u, nil, nil, windows.SW_SHOWNORMAL)
}

// fatal shows an error dialog (the exe is a GUI app with no console).
func fatal(msg string) {
	title, _ := windows.UTF16PtrFromString("career-dashboard-ui")
	text, _ := windows.UTF16PtrFromString(msg)
	_, _ = windows.MessageBox(0, text, title, 0x00000010) // MB_ICONERROR
}
