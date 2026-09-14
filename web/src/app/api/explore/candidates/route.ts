import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readInbox, readApplications } from "@/lib/career-ops";
import { normalizeUrl } from "@/lib/core/url-key.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 候选恢复（ADR-0021）：「近期采集、未入管」的发现，从「见过」台账（scan-history.tsv）
// 重建为探索页结果区的 offer —— scan-history 是未确认候选的持久层，关页/重开不丢。
//
// 口径：
//   • 「未入管」= 规范 URL 不在 pipeline.md 的任何行里（**含 done 行**：Processed 的
//     职位已处理，不是候选），也不在 tracker 的 URL 列里（已评估更不是候选）；
//   • 「近期」= first_seen 在最近 N 天（默认 7，上限 30）；
//   • status 为 skipped/expired 的行仍然剔除（它们是明确的丢弃信号）；
//   • 同 URL 多行取最早一行（first_seen 语义），浏览器板块的重复行已被 2026-09-14
//     的清理折叠。
// 已知缺口（ADR-0021 已记录）：scan-history 无薪资列，恢复出的卡片薪资显示「未知」。
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const days = Math.min(30, Math.max(1, Number(sp.get("days")) || 7));
  const limit = Math.min(2000, Math.max(1, Number(sp.get("limit")) || 500));
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const root = careerOpsRoot();
  // 已处理/已追踪的规范键集合：pipeline 的全部行（pending + done/Processed）∪
  // tracker 的 URL 列。少了它们，已评估的职位会被当成「未入管候选」重新端上来。
  const handled = new Set<string>(
    [
      ...readInbox().map((j) => normalizeUrl(j.url)),
      ...readApplications().map((a) => normalizeUrl(a.url)),
    ].filter(Boolean),
  );

  let text = "";
  try {
    text = fs.readFileSync(path.join(root, "data", "scan-history.tsv"), "utf8");
  } catch {
    return Response.json({ offers: [], count: 0 });
  }

  // 同 URL 多行取最早一行（first_seen 语义）；Map 保序 → 后续排序稳定。
  const byKey = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("url\t")) continue;
    const c = line.split("\t");
    const key = normalizeUrl(c[0]);
    if (!key || handled.has(key)) continue;
    const firstSeen = /^\d{4}-\d{2}-\d{2}$/.test(c[1] ?? "") ? c[1] : "";
    if (!firstSeen || firstSeen < cutoff) continue;
    const status = (c[5] ?? "").toLowerCase();
    if (/skipped|expired/.test(status)) continue;
    const prev = byKey.get(key);
    if (!prev || firstSeen < prev[1]) byKey.set(key, c);
  }

  const offers = [...byKey.values()]
    .sort((a, b) => (b[1] || "").localeCompare(a[1] || ""))
    .slice(0, limit)
    .map((c) => ({
      url: c[0],
      company: (c[4] || "").trim(),
      title: (c[3] || "").trim(),
      location: (c[6] || "").trim(),
      postedAt: c[1] || "",
      ats: (c[2] || "").replace(/-full$/, "").trim() || "other",
      source: "explore-restore",
    }));

  return Response.json({ offers, count: offers.length });
}
