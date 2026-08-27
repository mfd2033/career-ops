module github.com/santifer/career-ops/dashboard-ui

go 1.25.0

require golang.org/x/sys v0.47.0

require (
	fyne.io/systray v1.12.2 // indirect
	github.com/godbus/dbus/v5 v5.1.0 // indirect
)

// Vendored fork of fyne.io/systray with a one-line Windows fix: showMenu()
// posts WM_NULL after TrackPopupMenu (required by the Win32 docs so the
// thread's menu-active flag clears and the context menu shows on every
// right-click, not just the first). See third_party/systray/PATCH.md.
replace fyne.io/systray => ./third_party/systray
