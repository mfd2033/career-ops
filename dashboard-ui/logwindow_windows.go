//go:build windows

// logwindow_windows.go — launcher 自持的 Win32 日志窗口（工单 02 / ADR-0066 修订）。
//
// 为什么自持窗口而非复用 conhost 控制台：Win10/11 的控制台窗口归独立进程
// conhost.exe 托管，本进程无法跨进程给它 subclass WM_CLOSE，SetConsoleCtrlHandler
// 也拦不住关闭终止——「关窗即隐藏」在 conhost 窗口上做不到。于是隐藏 conhost 控制台，
// 自建一个属于自己的只读多行编辑框窗口，WM_CLOSE 由自有 WndProc 处理成「仅隐藏」。
//
// 该窗口是 logsink 汇聚流的一个目的地（io.Writer）：Write 把整行 SendMessage 进编辑框。
// 编辑框有历史文本长度上限（约 64K Unicode 字符），触顶后不再滚动追加，但
// .career-ops-web/launcher.log 始终保留全量——窗口是实时看板，文件才是真相源。
package main

import (
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	kernel32Log             = windows.NewLazySystemDLL("kernel32.dll")
	pRegisterClassExW       = user32.NewProc("RegisterClassExW")
	pCreateWindowExW        = user32.NewProc("CreateWindowExW")
	pDefWindowProcW         = user32.NewProc("DefWindowProcW")
	pShowWindowLog          = user32.NewProc("ShowWindow")
	pUpdateWindow           = user32.NewProc("UpdateWindow")
	pGetMessageW            = user32.NewProc("GetMessageW")
	pTranslateMessageLog    = user32.NewProc("TranslateMessage")
	pDispatchMessageW       = user32.NewProc("DispatchMessageW")
	pSendMessageW           = user32.NewProc("SendMessageW")
	pLoadCursorW            = user32.NewProc("LoadCursorW")
	pPostQuitMessage        = user32.NewProc("PostQuitMessage")
	pSetForegroundWindowLog = user32.NewProc("SetForegroundWindow")
	pGetConsoleWindow       = kernel32Log.NewProc("GetConsoleWindow")
	pGetModuleHandleW       = kernel32Log.NewProc("GetModuleHandleW")
)

const (
	wmClose   = 0x0010
	wmDestroy = 0x0002

	emSetSel      = 0x00B1
	emReplaceSel  = 0x00C2
	emScrollCaret = 0x00B7

	wsOverlappedWindow = 0x00CF0000
	wsVisible          = 0x10000000
	wsChild            = 0x40000000
	wsVScroll          = 0x00200000
	wsExClientEdge     = 0x00000200
	esMultiline        = 0x00000004
	esAutoVScroll      = 0x00000040
	esReadOnly         = 0x00000800

	swHide = 0
	swShow = 5

	idcArrow         = 3251
	colorWindowBrush = 5 + 1 // (COLOR_WINDOW+1) as HBRUSH
	csHRedrawVRedraw = 0x0002 | 0x0001
	cwUseDefault     = 0x80000000

	logWinClass = "CopsDashboardLogWindow"
)

// logWindow 是 launcher 自持的日志窗口，实现 io.Writer 作为汇聚流的一个目的地。
// Write 加锁串行化到 SendMessage，保证多来源整行不交错、顺序稳定。
type logWindow struct {
	top  windows.HWND
	edit windows.HWND
	mu   sync.Mutex
}

var logWndProcCallback = syscall.NewCallback(logWndProc)

