//go:build windows

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/windows"
)

// attachParentConsole 让 GUI 子系统的 launcher 在「从终端/脚本启动」时仍写 stdout：
// 附加父进程已有的控制台，把无句柄的 stdout/stderr 重开到 CONOUT$，并切 UTF-8 代码页
// （服务日志多为 UTF-8 字节，不改会被 GBK 控制台误读）。双击启动时父进程没有控制台，
// 附加失败即静默返回——不新建控制台，这正是「无控制台窗口」的治本之策（修订 2 决议 7）。
var (
	kernel32SetConsoleOutputCP = windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleOutputCP")
	pAttachConsole             = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")
)

const attachParentProcess = 0xFFFFFFFF // (DWORD)-1：附加到父进程的控制台

func attachParentConsole() {
	attached := attachConsoleToParent()
	if shouldReopenConsole(stdioHandleValid(os.Stdout), attached) {
		reopenStdHandles()
	}
	if attached {
		_, _, _ = kernel32SetConsoleOutputCP.Call(65001) // CP_UTF8
	}
}

// attachConsoleToParent 附加到父进程控制台。进程本就持有控制台时 Windows 报
// ERROR_ACCESS_DENIED，同样视为「有控制台可用」。
func attachConsoleToParent() bool {
	ok, _, _ := pAttachConsole.Call(attachParentProcess)
	return ok != 0
}

// stdioHandleValid 判断流是否已有有效句柄（例如调用方做了 `> file` / 管道重定向）。
func stdioHandleValid(f *os.File) bool {
	if f == nil {
		return false
	}
	_, err := f.Stat()
	return err == nil
}

// reopenStdHandles 把标准流重新指向当前控制台的设备名。
func reopenStdHandles() {
	if out, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout, os.Stderr = out, out
	}
	if in, err := os.OpenFile("CONIN$", os.O_RDONLY, 0); err == nil {
		os.Stdin = in
	}
}

// listenerPID returns the PID owning a LISTEN socket on port and its image name
// (best-effort "", if it can't be resolved). Returns 0, "" when nothing listens.
// Parses `netstat -ano -p TCP` — dependency-free, the same tool start-web.cmd and
// the old KillServerForPort relied on.
func listenerPID(port int) (int, string) {
	out, err := exec.Command("netstat", "-ano", "-p", "TCP").Output()
	if err != nil {
		return 0, ""
	}
	suffix := ":" + strconv.Itoa(port)
	for _, line := range strings.Split(string(out), "\n") {
		// Columns: Proto  Local Address  Foreign Address  State  PID
		f := strings.Fields(line)
		if len(f) < 5 || !strings.EqualFold(f[3], "LISTENING") {
			continue
		}
		if !strings.HasSuffix(f[1], suffix) {
			continue
		}
		pid, err := strconv.Atoi(f[4])
		if err != nil || pid <= 0 {
			continue
		}
		return pid, processImageName(pid)
	}
	return 0, ""
}

// processImageName resolves a PID to its executable name for the error dialog.
// Best-effort: any failure returns "" (the PID alone is still actionable).
func processImageName(pid int) string {
	out, err := exec.Command("tasklist", "/FI", "PID eq "+strconv.Itoa(pid), "/NH").Output()
	if err != nil {
		return ""
	}
	f := strings.Fields(string(out))
	if len(f) > 0 {
		return f[0]
	}
	return ""
}

// killProcessTree force-terminates pid and its child processes (the server may
// have spawned node children), matching start-web.cmd's taskkill /T /F semantics
// — it targets whatever owns the port, not only node (ADR-0063).
func killProcessTree(pid int) error {
	return exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F").Run()
}

// startServer launches the dashboard server process hidden from the console
// (this exe is a GUI app with no console window). The child's stdout/stderr are
// wired to per-stream prefix writers (工单 01 / ADR-0066) so服务输出不再进 NUL，
// 而是实时汇入统一时间线（控制台 + launcher.log）。stdout 与 stderr 各用一个
// prefixWriter 实例（各自持有缓冲），避免两条流交错撞碎行。
func startServer(nodePath, serverDir, careerRoot string, port int, sink *lineSink) *exec.Cmd {
	cmd := exec.Command(nodePath, "server.js")
	cmd.Dir = serverDir
	cmd.Env = append(os.Environ(),
		"CAREER_OPS_ROOT="+careerRoot,
		"PORT="+strconv.Itoa(port),
		// Bind address, not an access URL: keep the IPv4 loopback literal. Windows
		// resolves localhost to ::1 first, so HOSTNAME=localhost would bind the
		// wrong stack. Everything user-facing opens http://localhost:<port> instead
		// (clients fall back to 127.0.0.1), see the openBrowser call sites in launcher.go.
		"HOSTNAME=127.0.0.1",
	)
	cmd.Stdout = newPrefixWriter(sink, "server")
	cmd.Stderr = newPrefixWriter(sink, "server")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	if err := cmd.Start(); err != nil {
		fatal("failed to start the dashboard server: " + err.Error())
		return nil
	}
	return cmd
}
