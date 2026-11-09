import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCli } from "@/lib/clis";
import { canResumeSession, isValidSessionId, sessionResumeArgv } from "@/lib/cli-session.mjs";

export const runtime = "nodejs";

// POST /api/open-cli-session — 在交互终端恢复一次 headless run 的 CLI 会话
// （工作器卡片「查看 CLI 会话」按钮的后端）。
//
// fire-and-forget 契约（照抄 /api/cv-pdf/open）：detached spawn + unref，返回的
// 202 只说明「spawn 已发生」，不承诺窗口已在前台。会话 id 由服务端 init 帧捕获
// 或 opencode 反查落台账而来，前端原样带回——但这不是信任边界：id 必须过
// isValidSessionId 白名单、引擎必须在 SESSION_RESUME_ARGS 清单内，凑不出的组合
// 一律 400（argv 逐元素传 spawn 不经 shell，本无注入面；白名单是终端包装器
// 二次解析那道防线的第二把锁）。
//
// cwd 必须是仓库根（careerOpsRoot）：claude/qoder 的会话按项目目录存档，与
// headless run（/api/run 的 spawn cwd）同一目录才能恢复到同一份会话。
export async function POST(req: Request) {
  let body: { sessionId?: unknown; cliId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const cliId = typeof body.cliId === "string" ? body.cliId : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!canResumeSession(cliId)) {
    return NextResponse.json({ error: `Engine does not support session resume: ${cliId || "(none)"}` }, { status: 400 });
  }
  if (!isValidSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }
  if (process.platform !== "win32") {
    // 仅声明支持的平台：终端拉起方式（Terminal.app / xterm 变体）因机而异，
    // 不猜。本仓库的实际运行面是 Windows 托盘壳。
    return NextResponse.json({ error: `Unsupported platform: ${process.platform}` }, { status: 501 });
  }
  const resolved = await resolveCli(cliId);
  if (!resolved) {
    return NextResponse.json({ error: `Engine not installed: ${cliId}` }, { status: 409 });
  }
  const argv = sessionResumeArgv(cliId, resolved.binPath, sessionId);
  if (!argv) {
    // resolveCli 与 argv 构造之间不可能分叉（同一清单），落到这里说明清单漂移
    return NextResponse.json({ error: "Could not build resume command" }, { status: 500 });
  }
  // cmd start：新控制台窗口跑交互 TUI（TUI 常驻，直到用户退出）。第一个带引号
  // 参数是窗口标题；参数引用由 Node 的 cmd.exe 规则处理（含空格的 binPath 会被
  // 加引号）。不优先 wt：它的命令行对 `;`/引号有自己的二次解析，嵌套转义得不偿失。
  const cwd = careerOpsRoot();
  const child = spawn("cmd.exe", ["/c", "start", "career-ops session", ...argv], {
    cwd,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return NextResponse.json({ ok: true }, { status: 202 });
}
