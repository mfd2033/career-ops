// browser-progress.mjs — 探索页 BSK 采集的逐平台进度纯逻辑（ADR-0069）。
//
// 数据链路：扩展 content script 分批上报 → 路由把每条 URL 记进幂等表
// `seen:{scanId}` 命名空间（ADR-0021，值是 normalizeUrl 后的 URL，host 保留）。
// /api/explore/scan-progress 按 host 把这批键归集到 zhipin/liepin/zhaopin 三桶，
// 前端 2s 轮询拿 perSource 驱动平台 chip 的「n/上限」。
//
// 计数口径 = 原始采到数（ADR-0069 决议 4）：采集门（薪资/城市/标题）在收尾才统一
// 跑（ADR-0029），途中的 chip 说的是「平台采到了多少」，不是「最终入库多少」。
//
// host→平台判定复用 inbox-salary.mjs::salaryBoardFromUrl —— 清单只有一份，
// 新增平台时两处（薪资口径 / 进度归集）不会漂移。

import { salaryBoardFromUrl } from "./inbox-salary.mjs";
import { SCAN_MAX_DEFAULT, clampSafe } from "./scan-max.mjs";

/**
 * 把幂等表的 URL 键集合按招聘站归集成本次采集条数。
 * 纯函数：不修改传入集合；非三站 URL（含坏 URL）不进任何桶。
 *
 * @param {Iterable<string>} urlKeys normalizeUrl 后的 URL 键（可含空串）
 * @returns {{zhipin: number, liepin: number, zhaopin: number}}
 */
export function countByBoard(urlKeys) {
  const out = { zhipin: 0, liepin: 0, zhaopin: 0 };
  for (const key of urlKeys ?? []) {
    const board = salaryBoardFromUrl(key);
    if (board && board in out) out[board] += 1;
  }
  return out;
}

/**
 * 扫描发起时的分母快照：逐 target 的 {source, maxCount} 聚合成每平台上限合计。
 * 猎聘拆词时同 source 多条 URL 各自带上限 → 求和（ADR-0069 决议 3）。
 * 非法 maxCount（非正整数）回落该站配置默认（与 scan-max 的 clampSafe 同口径）。
 *
 * @param {Array<{source?: string, maxCount?: unknown}>} targets
 * @returns {{zhipin: number, liepin: number, zhaopin: number}}
 */
export function maxSnapshotByBoard(targets) {
  const out = { zhipin: 0, liepin: 0, zhaopin: 0 };
  for (const t of targets ?? []) {
    const source = t && typeof t.source === "string" ? t.source : "";
    if (!(source in out)) continue;
    out[source] += clampSafe(t.maxCount, SCAN_MAX_DEFAULT[source]);
  }
  return out;
}
/**
 * 平台 chip 的进度条百分比（ADR-0069 决议 5）：swept 恒满格——上限是截断保护而非
 * 目标，采完即满，不因未达上限留残缺 bar；其余有分母按 done/total，无分母时
 * noisy 满格、queued/active 为空。
 *
 * @param {{done?: number, total?: number} | null | undefined} source 该平台的进度
 * @param {string} state chip 当前状态（调用侧用 `source?.state ?? "queued"`）
 * @returns {number} 0..100
 */
export function chipProgressPct(source, state) {
  if (state === "swept") return 100;
  if (!source || !source.total) return state === "noisy" ? 100 : 0;
  return Math.min(100, Math.round(((source.done ?? 0) / source.total) * 100));
}
