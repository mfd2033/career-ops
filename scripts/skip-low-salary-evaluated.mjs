#!/usr/bin/env node
/**
 * One-off: mark EVALUATED tracker rows as SKIP based on a salary-cap + score
 * criterion — mirroring the pipeline page's "已评估" tab + ADR-0037 报告薪资
 * column (same parse path: report Machine Summary `advertised_comp`).
 *
 *   node scripts/skip-low-salary-evaluated.mjs                 # dry-run preview
 *   node scripts/skip-low-salary-evaluated.mjs --apply         # actually write
 *   node scripts/skip-low-salary-evaluated.mjs --max-k 25 --max-score 3
 *
 * Criterion: a row qualifies when its advertised monthly K range's UPPER BOUND
 * is < --max-k (整段低于) AND its tracker score (scoreNum) is < --max-score.
 * Rows whose salary is undisclosed, or whose score is empty/unparsable, are NOT
 * marked (don't guess). Only EVALUATED rows are considered (already-SKIP etc.
 * are left alone).
 *
 * Each write goes through the canonical set-status.mjs (state validation, lock,
 * status-log ledger) — never edits the tracker directly.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseApplications } from "../web/src/lib/tracker-table.mjs";
import { canonStatus } from "../web/src/lib/status-alias.mjs";
import { scoreNum } from "../web/src/lib/score-num.mjs";
import { extractAdvertisedComp, parseReportSalary } from "../web/src/lib/report-salary.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const APPS_FILE = path.join(ROOT, "data", "applications.md");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const MAX_K = Number(args.find((a) => a.startsWith("--max-k="))?.split("=")[1] ?? 25);
const MAX_SCORE = Number(args.find((a) => a.startsWith("--max-score="))?.split("=")[1] ?? 3);
const NOTE = `薪资上限<${MAX_K}K 且评分<${MAX_SCORE}（自动标记跳过）`;

const apps = parseApplications(fs.readFileSync(APPS_FILE, "utf8"), ROOT);

const candidates = [];
let evaluatedTotal = 0;
let unknownSalary = 0;
let unknownScore = 0;

for (const a of apps) {
  if (canonStatus(a.status) !== "EVALUATED") continue;
  evaluatedTotal++;
  const s = scoreNum(a.score);
  if (Number.isNaN(s)) { unknownScore++; continue; }
  const linked = a.report.match(/\]\(([^)]+)\)/)?.[1];
  let salary = null;
  if (linked) {
    const p = path.resolve(ROOT, "data", linked);
    try {
      salary = parseReportSalary(extractAdvertisedComp(fs.readFileSync(p, "utf8")));
    } catch { /* report unreadable → treat as unknown */ }
  }
  const range = salary?.range;
  if (!range) { unknownSalary++; continue; }
  if (range.maxK < MAX_K && s < MAX_SCORE) {
    candidates.push({ n: a.n, company: a.company, role: a.role, score: s, maxK: range.maxK, text: salary?.text ?? "" });
  }
}

console.log(`EVALUATED 总行数: ${evaluatedTotal}`);
console.log(`评分缺失/无法解析（不标记）: ${unknownScore}`);
console.log(`薪资未知/未披露（不标记）: ${unknownSalary}`);
console.log(`命中（上限<${MAX_K}K 且 评分<${MAX_SCORE}）: ${candidates.length}`);
console.log("─".repeat(60));
for (const c of candidates) {
  console.log(`#${c.n}  ${c.company} — ${c.role}  | 评分 ${c.score}  | 上限 ${c.maxK}K  | 原文: ${c.text}`);
}

if (!apply) {
  console.log("─".repeat(60));
  console.log("⚠ 仅预览，未写入。加 --apply 执行标记。");
  process.exit(0);
}

console.log("─".repeat(60));
let ok = 0;
for (const c of candidates) {
  try {
    const out = execFileSync(
      "node",
      [path.join(ROOT, "set-status.mjs"), "--row", c.n, "SKIP", "--note", NOTE, "--json"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const r = JSON.parse(out);
    if (r.changed) { ok++; console.log(`✅ #${c.n} ${r.oldStatus} → ${r.newStatus}`); }
    else console.log(`• #${c.n} 已为 ${r.newStatus}（无变化）`);
  } catch (e) {
    console.error(`❌ #${c.n} 失败: ${e.stderr || e.message}`);
  }
}
console.log("─".repeat(60));
console.log(`写入完成：${ok}/${candidates.length} 行标记为 SKIP`);