// logWndProc 是顶层窗口的窗口过程：WM_CLOSE 改为「仅隐藏」，不 DestroyWindow，
// 于是点 × 既不退出 launcher 也不影响服务。
func logWndProc(hwnd, msg, wParam, lParam uintptr) uintptr {
	switch msg {
	case wmClose:
		pShowWindowLog.Call(hwnd, swHide)
		return 0
	case wmDestroy:
		pPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := pDefWindowProcW.Call(hwnd, msg, wParam, lParam)
	return ret
}

// startLogWindow 注册类、创建顶层窗口 + 只读多行编辑框，在专属锁定 OS 线程上
// 起消息泵，返回立即可写的 writer。创建失败返回 nil，launcher 据此降级保留
// conhost 控制台可见——可观测性建不起来时不能把服务/启动一起拖死。
func startLogWindow() *logWindow {
	ready := make(chan *logWindow, 1)
	go func() {
		runtime.LockOSThread() // 窗口与消息循环须固定同一 OS 线程

		className, _ := windows.UTF16PtrFromString(logWinClass)
		windowTitle, _ := windows.UTF16PtrFromString("career-ops 仪表盘运行日志")
		editClass, _ := windows.UTF16PtrFromString("EDIT")

		hInst, _, _ := pGetModuleHandleW.Call(0)
		hCursor, _, _ := pLoadCursorW.Call(0, idcArrow)

		wc := wndclassex{
			cbSize:        uint32(unsafe.Sizeof(wndclassex{})),
			style:         csHRedrawVRedraw,
			lpfnWndProc:   logWndProcCallback,
			hInstance:     windows.Handle(hInst),
			hCursor:       windows.Handle(hCursor),
			hbrBackground: windows.Handle(colorWindowBrush),
			lpszClassName: className,
		}
		pRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))

		top, _, _ := pCreateWindowExW.Call(
			0,
			uintptr(unsafe.Pointer(className)),
			uintptr(unsafe.Pointer(windowTitle)),
			wsOverlappedWindow,
			cwUseDefault, cwUseDefault, 960, 620,
			0, 0, hInst, 0,
		)
		if top == 0 {
			ready <- nil
			return
		}
		edit, _, _ := pCreateWindowExW.Call(
			wsExClientEdge,
			uintptr(unsafe.Pointer(editClass)),
			0,
			wsChild|wsVisible|wsVScroll|esMultiline|esAutoVScroll|esReadOnly,
			0, 0, 944, 586,
			top, 0, hInst, 0,
		)
		lw := &logWindow{top: windows.HWND(top), edit: windows.HWND(edit)}
		pShowWindowLog.Call(top, swShow)
		pUpdateWindow.Call(top)
		ready <- lw

		var msg winmsg
		for {
			r, _, _ := pGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if int32(r) == 0 { // WM_QUIT
				break
			}
			pTranslateMessageLog.Call(uintptr(unsafe.Pointer(&msg)))
			pDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
		}
	}()

	lw := <-ready
	activeLogWindow = lw
	if lw != nil {
		hideConsole() // 窗口建起来了才隐掉多余的 conhost 控制台
	}
	return lw
}

// Write 把一行（含换行）追加到编辑框末尾。nil 接收者安全：窗口创建失败时
// sink 仍会带着这个 nil writer 写日志，忽略即可（stdout+文件仍在）。
func (w *logWindow) Write(p []byte) (int, error) {
	if w == nil || w.edit == 0 {
		return len(p), nil
	}
	ptr, err := windows.UTF16PtrFromString(strings.ReplaceAll(string(p), "\x00", " "))
	if err != nil {
		return len(p), nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	end := ^uintptr(0) // (UINT)-1：把选区挪到文末
	pSendMessageW.Call(uintptr(w.edit), emSetSel, end, end)
	pSendMessageW.Call(uintptr(w.edit), emReplaceSel, 1, uintptr(unsafe.Pointer(ptr)))
	pSendMessageW.Call(uintptr(w.edit), emScrollCaret, 0, 0)
	return len(p), nil
}

// show 唤回窗口并置顶（托盘「显示日志窗口」动作）。
func (w *logWindow) show() {
	if w == nil || w.top == 0 {
		return
	}
	pShowWindowLog.Call(uintptr(w.top), swShow)
	pSetForegroundWindowLog.Call(uintptr(w.top))
}

// hideConsole 隐藏 conhost 托管的控制台窗口（日志改由自持窗口呈现）。
func hideConsole() {
	h, _, _ := pGetConsoleWindow.Call()
	if h != 0 {
		pShowWindowLog.Call(h, swHide)
	}
}

// 本模块依赖的 x/sys/windows 版本未导出 WNDCLASSEXW/MSG，故按 x64 内存布局
// 本地定义（字段顺序与对齐须与 C 一致：uintptr 为 8 字节、紧跟在两个 int32 后
// 的指针自然对齐到 8 的倍数，与 C 结构体偏移吻合）。
type wndclassex struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     windows.Handle
	hIcon         windows.Handle
	hCursor       windows.Handle
	hbrBackground windows.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       windows.Handle
}

type winmsg struct {
	hwnd    windows.HWND
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	ptX     int32
	ptY     int32
}
