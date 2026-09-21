// 单任务事件序列 → 步骤时间线折叠（ADR-0047 决议 2）。
//
// WHY THIS EXISTS: 逐工具步骤此前只活在客户端 ephemeral 状态里，页签不在线时
// 事后无法重建。本模块把 run-events 缓冲区里的一次单任务事件序列折叠成与客户端
// 实时累积**完全同口径**的步骤数组，供 run 路由在终态内嵌进台账（`steps` 字段），
// 详情页/治愈逻辑据此回读。
//
// 口径必须与 job-store 的实时累积逐字对齐（ADR-0042 决议 1/2），否则「重建的时间线」
// 和「当时看到的时间线」会长得不一样：
//   - 只纳入 tool / status；text / done / error / item 不进。
//   - `phase:` 前缀的 status 是粗阶段徽章，不入步骤流。
//   - 同名工具：带 detail 的事件就地并入此前那条裸行（`Name` → `Name: detail`），
//     一次工具调用一行；无匹配裸行时只 push `Name`（detail 丢弃，与客户端一致）。
//
// Plain .mjs（同 batch-ledger.mjs）：node --test 锁定，不 import tsx。

/**
 * @typedef {{ kind: "tool" | "status", label: string, ts?: number }} FoldedStep
 */

/** 默认保留最近 20 条（与 job-store STEPS_CAP_PERSIST 同口径）。 */
export const RUN_STEPS_CAP = 20;
/** 单条 label 上限，防台账行膨胀（detail 是工具主参数原始透传，可能很长）。 */
export const RUN_STEP_LABEL_MAX = 200;

/** 截断单条步骤 label 到上限（折叠与治愈去重共用同一口径，ADR-0047）。 */
export const clipStepLabel = (s, max = RUN_STEP_LABEL_MAX) =>
  typeof s === "string" && s.length > max ? `${s.slice(0, max - 1)}…` : s;

/**
 * 折叠事件序列为步骤时间线（纯函数，绝不抛）。
 * @param {Array<{ type: string, name?: string, detail?: string, label?: string, ts?: number }>} events
 * @param {{ cap?: number, labelMax?: number }} [opts]
 * @returns {FoldedStep[]}
 */
export function buildRunLedgerSteps(events, { cap = RUN_STEPS_CAP, labelMax = RUN_STEP_LABEL_MAX } = {}) {
  if (!Array.isArray(events)) return [];
  /** @type {FoldedStep[]} */
  const steps = [];
  for (const ev of events) {
    if (!ev || typeof ev.type !== "string") continue;
    const ts = typeof ev.ts === "number" ? ev.ts : undefined;

    if (ev.type === "tool") {
      const name = typeof ev.name === "string" ? ev.name : "";
      if (!name) continue;
      const detail = typeof ev.detail === "string" && ev.detail ? ev.detail : undefined;
      let merged = false;
      if (detail) {
        // 就地并入最近一条同名裸工具行（label 恰为 name，未带 detail）。
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].kind === "tool" && steps[i].label === name) {
            steps[i] = { ...steps[i], label: clipStepLabel(`${name}: ${detail}`, labelMax) };
            merged = true;
            break;
          }
        }
      }
      if (!merged) steps.push({ kind: "tool", label: clipStepLabel(name, labelMax), ...(ts != null ? { ts } : {}) });
    } else if (ev.type === "status") {
      const label = typeof ev.label === "string" ? ev.label : "";
      if (!label || label.startsWith("phase:")) continue;
      steps.push({ kind: "status", label: clipStepLabel(label, labelMax), ...(ts != null ? { ts } : {}) });
    }
    // text / done / error / item / 未知类型：不进步骤流。
  }
  return steps.length > cap ? steps.slice(-cap) : steps;
}
