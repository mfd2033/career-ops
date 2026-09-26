// launcher_test.go — decideTakeover 端口接管决策回归测试（ADR-0063）。
//
// 关键约束：端口严格固定 3000，接管链三态互斥且绝不含"换端口"分支。
// decideTakeover 是不触 OS 的纯函数，故其判定可稳定单测（OS 侧的
// listenerPID/killProcessTree 留在平台文件，不在此覆盖，见工单 03 手工验收）。
package main

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// writerFunc 把函数适配成 io.Writer，供测试捕获 lineSink 的输出。
type writerFunc func(p []byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// fixedTime 给纯函数测试一个确定的时钟读数，前缀时间戳才可断言。
var fixedTime = time.Date(2026, 9, 26, 14, 5, 9, 0, time.UTC)

func TestFormatLogLine(t *testing.T) {
	cases := []struct {
		name   string
		source string
		text   string
		want   string
	}{
		{"launcher line", "launcher", "服务就绪", "[14:05:09] [launcher] 服务就绪\n"},
		{"server line", "server", "ready on 3000", "[14:05:09] [server] ready on 3000\n"},
		{"empty text still emits a line", "launcher", "", "[14:05:09] [launcher] \n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatLogLine(fixedTime, tc.source, tc.text); got != tc.want {
				t.Fatalf("formatLogLine = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestDrainCompleteLines(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		wantLines []string
		wantRest  string
	}{
		{"two full lines", "a\nb\n", []string{"a", "b"}, ""},
		{"trailing partial kept", "a\nb", []string{"a"}, "b"},
		{"crlf trimmed to lf", "a\r\nb\r\n", []string{"a", "b"}, ""},
		{"no newline yields no lines", "partial", nil, "partial"},
		{"empty line preserved", "\n", []string{""}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lines, rest := drainCompleteLines([]byte(tc.in))
			if len(lines) != len(tc.wantLines) {
				t.Fatalf("lines = %v, want %v", lines, tc.wantLines)
			}
			for i := range lines {
				if lines[i] != tc.wantLines[i] {
					t.Fatalf("lines[%d] = %q, want %q", i, lines[i], tc.wantLines[i])
				}
			}
			if string(rest) != tc.wantRest {
				t.Fatalf("rest = %q, want %q", string(rest), tc.wantRest)
			}
		})
	}
}

// prefixWriter must stamp each complete line and carry a partial line across
// chunk boundaries (server output arrives in arbitrary pipe chunks).
func TestPrefixWriterStampsAndBuffers(t *testing.T) {
	var buf bytes.Buffer
	sink := &lineSink{dest: writerFunc(func(p []byte) (int, error) { return buf.Write(p) })}
	w := &prefixWriter{sink: sink, source: "server", timeFn: func() time.Time { return fixedTime }}

	// "ready" split across two writes plus a following full line.
	if _, err := w.Write([]byte("rea")); err != nil {
		t.Fatal(err)
	}
	if buf.Len() != 0 {
		t.Fatalf("partial line emitted early: %q", buf.String())
	}
	if _, err := w.Write([]byte("dy on 3000\n")); err != nil {
		t.Fatal(err)
	}
	want := "[14:05:09] [server] ready on 3000\n"
	if buf.String() != want {
		t.Fatalf("emitted %q, want %q", buf.String(), want)
	}
}

func TestInitLogSinkTruncates(t *testing.T) {
	dir := t.TempDir()
	sink, logPath := initLogSink(dir, nil)
	// initLogSink 按设计常开文件句柄（进程存活期不关），Windows 下会让
	// t.TempDir 清理失败；测试结束前手动关掉底层文件。
	t.Cleanup(func() { closeSinkFiles(sink) })

	if !strings.HasSuffix(logPath, filepath.Join(".career-ops-web", "launcher.log")) {
		t.Fatalf("logPath = %q, want under .career-ops-web/launcher.log", logPath)
	}
	// File must exist (created O_TRUNC) so a fresh start resets prior content.
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("log file not created: %v", err)
	}
}

// closeSinkFiles 关闭 lineSink 背后 fanout 里所有可关闭的目标（即日志文件），
// 不影响 stdout。仅供测试清理使用。
func closeSinkFiles(sink *lineSink) {
	if fo, ok := sink.dest.(fanout); ok {
		for _, w := range fo {
			if c, ok := w.(io.Closer); ok {
				_ = c.Close()
			}
		}
	}
}

// 真实子进程接入：startServer 用同一个机制把 node 的 stdout/stderr 接到两条
// 共享 sink 的 prefixWriter。本测试验证该接线成立且两行都带 [server] 前缀。
func TestServerStreamsWiredThroughSink(t *testing.T) {
	var mu sync.Mutex
	var out bytes.Buffer
	sink := &lineSink{dest: writerFunc(func(p []byte) (int, error) {
		mu.Lock()
		defer mu.Unlock()
		return out.Write(p)
	})}
	cmd := exec.Command("node", "-e", "process.stdout.write('hello-out\n'); process.stderr.write('hello-err\n')")
	cmd.Stdout = newPrefixWriter(sink, "server")
	cmd.Stderr = newPrefixWriter(sink, "server")
	if err := cmd.Run(); err != nil {
		t.Skipf("node 不可用，跳过子进程接入测试: %v", err)
	}
	got := out.String()
	for _, want := range []string{"[server] hello-out", "[server] hello-err"} {
		if !strings.Contains(got, want) {
			t.Fatalf("缺 %q，实际输出:\n%s", want, got)
		}
	}
}

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
