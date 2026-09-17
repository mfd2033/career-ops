// POST /api/checkup-request — 「体检这家」按钮的前置校验（ADR-0027，重复与替换语义见 ADR-0033）。
//
// The button dispatches a WORKER (kind=checkup) that runs the checkup
// immediately through the global concurrency pool. This route is the
// pre-flight, and it is the ONLY gate (ADR-0026 决议 5「后端设防」；/api/run 不带守卫):
//   - 目标解析：`?` 行 → 报告 Via 的招聘主体；Via 缺失 → 400（前端据此禁用按钮）。
//   - 无在跑          → 200 {ok}，前端随后 startJob。
//   - 有在跑、未带 replace → 409 {running:[{runId,state,startedAt}]}：前端就地展开面板，
//                        用户裁决「停止」（拿 runId 调 /api/run/cancel）或替换。
//   - 带 replace: true  → 先停掉同 tracker# 全部在跑体检，等它们真的不在，再 200
//                        {ok, replaced[, unconfirmed]}（ADR-0033 决议 3/6）。
//
// 同日去重（ADR-0027 决议 4）已废止：agent-inbox 只是审计轨迹，不再是闸门——按「当天」
// 拦会把「当天首次失败就再也重试不了」写死，而真正该拦的「这一行正在体检」它又拦不住。
//
// 纯判定住 @/lib/checkup-request.mjs（node --test 锁定）；本路由是传输层，按仓库惯例
// 不测（同 /api/status、/api/tracker/delete）。
import { findCheckupTarget } from "@/lib/career-ops";
import { decideCheckupPreflight, checkupReplaceBody } from "@/lib/checkup-request.mjs";
import { listLiveCheckups, awaitCheckupGone } from "@/lib/checkup-live.mjs";
import { cancelRun } from "@/lib/core/run-events";

export const runtime = "nodejs";

/** 替换路径等旧进程退出的上限（ADR-0033 决议 6）：超时不阻断，但如实标 unconfirmed。 */
const REPLACE_WAIT_MS = 5000;

export async function POST(req: Request) {
  let body: { n?: string | number; replace?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const n = String(body.n ?? "").trim();
  if (!/^\d+$/.test(n)) {
    return Response.json({ error: "a numeric application number is required" }, { status: 400 });
  }

  const target = findCheckupTarget(n);
  if (!target.ok) {
    return Response.json({ error: target.reason }, { status: target.reason === "row-not-found" ? 404 : 400 });
  }
  const meta = { company: target.company, target: target.source };

  const decision = decideCheckupPreflight({ live: listLiveCheckups(n), replace: body.replace });

  if (decision.action === "dispatch") {
    return Response.json({ ok: true, ...meta });
  }

  if (decision.action === "blocked") {
    // 在跑：把在跑条目的 runId 一并给出 —— 「停止」靠它调 /api/run/cancel，跨标签页/
    // 跨浏览器也成立（那时本页并没有那张工作器卡片，也没有它的 job id）。
    return Response.json({ running: decision.running, ...meta }, { status: 409 });
  }

  // replace：先起等死（此刻条目仍在在跑列表里），再取消，最后收等待结果。顺序不是必需的
  // （登记表对「已终态但未确认死掉」的条目留有墓碑），但先起等死更直白。
  const runIds = decision.running.map((r) => r.runId);
  const waits = runIds.map((id) => awaitCheckupGone(n, id, REPLACE_WAIT_MS));
  const cancelled = runIds.map((id) => cancelRun(id));
  const outcomes = await Promise.all(waits);
  // 只把真的发出取消的那几条列进 replaced：ran 已自行结束的（cancelRun false）不算替换。
  const replaced = runIds.filter((_, i) => cancelled[i]);
  return Response.json({ ...checkupReplaceBody({ replaced, outcomes }), ...meta });
}
