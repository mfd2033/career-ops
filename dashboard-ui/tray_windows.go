//go:build windows

package main

import (
	"log"
	"runtime"

	"fyne.io/systray"
)

// newTray installs the system-tray icon and context menu and returns a
// controller for it. It must be called once per process (systray supports a
// single icon). Menu clicks are relayed to the controller's command channel;
// the main loop is responsible for draining it.
//
// The tray runs its own message loop on a dedicated goroutine; onExit is
// invoked on that loop's thread when Quit() completes, which then closes the
// controller's done channel.
func newTray(iconData []byte) *trayController {
	t := &trayController{
		commands: make(chan trayCommand, 8),
		done:     make(chan struct{}),
	}
	t.quit = func() { systray.Quit() }

	go func() {
		// Pin this goroutine to a single OS thread for its entire lifetime.
		// systray's init() calls runtime.LockOSThread() on the MAIN goroutine,
		// which is useless here because Run() is invoked on this goroutine.
		// Unpinned, the goroutine can migrate OS threads (async preemption at
		// the syscall/log points inside showMenuAt) and corrupt the
		// window/message-pump/TrackPopupMenu thread affinity, which stops the
		// shell from delivering the right-click callback after a few shows.
		// Locking here makes window creation, nativeLoop, wndProc and the menu
		// all share one pinned thread — the Win32 model systray assumes.
		runtime.LockOSThread()

		defer close(t.done)
		systray.Run(
			func() {
				if len(iconData) > 0 {
					systray.SetIcon(iconData)
				}
				systray.SetTitle("career-ops dashboard")
				systray.SetTooltip("career-ops dashboard")

				openItem := systray.AddMenuItem("打开面板", "Open the dashboard in your browser")
				restartItem := systray.AddMenuItem("重启服务", "Restart the dashboard server")
				systray.AddSeparator()
				quitItem := systray.AddMenuItem("退出", "Shut down the dashboard")

				relay := func(item *systray.MenuItem, cmd trayCommand) {
					go func() {
						for range item.ClickedCh {
							log.Printf("tray: menu click -> command %d (%s)", cmd, item.String())
							// Blocking send: the main loop always drains, and a
							// dropped 退出/重启 command would be a real bug.
							t.commands <- cmd
						}
					}()
				}
				relay(openItem, trayOpen)
				relay(restartItem, trayRestart)
				relay(quitItem, trayQuit)

				log.Printf("tray: onReady completed (open=%s restart=%s separator=%d quit=%s)",
					openItem.String(), restartItem.String(), 3, quitItem.String())
			},
			func() {},
		)
	}()
	return t
}
