"use strict";

// 托盘状态的唯一收敛点（ADR-0086 决策 5 / 工单 01）。
//
// service.cjs 只记录原始事实（有没有在起、端口通不通、有没有失败原因），
// 由这里折成托盘要的四种状态与 tooltip。02 的叉车逻辑、04 的面板都从这里取，
// 别在别处再算一遍 —— 同一份状态两处各算一次必然漂移（ADR-0086 被拒方案）。

const TRAY_STATES = ["run", "starting", "down", "failed"];

const TOOLTIPS = {
  run: "career-ops · 服务正常",
  starting: "career-ops · 启动中",
  down: "career-ops · 服务已停止",
  failed: "career-ops · 启动失败",
};

/**
 * 原始事实 → 托盘状态。
 *
 * - `failed`：上一次启动明确的失败（超时 / 端口杀不掉 / 子进程崩了）优先，
 *   哪怕还在重试中也先红着；
 * - `run`：最近一次健康探测通了；
 * - `starting`：有 spawn 在飞、端口还没应答；
 * - 其余（含「从没起过」「外部实例自己挂了」）→ `down`。
 *
 * @param {{service?: {failed?: boolean, ready?: boolean, starting?: boolean}}} snapshot
 * @returns {"run"|"starting"|"down"|"failed"}
 */
function trayStateOf(snapshot) {
  const service = (snapshot && snapshot.service) || {};
  if (service.failed === true) return "failed";
  if (service.ready === true) return "run";
  if (service.starting === true) return "starting";
  return "down";
}

/**
 * 托盘 tooltip：运行态带上端口（用户最需要确认「哪个端口的那个服务活着」）。
 *
 * @param {{service?: {ready?: boolean, starting?: boolean, failed?: boolean}}} snapshot
 * @param {number} port
 */
function trayTooltip(snapshot, port = 3000) {
  const state = trayStateOf(snapshot);
  return state === "run" ? `${TOOLTIPS.run} :${port}` : TOOLTIPS[state];
}

module.exports = { TRAY_STATES, TOOLTIPS, trayStateOf, trayTooltip };
