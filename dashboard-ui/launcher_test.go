// launcher_test.go — pickFreePort 端口选择回归测试。
//
// 关键约束（与 extension/background.js 的 PORT_MIN..PORT_MAX 联动）：
// 返回端口必须落在 3000-3040 内，否则浏览器扩展探测不到 → "web 服务未运行"误报。
// 该范围内无空闲端口时必须报错，而不是回退到 OS 随机端口（范围外 = 隐形服务）。
package main

import (
	"net"
	"strconv"
	"testing"
)

// 范围测试：无论 3000 是否已被外部进程占用，返回端口必须 ∈ [3000, 3040]。
func TestPickFreePortInRange(t *testing.T) {
	port, err := pickFreePort()
	if err != nil {
		t.Fatalf("pickFreePort() unexpected error: %v", err)
	}
	if port < 3000 || port > 3040 {
		t.Fatalf("pickFreePort() = %d, want port in [3000, 3040]", port)
	}
}

// 全占测试：3000-3040 全部被监听时，必须返回错误，绝不回退随机端口。
func TestPickFreePortAllBusy(t *testing.T) {
	var listeners []net.Listener
	defer func() {
		for _, ln := range listeners {
			_ = ln.Close()
		}
	}()
	for p := 3000; p <= 3040; p++ {
		ln, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(p))
		if err != nil {
			// 端口已被外部进程占用（如正在运行的 dashboard 服务器）— 同样算"已占"，
			// 继续占剩余端口即可，不必失败。
			continue
		}
		listeners = append(listeners, ln)
	}
	port, err := pickFreePort()
	if err == nil {
		t.Fatalf("pickFreePort() = %d, nil, want error when 3000-3040 all busy", port)
	}
	if port != 0 {
		t.Fatalf("pickFreePort() = %d on error, want 0", port)
	}
}
