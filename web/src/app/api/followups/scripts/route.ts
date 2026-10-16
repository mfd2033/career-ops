import { readFollowupEntry, readFollowupScripts } from "@/lib/followups-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 「生成话术」（ADR-0080）：读 templates/followup-scripts.md 并按本行的 cadence
// entry 填占位符。只读路由 —— 复制走剪贴板，系统只生成不代发，所以这里没有
// 任何写面、不需要 followups 锁。
//
// 参数：?num=N（tracker 编号）。非数字 → 400；读不到 entry / 文件 / 解析零条
// → available:false（fail-closed，同 /api/followups 的形状），UI 据此安静收场。
export async function GET(req: Request) {
  const num = new URL(req.url).searchParams.get("num");
  if (!num || !/^\d+$/.test(num)) {
    return Response.json({ error: "num is required" }, { status: 400 });
  }
  try {
    const entry = await readFollowupEntry(num);
    return Response.json(await readFollowupScripts(entry));
  } catch {
    return Response.json({ available: false, groups: [], scripts: [] });
  }
}
