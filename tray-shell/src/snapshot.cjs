"use strict";

// 快照组装（工单 04 / ADR-0086 决策 7）。
//
// 渲染层零网络：HTTP 全部由主进程发，面板只通过 IPC 拿这一份快照。业务数据是
// **一次** /api/tracker（全量，本地按 Status 计数）+ /api/followups + /api/active-runs
// + /api/version —— 按状态打四枪会让每次刷新触发四次 CLI 子进程（tracker.mjs 很重）。
// 四个请求各自失败独立降级（哪块拿不到就 null，面板显示「—」，不整块消失）。

const proc = require("./proc.cjs");
const { trayStateOf } = require("./state.cjs");

const PIPELINE_KEYS = ["applied", "responded", "interview", "offer"];
const FOLLOWUP_ITEMS = 3;
// 常驻轮询的单次超时：服务热了之后这四个接口都在 1s 内（实测 0.15–0.9s）。
const BUSINESS_TIMEOUT_MS = 5000;

/** 大小写不敏感地取一列（/api/tracker 的行来自 SQLite，列名是小写；旧文档写的是 Status）。 */
function fieldOf(row, name) {
  if (!row || typeof row !== "object") return "";
  const wanted = name.toLowerCase();
  for (const key of Object.keys(row)) {
    if (key.toLowerCase() === wanted) return row[key];
  }
  return "";
}

/** 行状态归一：去空白、小写（`Applied` → `applied`，与 templates/states.yml 的 id 对齐）。 */
function statusOf(row) {
  return String(fieldOf(row, "status") ?? "").trim().toLowerCase();
}

/**
 * 按状态计数。`total` 是**全部在册行数**（含 Evaluated/Rejected 等四柱之外的状态），
 * 所以四个数加起来不等于 total —— 面板写的是「N 条在册」，不是漏斗台账。
 */
function countStatuses(rows) {
  const counts = { applied: 0, responded: 0, interview: 0, offer: 0, total: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    counts.total += 1;
    const status = statusOf(row);
    if (PIPELINE_KEYS.includes(status)) counts[status] += 1;
  }
  return counts;
}

/** /api/followups → `{due, items[]}`；metadata 优先（entries 被截到 8 条）。 */
function summarizeFollowups(payload) {
  if (!payload || payload.available === false) return { due: 0, items: [] };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const meta = payload.metadata || {};
  const fromMeta = Number(meta.overdue || 0) + Number(meta.urgent || 0);
  return {
    due: Number.isFinite(fromMeta) && fromMeta > 0 ? fromMeta : entries.length,
    items: entries.slice(0, FOLLOWUP_ITEMS).map((entry) => ({
      company: String(entry.company || "—"),
      role: String(entry.role || ""),
      urgency: String(entry.urgency || ""),
      num: entry.num ?? null,
    })),
  };
}

/** /api/active-runs → `{running, queued}`（两个数组，只要长度）。 */
function summarizeRuns(payload) {
  const running = Array.isArray(payload?.running) ? payload.running.length : 0;
  const queued = Array.isArray(payload?.queued) ? payload.queued.length : 0;
  return { running, queued };
}

/**
 * 主进程侧的数据聚合器。
 *
 * @param {{port?: number, fetchJson?: (path: string) => Promise<{ok: boolean, json: any}>,
 *          onDegrade?: (signature: string) => void}} opts
 */
function createBusinessFetcher({ port = 3000, fetchJson, onDegrade = () => {} } = {}) {
  // 上一次的降级签名：只有变化了才回调，避免 15s 一次刷屏（但第一次降级必记）。
  let lastSignature = "";

  const get = async (path, timeoutMs) => {
    const res = fetchJson ? await fetchJson(path) : await proc.httpJson(port, path, timeoutMs);
    if (res && res.ok && res.json) return res.json;
    // 拿不到就降级成「—」，但不能连为什么都查不到：把状态码、耗时与错误码带回给调用方。
    const code = res && res.error ? ` error=${res.error}` : "";
    degraded.push(`${path} status=${(res && res.status) || 0} ${(res && res.ms) || 0}ms${code}`);
    return null;
  };

  let degraded = [];

  /**
   * @param {{timeoutMs?: number}} [options] 单次调用的超时；服务刚就绪那一轮要放宽
   *   （实测冷启动首个 /api/tracker 要现编译路由 + 建索引，5s 不够，第二轮降到 0.5s）。
   */
  return async function business(options = {}) {
    const timeoutMs = Number(options.timeoutMs) || BUSINESS_TIMEOUT_MS;
    degraded = [];
    const [tracker, followups, runs, version] = await Promise.all([
      get("/api/tracker", timeoutMs).catch(() => null),
      get("/api/followups", timeoutMs).catch(() => null),
      get("/api/active-runs", timeoutMs).catch(() => null),
      get("/api/version", timeoutMs).catch(() => null),
    ]);

    const signature = degraded.slice().sort().join(" | ");
    if (signature && signature !== lastSignature) onDegrade(signature);
    lastSignature = signature;

    return {
      pipeline: tracker ? countStatuses(tracker?.data?.rows ?? tracker?.rows ?? []) : null,
      followups: followups ? summarizeFollowups(followups) : null,
      runs: runs ? summarizeRuns(runs) : null,
      version: version || null,
    };
  };
}

/**
 * 合并成一份推给渲染层的快照。`service.state` 在这里由 state.cjs 收敛一次，
 * 渲染层只做展示，不再自己判断健康度。
 */
function buildSnapshot({ service, business }) {
  const facts = { ...service };
  const version = business && business.version;
  if (version) {
    if (!facts.version && version.version) facts.version = version.version;
    if (!facts.coreVersion && version.coreVersion) facts.coreVersion = version.coreVersion;
    if (!facts.sha && version.sha) facts.sha = version.sha;
    if (version.packaged === true) facts.packaged = true;
  }
  facts.state = trayStateOf({ service: facts });

  return {
    service: facts,
    pipeline: (business && business.pipeline) || null,
    followups: (business && business.followups) || null,
    runs: (business && business.runs) || null,
  };
}

module.exports = {
  FOLLOWUP_ITEMS,
  PIPELINE_KEYS,
  buildSnapshot,
  countStatuses,
  createBusinessFetcher,
  fieldOf,
  statusOf,
  summarizeFollowups,
  summarizeRuns,
};
