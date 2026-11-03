import { NextResponse } from "next/server";
import { pickDirectory } from "@/lib/pick-dir.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ADR-0097 决议 9：点一下选目录，而不是让用户去资源管理器复制路径再粘回来。
//
// 为什么是 POST 到本地服务：浏览器拿不到盘符（`showDirectoryPicker()` 只给句柄，
// `<input webkitdirectory>` 只给相对路径），能给绝对路径的对话框只存在于本机进程里。
// 服务本来就跑在用户的桌面会话，它弹的框和资源管理器是同一个。
//
// 边界：无入参（可选 `start` 只用于对话框的初始位置），无副作用（不读配置、不写配置、
// 不碰 `cliDirs`）；选择的目录能否用仍由 `/api/clis/verify` 回答，落库仍走配置页
// 的统一保存（ADR-0073 决议 2）。同源守卫由 `src/proxy.ts` 统一把关，本路由不额外开面。
export async function POST(request: Request) {
  let body: { start?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // 起始目录是可选的：没有 body 也照样能弹框。
  }
  const start = typeof body?.start === "string" ? body.start : "";
  return NextResponse.json(await pickDirectory.pick({ start }));
}
