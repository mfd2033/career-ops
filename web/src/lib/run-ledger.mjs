// Server-side run ledger (ADR-0027 follow-up, B4-class observability fix):
// `.career-ops-web/runs/index.jsonl` — one JSON line per TERMINATED run.
//
// WHY THIS EXISTS: /jobs history lives in browser localStorage (job-store),
// populated only by UI `startJob` cards. Any run dispatched outside the UI —
// an API call, a script, another tab's discarded card — produced NO trace
// anywhere once its in-memory event bus drained: a completed (or FAILED)
// worker was unobservable, which is how a finished checkup went missing from
// the history entirely (found 2026-09-15). This ledger is the server-side
// source of truth for "what runs happened", merged into /jobs by the page.
//
// Tolerant by design: one malformed line is skipped, never fatal — a ledger
// that throws is worse than a ledger that misses a line.

import fs from "node:fs";
import path from "node:path";

export function runsLedgerPath(root) {
  return path.join(root, ".career-ops-web", "runs", "index.jsonl");
}

/** Append one terminated-run record. Fire-and-forget semantics: callers wrap
 *  in try/catch — a ledger failure must never fail the run itself. */
export function appendRunRecord(root, rec) {
  const file = runsLedgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

/**
 * 原地更新一条已落盘的台账行（按 id 匹配第一处），用于终态后的补记（如
 * opencode 会话 id 的异步反查结果）。绝不追加第二行同 id 记录：读取端
 * （ledger-merge.mjs / job-ledger-reconcile.mjs）按「首行即权威」处理，重复行
 * 会让 ledger-only 卡重复出现。找不到该 id 返回 false（调用方按无补记处理）。
 *
 * 原子替换：写临时文件后 rename，并发读者最多看到旧文件或新文件，不会读到半截。
 * @param {string} root
 * @param {string} id - 台账记录 id（= runId）
 * @param {Record<string, unknown>} patch - 合并进该记录的字段
 * @returns {boolean} 是否发生了更新
 */
export function updateRunRecord(root, id, patch) {
  const file = runsLedgerPath(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let updated = false;
  const out = text.split("\n").map((line) => {
    if (updated || !line.trim()) return line;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.id === id) {
        updated = true;
        return JSON.stringify({ ...rec, ...patch });
      }
    } catch {
      // 容错纪律（本文件头）：坏行原样保留，绝不让一次补记删别人的记录
    }
    return line;
  });
  if (!updated) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out.join("\n"));
  fs.renameSync(tmp, file);
  return true;
}

/** Read the ledger, newest first. Tolerant: skips blanks/malformed lines.
 *  @param {string} root
 *  @param {number} [limit] - max records returned (default 200). */
export function readRunHistory(root, limit = 200) {
  const file = runsLedgerPath(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      continue; // malformed line — skip, don't throw
    }
  }
  return out.reverse().slice(0, limit);
}
