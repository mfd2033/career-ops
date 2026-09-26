// System-tray controller for the dashboard launcher.
//
// The launcher runs as a windowless GUI process. Once the embedded server is
// up, a tray icon gives the user a way to control the app without a taskbar
// window: open the dashboard, restart the embedded server, or quit.
//
// Platform implementations: tray_windows.go (real Win32 tray via
// fyne.io/systray), tray_other.go (no-op stub).

package main

// trayCommand is a command sent from the tray menu to the main event loop.
type trayCommand int

const (
	// trayOpen re-opens the dashboard in the default browser.
	trayOpen trayCommand = iota + 1
	// trayRestart tears down and restarts the embedded server process.
	trayRestart
	// trayQuit shuts down the server and exits the launcher.
	trayQuit
	// trayShowLog re-shows the launcher-owned log window (工单 02).
	trayShowLog
)

// trayController is the tray icon lifecycle handle. Menu clicks are delivered
// on Commands(); the consumer must drain it. Quit() tears the icon down and is
// safe to call from any goroutine (idempotent); Done() is closed once the
// icon has been fully removed.
type trayController struct {
	commands chan trayCommand
	done     chan struct{}
	quit     func()
	// setTooltip 外显服务状态（工单 03）：启动中 / 就绪 :3000 / 服务已退出 /
	// 启动失败。Windows 下代理到 systray.SetTooltip，非-Windows 为 no-op。
	setTooltip func(string)
}

// commands returns the channel on which tray menu commands arrive.
func (t *trayController) Commands() <-chan trayCommand {
	return t.commands
}

// Done returns a channel that is closed once the tray icon is fully removed.
func (t *trayController) Done() <-chan struct{} {
	return t.done
}

// Quit requests tray teardown. Safe to call multiple times from any goroutine.
func (t *trayController) Quit() {
	t.quit()
}

// status 更新托盘 tooltip 以外显服务状态（工单 03）。对未设置的 setTooltip
// 安全（非-Windows 或创建失败时降级为无操作）。
func (t *trayController) status(s string) {
	if t != nil && t.setTooltip != nil {
		t.setTooltip(s)
	}
}
