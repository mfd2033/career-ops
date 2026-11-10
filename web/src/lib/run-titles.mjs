/**
 * run-titles.mjs — 服务端台账行的「公司 · 岗位」标题补齐（读取端派生）。
 *
 * WHY：招聘站扩展/CLI 发起的单次评估没有本地卡，/jobs 列表显示的就是台账标题，
 * 而那是 run/route.ts 的兜底形状 `evaluate <url>`——列表只能把它派生成「评估」+
 * 域名，看不出在评估谁。网页里点「评估」发起的任务有本地卡兜着漂亮的
 * 「评估 · 公司 + 岗位」，同一件事从招聘站发起就只剩一串链接。
 *
 * 唯一诚实的来源是报告：Machine Summary 的 company/role 是评估员落定的事实
 * （与批量评估 labelForNum 同口径）。报告读不到就原样返回——不猜、不回填台账，
 * 所以老记录与新记录一样可读，改文案也不必重打包。
 *
 * 只动 kind === "evaluate" 且有报告号的行：批量/体检/PDF 各有自己的可读标题，
 * 报告号缺失（ADR-0089 之前的老记录）也不回填。
 *
 * Plain .mjs：node --test 锁定。
 */

import fs from "node:fs";
import path from "node:path";
import { reportJobLabel } from "./job-label.mjs";

/**
 * 给台账行补上「公司 · 岗位」标题。
 *
 * 未变动的行保留原引用（上游可凭引用相等跳过重渲染/重算）。
 *
 * @param {Array<Record<string, unknown>>} runs /api/runs/history 的行（新→旧）
 * @param {(num: string) => string} labelForNum 报告号 → 标签；取不到返回 ""
 * @returns {Array<Record<string, unknown>>}
 */
export function enrichEvaluateTitles(runs, labelForNum) {
  const list = Array.isArray(runs) ? runs : [];
  let changed = false;
  const out = list.map((run) => {
    if (!run || run.kind !== "evaluate" || run.reportNum == null) return run;
    const label = labelForNum(String(run.reportNum));
    if (!label || label === run.title) return run;
    changed = true;
    return { ...run, title: label };
  });
  return changed ? out : list;
}

/** 已解析出的标签缓存（进程内）。键为报告号。 */
const labelCache = new Map();

/**
 * 报告号 → 「公司 · 岗位」读取器。
 *
 * `index` 必须由调用方**每个请求**重建一次（career-ops 的 reportsIndexOf）：
 * 新写出的报告才能立刻被看到。已解析出的非空标签按报告号进程内缓存——报告落盘后
 * 公司/岗位就是定值，不必每 15 秒重读十几 KB；空结果**不**缓存，报告可能还没写完。
 *
 * @param {{index?: Map<number, string>, reportsDir: string, readText?: (file: string) => string}} args
 * @returns {(num: string | number) => string}
 */
export function createLabelForNum({ index, reportsDir, readText = (file) => fs.readFileSync(file, "utf8") }) {
  return (num) => {
    const n = parseInt(String(num ?? ""), 10);
    if (!Number.isFinite(n)) return "";
    const hit = labelCache.get(n);
    if (hit) return hit;
    const name = index?.get?.(n);
    if (!name) return "";
    let label = "";
    try {
      label = reportJobLabel(readText(path.join(reportsDir, name)));
    } catch {
      label = ""; // 读不出的报告按「取不到」处理，下次请求再试
    }
    if (label) labelCache.set(n, label);
    return label;
  };
}
