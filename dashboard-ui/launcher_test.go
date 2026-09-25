// launcher_test.go — decideTakeover 端口接管决策回归测试（ADR-0063）。
//
// 关键约束：端口严格固定 3000，接管链三态互斥且绝不含"换端口"分支。
// decideTakeover 是不触 OS 的纯函数，故其判定可稳定单测（OS 侧的
// listenerPID/killProcessTree 留在平台文件，不在此覆盖，见工单 03 手工验收）。
package main

import "testing"

func TestDecideTakeover(t *testing.T) {
	cases := []struct {
		name        string
		probeOK     bool
		listenerPID int
		want        takeoverAction
	}{
		{"live web is reused even though it owns the port", true, 4321, actionReuse},
		{"free port starts fresh", false, 0, actionStartFresh},
		{"non-answering squatter is killed then started", false, 9001, actionKillThenStart},
		{"probe wins over listener when both true", true, 0, actionReuse},
		{"negative pid treated as free (defensive)", false, -1, actionStartFresh},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decideTakeover(tc.probeOK, tc.listenerPID); got != tc.want {
				t.Fatalf("decideTakeover(%v, %d) = %d, want %d", tc.probeOK, tc.listenerPID, got, tc.want)
			}
		})
	}
}

// The pinned port must never drift: browserURL always points at 3000.
func TestBrowserURLPinnedTo3000(t *testing.T) {
	if got := browserURL(); got != "http://localhost:3000" {
		t.Fatalf("browserURL() = %q, want %q", got, "http://localhost:3000")
	}
	if webPort != 3000 {
		t.Fatalf("webPort = %d, want 3000 (ADR-0063 pins it)", webPort)
	}
}
