//go:build !windows

// logwindow_other.go — 非-Windows 编译桩（launcher 仅 Windows 打包）。
// 保证 logsink/launcher/tray 的跨平台编译与单测；自持窗口是 Windows 概念。
package main

// logWindow 在非-Windows 上是不承载任何窗口句柄的占位类型，Write 丢弃。
type logWindow struct{}

// startLogWindow 在非-Windows 返回 nil（无窗口），launcher 走控制台/文件通道。
func startLogWindow() *logWindow { return nil }

func (w *logWindow) Write(p []byte) (int, error) { return len(p), nil }

func (w *logWindow) show() {}

// hideConsole 在非-Windows 无对应概念。
func hideConsole() {}
