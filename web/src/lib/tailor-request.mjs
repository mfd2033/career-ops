// 定制简历前哨的纯判定（工单 generate-tailored-cv/04），与 decideCheckupPreflight 对称。
//
// 「本行在跑的定制 + 客户端的 replace 开关 → 该 dispatch / blocked / replace」这条判定，
// 与体检的那条逐字同形——它只依赖 { live:[{runId,state,startedAt}], replace } 这个形状，
// 与 kind 无关。所以这里不复制一份会漂移的副本，直接复用 checkup-request.mjs 的通用实现，
// 只以 tailor 语义命名再导出（单一事实源；替换应答体 likewise 复用 checkupReplaceBody）。
//
// 与 checkup 的对应关系（ADR-0033 决议 3/6）：
//   - 无在跑            → dispatch，放行；
//   - 有在跑、未带 replace → blocked（409），把 running 列表（含 runId）交调用方裁决；
//   - 带 replace:true    → replace，停掉同 tracker# 全部在跑后再放行；
//   - 任一旧 run 等待结果是 timeout → 放行但如实标 unconfirmed（复用 tailorReplaceBody）。
//
// Plain .mjs：node --test 锁定（web/tests/lib/tailor-request.test.mjs）。

import { decideCheckupPreflight, checkupReplaceBody } from "./checkup-request.mjs";

/**
 * 定制前哨判定（纯，委托给通用的 decideCheckupPreflight）。
 * @param {{live?: Array<{runId: string, state: string, startedAt: number|null}>, replace?: unknown}} input
 * @returns {{action: "dispatch"} | {action: "blocked"|"replace", running: Array}}
 */
export function decideTailorPreflight(input) {
  return decideCheckupPreflight(input);
}

/**
 * 替换的应答体（纯，复用 checkup 的同一形状）：任一 timeout → 放行但标 unconfirmed。
 * @param {{replaced: string[], outcomes: Array<"gone"|"unknown"|"timeout">}} input
 * @returns {{ok: true, replaced: string[], unconfirmed?: true}}
 */
export function tailorReplaceBody(input) {
  return checkupReplaceBody(input);
}
