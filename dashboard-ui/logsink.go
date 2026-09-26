// logsink.go — 统一日志管道（工单 01 / ADR-0066）。
//
// launcher 决策与 dashboard 服务子进程的 stdout/stderr 汇入同一条时间线，
// 逐行加 "[HH:MM:SS] [launcher|server]" 前缀，同时写控制台与磁盘文件
// careerRoot/.career-ops-web/launcher.log（gitignored 运行产物区）。
//
// 纯格式化/切分逻辑（formatLogLine、drainCompleteLines）不触 OS，可稳定单测；
// OS 侧（开文件、控制台代码页）留在 initLogSink 与平台文件。
package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// formatLogLine 渲染一行带前缀的日志。纯函数：时钟读数由调用方传入，
// 故格式在测试下确定（工单 01 AC「时间戳 + 来源标签」）。
func formatLogLine(t time.Time, source, text string) string {
	return "[" + t.Format("15:04:05") + "] [" + source + "] " + text + "\n"
}

// drainCompleteLines 按 '\n' 切出已完成行（去掉行尾 '\r'），返回行数组与
// 需继续缓冲的末尾残行。纯函数：分块到达时的跨块行边界处理靠它。
func drainCompleteLines(buf []byte) (lines []string, rest []byte) {
	for {
		i := bytes.IndexByte(buf, '\n')
		if i < 0 {
			return lines, buf
		}
		lines = append(lines, strings.TrimSuffix(string(buf[:i]), "\r"))
		buf = buf[i+1:]
	}
}

// fanout 把整行独立写到每个目标，忽略单个目标的失败——日志文件写坏时
// 控制台仍要照常滚动，不能因一处错误整条流静默。
type fanout []io.Writer

func (f fanout) Write(p []byte) (int, error) {
	for _, w := range f {
		_, _ = w.Write(p)
	}
	return len(p), nil
}

// lineSink 把整行的输出串行化到共享目的端：launcher 流与服务的 stdout、
// stderr 两条流可并发产行，但一行不会在交错中被撕裂。
type lineSink struct {
	mu   sync.Mutex
	dest io.Writer
}

func (s *lineSink) emit(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = io.WriteString(s.dest, line)
}

// prefixWriter 把原始字节流（管道分块或 log.Printf 输出）转成带来源前缀的
// 整行。每个实例持自己的残余缓冲，且只由一条 goroutine 写（服务的 stdout
// 与 stderr 各用一个实例），故缓冲无需加锁。
type prefixWriter struct {
	sink    *lineSink
	source  string
	timeFn  func() time.Time
	partial []byte
}

func (w *prefixWriter) Write(p []byte) (int, error) {
	w.partial = append(w.partial, p...)
	lines, rest := drainCompleteLines(w.partial)
	w.partial = rest
	for _, ln := range lines {
		w.sink.emit(formatLogLine(w.timeFn(), w.source, ln))
	}
	return len(p), nil
}

// newPrefixWriter 是构造 launcher/服务流的简写，时钟固定用 time.Now。
func newPrefixWriter(sink *lineSink, source string) *prefixWriter {
	return &prefixWriter{sink: sink, source: source, timeFn: time.Now}
}

// initLogSink 按「launcher 进程启动即重置」的语义以 O_TRUNC 打开日志文件，
// 返回行汇聚器与文件路径。extra 是除控制台与文件外的额外目的地（工单 02 的
// 自持日志窗口 writer，可为 nil）。careerRoot/.career-ops-web 是 gitignored
// 运行产物区。文件/目录创建失败时降级为「仅控制台/窗口」而非让 launcher 起不来。
func initLogSink(careerRoot string, extra io.Writer) (sink *lineSink, logPath string) {
	writers := []io.Writer{os.Stdout}
	if extra != nil {
		writers = append(writers, extra)
	}
	logPath = filepath.Join(careerRoot, ".career-ops-web", "launcher.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err == nil {
		if f, ferr := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND|os.O_TRUNC, 0o644); ferr == nil {
			writers = append(writers, f)
		}
	}
	return &lineSink{dest: fanout(writers)}, logPath
}
