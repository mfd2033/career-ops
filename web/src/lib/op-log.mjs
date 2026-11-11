/**
 * op-log.mjs — 操作日志的纯解析与聚合层（无 fs、无 React）。
 *
 * 为什么存在：dashboard 里「谁在什么时候做了什么」此前没有一处可读台账。手动操作
 * 只有 tracker 状态变更落进 data/status-log.tsv（且只有日期、没有时刻），后台任务只落
 * .career-ops-web/runs/index.jsonl（有毫秒时刻但没有触发方式），加管道、删行、黑名单、
 * 配置这些手工动作则什么都不留。
 *
 * 本文件只做纯计算：把四处既有事实源解析成同一形状的条目，裁到七日窗口，按
 * dedupeKey 去重，按时间倒序。写入侧见 op-log-store.mjs，页面侧见 app/logs/page.tsx。
 *
 * 去重口径：新写入链（.career-ops-web/op-log.jsonl）与旧台账在同一个窗口里会描述
 * 同一件事（界面改状态既写 op-log 也写 status-log）。op-log 条目优先——它带精确
 * 时刻；旧台账条目只在没有同键 op-log 条目时补位。旧台账行本身不回填、不重写。
 */

export const OP_LOG_WINDOW_DAYS = 7;

/** 手动操作类型：谁点的谁负责，出现在台账里就是某个人的动作。 */
export const MANUAL_TYPES = [
  "status-change",
  "tracker-add",
  "tracker-edit",
  "tracker-delete",
  // 第二条 tracker 写路径（PUT /api/tracker/upsert）：按 URL 去重后可能更新既有行，
  // 语义与 tracker-add 不同（后者永不静默改写），所以单独一类。
  "tracker-upsert",
  "follow-up",
  "follow-up-delete",
  // 跟进日期的「钉住 / 取消钉住」写的是 follow-ups.md 的 `- next #N` 指令行，
  // 既不是一条跟进记录，也不影响表格台账，单列一类。
  "followup-pin",
  "blacklist",
  "pipeline-add",
  "pipeline-remove",
  "config",
  // 配置类写入：形态相同（改某个用户层文件的某几个键），共用 logConfigWrite()。
  // 与 config（app-config 的引擎/模型等）分开，回看时才分得清改的是哪一层。
  "cv-save",
  "profile-save",
  "portals-save",
  "cadence-save",
  "skill-dirs",
  "memory-write",
  "quick-key",
];

/** 自动操作类型：由任务台账/扫描台账产生，人只在派发时出现。 */
export const AUTO_TYPES = ["evaluate", "checkup", "cv", "pdf", "batch-evaluate", "batch-checkup", "scan"];

export const OP_LOG_TYPES = [...MANUAL_TYPES, ...AUTO_TYPES];

/** 类型是否属于台账白名单。未知类型一律丢弃：脏类型进了页面就再也归不了类。 */
export function isOpLogType(type) {
  return OP_LOG_TYPES.includes(String(type ?? ""));
}

