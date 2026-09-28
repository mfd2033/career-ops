//go:build windows

// logwindow_windows_test.go — 自持日志窗口的行为回归（ADR-0066 修订 2 / 工单 02）。
//
// 为什么能在单测里建真窗口：自持窗口本来就是本进程的 Win32 窗口，测试进程与
// launcher 走同一份代码，断言只看窗口状态位（可见性、showCmd），不依赖截图或
// 人工目视；窗口以隐藏态创建，测试进程退出即随之消失，不会在桌面留下什么东西。
package main

import (
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	pTestIsWindowVisible    = user32.NewProc("IsWindowVisible")
	pTestGetWindowPlacement = user32.NewProc("GetWindowPlacement")
	pPostMessageWTest       = user32.NewProc("PostMessageW")
)

const (
	swNormal   = 1 // SW_SHOWNORMAL / 还原态（GetWindowPlacement 的 showCmd）
	swMinimize = 6 // SW_MINIMIZE：ShowWindow 的命令值
)

// isMinimizedPlacement 判定 GetWindowPlacement 的最小化态：2=SW_SHOWMINIMIZED、
// 7=SW_SHOWMINNOACTIVE（命令值 6 不会被回读，回读的是这两种之一）。
func isMinimizedPlacement(showCmd uint32) bool { return showCmd == 2 || showCmd == 7 }

// testWindowPlacement 按 x64 布局取 showCmd（offset 8）。
type testWindowPlacement struct {
	length  uint32
	flags   uint32
	showCmd uint32
	rest    [32]byte
}

func testWindowShowCmd(hwnd windows.HWND) uint32 {
	var wp testWindowPlacement
	wp.length = uint32(unsafe.Sizeof(wp))
	pTestGetWindowPlacement.Call(uintptr(hwnd), uintptr(unsafe.Pointer(&wp)))
	return wp.showCmd
}

func testWindowVisible(hwnd windows.HWND) bool {
	r, _, _ := pTestIsWindowVisible.Call(uintptr(hwnd))
	return r != 0
}

// waitForState 轮询窗口状态：ShowWindow 引起的状态变化经窗口线程消息泵生效，
// 需要给它一次泵的机会（确定性轮询，非固定 sleep）。
func waitForState(t *testing.T, what string, hwnd windows.HWND, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("等待窗口状态超时：%s（visible=%v showCmd=%d）",
		what, testWindowVisible(hwnd), testWindowShowCmd(hwnd))
}

// logWindowForTest 建一次窗口供全部用例共用（窗口是进程级单例，重复建会互相干扰）。
var logWindowForTest = func() *logWindow {
	if startLogWindow() == nil {
		return nil
	}
	return activeLogWindow
}()

func requireLogWindow(t *testing.T) *logWindow {
	t.Helper()
	if logWindowForTest == nil || logWindowForTest.top == 0 {
		t.Fatal("自持日志窗口创建失败，后续断言无从谈起")
	}
	return logWindowForTest
}

// 修订 2 决议 8：启动不弹窗口——创建后必须是隐藏态（回归：原先创建即 SW_SHOW）。
func TestLogWindowStartsHidden(t *testing.T) {
	lw := requireLogWindow(t)
	if testWindowVisible(lw.top) {
		t.Fatal("日志窗口创建后即可见——应为隐藏态（静默启动），托盘唤回才显示")
	}
}

// 托盘唤回必须覆盖三种状态：从未显示过、点过 ×（隐藏）、被最小化。
// 回归点：原实现用 SW_SHOW（以当前状态显示），窗口最小化后唤回只剩任务栏闪烁。
func TestTrayShowRevealsHiddenAndRestoresMinimized(t *testing.T) {
	lw := requireLogWindow(t)

	// ① 首次唤回：隐藏 → 可见且非最小化
	lw.show()
	waitForState(t, "首次唤回后应可见且非最小化", lw.top, func() bool {
		return testWindowVisible(lw.top) && testWindowShowCmd(lw.top) == swNormal
	})

	// ② 最小化后再唤回：必须还原成正常态，而不是停在最小化
	pShowWindowLog.Call(uintptr(lw.top), swMinimize)
	waitForState(t, "应进入最小化态", lw.top, func() bool {
		return isMinimizedPlacement(testWindowShowCmd(lw.top))
	})
	lw.show()
	waitForState(t, "最小化后唤回应还原为正常态（SW_RESTORE）", lw.top, func() bool {
		return testWindowVisible(lw.top) && testWindowShowCmd(lw.top) == swNormal
	})

	// ③ 点 ×（WM_CLOSE → 仅隐藏）后再唤回：内容仍在、窗口重现
	pPostMessageWTest.Call(uintptr(lw.top), wmClose, 0, 0)
	waitForState(t, "点 × 后应隐藏", lw.top, func() bool {
		return !testWindowVisible(lw.top)
	})
	lw.show()
	waitForState(t, "隐藏后唤回应重新可见", lw.top, func() bool {
		return testWindowVisible(lw.top) && testWindowShowCmd(lw.top) == swNormal
	})
}
