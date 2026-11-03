import { NextResponse } from "next/server";
import { verifyCliDir } from "@/lib/clis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ADR-0097：「这个安装目录对不对」的只读探针。
//
// 为什么需要它：把用户填的目录直接存下来再派发，一次拼写错误就变成一次静默失败
// ——`spawn ... ENOENT`，报告不落盘，用户只看到评估没反应。所以保存之前必须能问
// 一句「这个目录里到底有没有这个工具、它跑得起来吗」。
//
// 边界（ADR-0097 决议 8）：入参只有引擎 id 与目录，二进制名来自服务端的 CliSpec，
// 调用方无法借这个接口执行任意程序；目录必须是绝对路径。刻意不写任何配置——落库
// 只走配置页的统一保存（ADR-0073 决议 2）。
export async function POST(request: Request) {
  let body: { cliId?: unknown; dir?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const cliId = typeof body.cliId === "string" ? body.cliId.trim() : "";
  const dir = typeof body.dir === "string" ? body.dir : "";
  if (!cliId || !dir.trim()) {
    return NextResponse.json({ error: "cliId and dir are required" }, { status: 400 });
  }
  return NextResponse.json(verifyCliDir(cliId, dir));
}
