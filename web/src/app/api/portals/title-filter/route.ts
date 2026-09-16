import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { upsertYamlList, normalizeWordList } from "@/lib/core/portals-merge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 探索页规则牌的写回口（gate-visibility 工单 03）。
//
// 与 /api/portals 的差别是语义不是风格：那个口服务 assistant 的 setPortals，只把角色
// 关键词**并进**词表（用户手写的条目是决策，不能被自动化冲掉）；这个口是**编辑**，面板
// 交上来的一对列表就是答案——删一个词必须真的能删掉，所以两个块都是 replace。
//
// 写入走与工单 02 同一条文本级手术（lib/core/portals-merge.mjs）：portals.yml 的注释是
// 词表的理由（哪类词刻意不加、为什么），yaml 往返会把它整份删掉，所以这里不往返。
//
// 校验在纯函数里，返回 null 而不是 []：`[]` 是合法指令（这一侧清空），把「字段缺失／
// 类型不对」也读成 [] 就会因为一个畸形请求删掉用户整张表。所以畸形就拒，不猜。
export async function POST(req: Request) {
  let body: { positive?: unknown; negative?: unknown };
  try {
    body = (await req.json()) as { positive?: unknown; negative?: unknown };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const positive = normalizeWordList(body.positive);
  const negative = normalizeWordList(body.negative);
  if (!positive || !negative) return Response.json({ error: "invalid word list" }, { status: 400 });

  const file = path.join(careerOpsRoot(), "portals.yml");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return Response.json({ error: "portals.yml not found" }, { status: 404 });
  }

  let next = upsertYamlList(text, ["title_filter", "positive"], positive, { mode: "replace" }).text;
  next = upsertYamlList(next, ["title_filter", "negative"], negative, { mode: "replace" }).text;

  if (next !== text) {
    try {
      atomicWriteWithBackup(file, next);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
    }
  }
  return Response.json({ ok: true, changed: next !== text, positive: positive.length, negative: negative.length });
}
