import { readApplications, readCheckupSuggestions } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read fresh report headers + ledger

// 「建议体检」供给（ADR-0041 决议 2）：镜像 /api/pipeline/urls 的懒加载模式 ——
// pipeline 普通浏览不做报告头读取；客户端只在用户进入已评估 tab 时拉一次，
// 逐行解析报告头 Legitimacy + tracker 分数并按 ADR-0025 口径过滤（score≥4.0
// 或 Block G ⚠）且台账无记录的行。纯 FS 读取，零 token。
// 返回 { [n]: true }；不满足口径的行缺席。
export async function GET() {
  const apps = readApplications();
  return Response.json(readCheckupSuggestions(apps));
}
