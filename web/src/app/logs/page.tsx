import fs from "node:fs";
import path from "node:path";
import { Suspense } from "react";
import { careerOpsRoot, readApplications, readStatusLog, reportsIndexOf } from "@/lib/career-ops";
import { readRunHistory } from "@/lib/run-ledger.mjs";
import { createLabelForNum, enrichEvaluateTitles } from "@/lib/run-titles.mjs";
import { readOpLog } from "@/lib/op-log-store.mjs";
import { mergeOperationLog } from "@/lib/op-log.mjs";
import { localISODate } from "@/lib/followups";
import { OperationLogView, type OpLogEntry } from "@/components/logs/operation-log-view";

export const dynamic = "force-dynamic"; // 每次都读最新的本地台账，绝不在构建期定型

// 容错读盘：缺失文件是「今天没有这类操作」，不是错误页（与 run-ledger 同口径）。
function readText(root: string, rel: string): string {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

/**
 * /logs — 近七日操作日志（手动 + 自动）。
 *
 * 四个事实源在 op-log.mjs 里合成一个形状：
 *   - .career-ops-web/op-log.jsonl：界面动作的写入链（新增/编辑/删除行、黑名单、
 *     管道增删、配置、状态变更的精确时刻），优先；
 *   - data/status-log.tsv、data/follow-ups.md：手动操作的既有台账（只有日期）；
 *   - .career-ops-web/runs/index.jsonl、data/scan-runs.tsv：自动任务的唯一事实源。
 *
 * 「今天」用 localISODate()（本地日），不是 UTC 日 —— 与 status-log 的日期口径一致，
 * 也避免东八区凌晨把今天的记录算成未来。
 */
export default function LogsPage() {
  const root = careerOpsRoot();
  const today = localISODate();

  // tracker # → 「#N 公司 · 岗位」：状态台账与跟进台账只存行号，标题要 join 才有意义。
  const trackerIndex = new Map<string, string>(
    readApplications().map((a) => [a.n, `#${a.n} ${a.company}${a.role ? ` · ${a.role}` : ""}`]),
  );

  // 评估任务的台账标题在扩展/CLI 发起时只有 `evaluate <url>`；报告 Machine Summary
  // 里的「公司 · 岗位」才是人认得出的标题。与 /api/runs/history 同一个补齐口径，
  // 台账本身不动。
  const labelForNum = createLabelForNum({ index: reportsIndexOf(), reportsDir: path.join(root, "reports") });

  const { entries, dates } = mergeOperationLog({
    opLog: readOpLog(root),
    statusLog: readStatusLog() ?? "",
    runs: enrichEvaluateTitles(readRunHistory(root, 2000), labelForNum),
    scanRuns: readText(root, "data/scan-runs.tsv"),
    followUps: readText(root, "data/follow-ups.md"),
    today,
    trackerIndex,
  });

  return (
    <Suspense>
      <OperationLogView entries={entries as OpLogEntry[]} dates={dates} today={today} />
    </Suspense>
  );
}