/** 没有显式触发方式时按类型归属（旧台账走这条）。 */
export function triggerOfType(type) {
  return MANUAL_TYPES.includes(String(type ?? "")) ? "manual" : "auto";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad2 = (n) => String(n).padStart(2, "0");

/** epoch ms → 宿主本地日历日（YYYY-MM-DD）。日志的「日」永远是用户所在时区的日。 */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地日历日 → 当日零点 epoch ms；形状不合法返回 null。 */
export function dayStart(date) {
  const text = String(date ?? "");
  if (!DAY_RE.test(text)) return null;
  const [y, m, d] = text.split("-").map(Number);
  const ms = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  // 形状对不代表日期存在：`2026-13-45` 会被 Date 静默滚到 2027 年。日志里的
  // 一天必须能原样回读，否则裁剪窗口会把这条记录算到别的日子上。
  if (localDay(ms) !== text) return null;
  return ms;
}

/**
 * 窗口内的日期，最新在前。用日期构造（而不是 epoch 减 24h）做递减，夏令时切换的
 * 那一天不会算错一天。
 */
export function windowDates(today, days = OP_LOG_WINDOW_DAYS) {
  const base = dayStart(today);
  if (base == null) return [];
  const [y, m, d] = String(today).split("-").map(Number);
  const out = [];
  for (let i = 0; i < days; i++) out.push(localDay(new Date(y, m - 1, d - i).getTime()));
  return out;
}

/** 单行化 + 截断：台账字段来自本地文件与界面输入，绝不允许把换行带进一行记录。 */
export function clipText(value, max = 200) {
  const s = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

const META_KEY_RE = /^[a-z][a-z-]*$/;

/**
 * 把任意来源的条目收敛成页面消费的唯一形状。缺 at / 类型不在白名单 → null
 * （调用方过滤掉，绝不让一条坏记录带崩整页）。
 */
export function makeEntry(raw) {
  if (!raw) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  const type = clipText(raw.type, 40);
  if (!isOpLogType(type)) return null;

  const trigger = raw.trigger === "manual" || raw.trigger === "auto" ? raw.trigger : triggerOfType(type);
  const meta = Array.isArray(raw.meta)
    ? raw.meta
        .filter((m) => m && META_KEY_RE.test(String(m.k ?? "")))
        .map((m) => ({ k: String(m.k), v: clipText(m.v, 120) }))
        .filter((m) => m.v !== "")
        .slice(0, 6)
    : [];

  return {
    id: clipText(raw.id ?? `${type}:${at}`, 140),
    at,
    date: localDay(at),
    hasTime: raw.hasTime !== false,
    trigger,
    type,
    title: clipText(raw.title, 160),
    meta,
    status: raw.status === "done" || raw.status === "failed" ? raw.status : null,
    durationSec: Number.isFinite(Number(raw.durationSec)) && raw.durationSec !== null ? Number(raw.durationSec) : null,
    href: typeof raw.href === "string" && raw.href.startsWith("/") ? clipText(raw.href, 200) : null,
    dedupeKey: raw.dedupeKey ? clipText(raw.dedupeKey, 200) : null,
  };
}

function trackerLabel(index, num) {
  const hit = index instanceof Map ? index.get(String(num)) : null;
  return typeof hit === "string" ? hit : "";
}

/**
 * data/status-log.tsv → 状态变更条目（手动、只有日期）。
 * 列：`# · date · from · to · source · note`；无表头，坏行跳过。
 */
export function entriesFromStatusLog(text, trackerIndex = new Map()) {
  const out = [];
  const body = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r/g, "");
  for (const line of body.split("\n")) {
    const cells = line.split("\t");
    if (cells.length < 4) continue;
    const num = String(cells[0] ?? "").trim();
    const date = String(cells[1] ?? "").trim();
    if (!/^\d+$/.test(num) || !DAY_RE.test(date)) continue; // 表头 / 坏行
    const at = dayStart(date);
    if (at == null) continue;
    const from = clipText(cells[2], 40);
    const to = clipText(cells[3], 40);
    const source = clipText(cells[4], 40) || "set-status";
    const note = clipText(cells[5], 120);
    const meta = [
      { k: "from", v: from },
      { k: "to", v: to },
      { k: "source", v: source },
    ];
    if (note) meta.push({ k: "note", v: note });
    out.push(
      makeEntry({
        id: `status-log:${num}:${date}:${from}:${to}:${out.length}`,
        at,
        hasTime: false,
        trigger: "manual",
        type: "status-change",
        title: trackerLabel(trackerIndex, num) || `#${num}`,
        meta,
        href: `/pipeline?q=${num}`,
        dedupeKey: `status:${num}:${date}:${from}->${to}`,
      }),
    );
  }
  return out.filter(Boolean);
}

/**
 * data/follow-ups.md → 跟进条目（手动、只有日期）。
 * 表格列：`num · appNum · date · company · role · channel · contact · notes`；
 * 老版本的 bullet 行不属于本页口径（交 followup-cadence.mjs 处理），忽略。
 */
export function entriesFromFollowUps(md, trackerIndex = new Map()) {
  const out = [];
  const body = String(md ?? "").replace(/^\uFEFF/, "").replace(/\r/g, "");
  for (const line of body.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    const num = Number.parseInt(cells[0], 10);
    if (!/^\d+$/.test(cells[0])) continue; // 表头（num / #）
    const appNum = cells[1];
    const date = cells[2];
    if (!Number.isInteger(num) || !DAY_RE.test(date)) continue;
    const at = dayStart(date);
    if (at == null) continue;
    const company = clipText(cells[3], 80);
    const role = clipText(cells[4], 80);
    const channel = clipText(cells[5], 40);
    const notes = clipText(cells[7], 120);
    const meta = [];
    if (channel) meta.push({ k: "channel", v: channel });
    if (notes) meta.push({ k: "note", v: notes });
    out.push(
      makeEntry({
        id: `followup:${num}`,
        at,
        hasTime: false,
        trigger: "manual",
        type: "follow-up",
        title: trackerLabel(trackerIndex, appNum) || [company, role].filter(Boolean).join(" · "),
        meta,
        href: /^\d+$/.test(appNum) ? `/pipeline?q=${appNum}` : null,
        dedupeKey: `followup:${num}`,
      }),
    );
  }
  return out.filter(Boolean);
}

/** runs 台账的 kind → 页面类型。未收录的 kind（如未来的新任务）直接不展示。 */
const RUN_KIND_TYPE = {
  evaluate: "evaluate",
  checkup: "checkup",
  pdf: "pdf",
  "cv-tailor": "cv",
  "batch-evaluate": "batch-evaluate",
  "batch-evaluate-item": "batch-evaluate",
  "batch-checkup": "batch-checkup",
  "batch-checkup-item": "batch-checkup",
};

/** .career-ops-web/runs/index.jsonl 的记录 → 自动任务条目（有毫秒时刻）。 */
export function entriesFromRuns(records) {
  const out = [];
  for (const rec of Array.isArray(records) ? records : []) {
    const type = RUN_KIND_TYPE[String(rec?.kind ?? "")];
    if (!type) continue;
    const finishedAt = Number(rec?.finishedAt);
    const startedAt = Number(rec?.startedAt);
    const at = Number.isFinite(finishedAt) && finishedAt > 0 ? finishedAt : startedAt;
    if (!Number.isFinite(at) || at <= 0) continue;
    const durationSec =
      Number.isFinite(startedAt) && startedAt > 0 && at > startedAt ? Math.round((at - startedAt) / 1000) : null;
    const meta = [];
    const engine = [rec?.cliId, rec?.model].filter((v) => typeof v === "string" && v).join(" / ");
    if (engine) meta.push({ k: "engine", v: engine });
    if (rec?.reportNum) meta.push({ k: "report", v: `#${rec.reportNum}` });
    out.push(
      makeEntry({
        id: `run:${rec?.id ?? at}`,
        at,
        hasTime: true,
        trigger: "auto",
        type,
        // 标题是报告/台账给出的「公司 · 岗位」；凑不出就留空，页面对空标题回落到类型名。
        title: clipText(rec?.title || rec?.label || rec?.input, 160),
        meta,
        status: rec?.status === "done" ? "done" : rec?.status === "error" ? "failed" : null,
        durationSec,
        href:
          typeof rec?.page === "string" && rec.page.startsWith("/")
            ? rec.page
            : rec?.reportNum
              ? `/report/${rec.reportNum}`
              : null,
        dedupeKey: `run:${rec?.id ?? at}`,
      }),
    );
  }
  return out.filter(Boolean);
}

/**
 * data/scan-runs.tsv → 门户扫描条目（自动、UTC 毫秒时刻）。列名取表头，
 * 这样扫描器以后加列也不会把这里读歪。
 */
export function entriesFromScanRuns(tsv) {
  const lines = String(tsv ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const header = lines[0].split("\t").map((h) => h.trim());
  const atCol = header.indexOf("timestamp");
  if (atCol < 0) return [];
  const statusCol = header.indexOf("status");
  const valueOf = (cells, name) => {
    const i = header.indexOf(name);
    return i < 0 ? "" : String(cells[i] ?? "").trim();
  };
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const at = Date.parse(String(cells[atCol] ?? "").trim());
    if (!Number.isFinite(at)) continue;
    const meta = [];
    for (const name of ["companies", "boards", "found", "new_added"]) {
      const v = valueOf(cells, name);
      if (v !== "" && v !== "0") meta.push({ k: name === "new_added" ? "new-added" : name, v });
    }
    out.push(
      makeEntry({
        id: `scan:${cells[atCol]}`,
        at,
        hasTime: true,
        trigger: "auto",
        type: "scan",
        title: "",
        meta,
        status: String(cells[statusCol] ?? "").trim() === "completed" ? "done" : "failed",
        durationSec: null,
        href: null,
        dedupeKey: `scan:${cells[atCol]}`,
      }),
    );
  }
  return out.filter(Boolean);
}

/**
 * 合并四个事实源 → 页面数据。
 *
 * @param {object} input
 * @param {object[]} [input.opLog] - .career-ops-web/op-log.jsonl 的记录（新写入链，优先）
 * @param {string} [input.statusLog] - data/status-log.tsv 原文
 * @param {object[]} [input.runs] - 运行台账记录
 * @param {string} [input.scanRuns] - data/scan-runs.tsv 原文
 * @param {string} [input.followUps] - data/follow-ups.md 原文
 * @param {string} input.today - 本地今天（YYYY-MM-DD）
 * @param {number} [input.days] - 窗口天数，默认 7
 * @param {Map<string,string>} [input.trackerIndex] - tracker # → 「#N 公司 · 岗位」
 * @returns {{entries: object[], dates: string[]}} 条目按时间倒序；dates 最新在前
 */
export function mergeOperationLog({
  opLog = [],
  statusLog = "",
  runs = [],
  scanRuns = "",
  followUps = "",
  today,
  days = OP_LOG_WINDOW_DAYS,
  trackerIndex = new Map(),
} = {}) {
  const dates = windowDates(today, days);
  if (dates.length === 0) return { entries: [], dates: [] };
  const inWindow = new Set(dates);
  const seen = new Set();
  const entries = [];

  for (const raw of opLog) {
    const entry = makeEntry(raw);
    if (!entry || !inWindow.has(entry.date)) continue;
    if (entry.dedupeKey) seen.add(entry.dedupeKey);
    entries.push(entry);
  }

  const fromLedgers = [
    ...entriesFromStatusLog(statusLog, trackerIndex),
    ...entriesFromFollowUps(followUps, trackerIndex),
    ...entriesFromRuns(runs),
    ...entriesFromScanRuns(scanRuns),
  ];
  for (const entry of fromLedgers) {
    if (!entry || !inWindow.has(entry.date)) continue;
    if (entry.dedupeKey && seen.has(entry.dedupeKey)) continue;
    entries.push(entry);
  }

  entries.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  return { entries, dates };
}
