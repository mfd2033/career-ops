import type { Dict } from "../types";

// Cluster: delivery
// 投递时机（Kaneo CO-44 / ADR-0085）。引擎只回码（best/ok/avoid + send/ok/wait），
// 这里给它配上人类文案；en 是源语言，zh 必须逐一对应（键集合对称）。
export const en: Dict = {
  // ── 常驻条（delivery-time-hint.tsx） ──
  "delivery.title": "Delivery timing",
  "delivery.verdict.send": "Golden window open",
  "delivery.verdict.ok": "Sendable, off-peak",
  "delivery.verdict.wait": "Not a good time to send",
  "delivery.level.best": "golden",
  "delivery.level.ok": "ok",
  "delivery.level.avoid": "avoid",
  "delivery.chip": "{platform} · {level}",
  "delivery.next": "Next golden window: {when}",
  "delivery.nextNone": "No golden window in the next 7 days",
  "delivery.when.today": "today {time}",
  "delivery.when.tomorrow": "tomorrow {time}",
  "delivery.when.other": "{weekday} {time}",
  "delivery.aria": "Delivery timing advice",
  "delivery.clock": "{weekday} {time}",
  // 单平台（报告详情页）额外一行：当前时段几点到几点，回答「还能投多久」。
  "delivery.windowNow": "current window {start}–{end}",
  // 报告来源不在这三个平台（ATS/公司官网…）时如实说没有规律，不套用别家口径。
  "delivery.noSource": "No known delivery-time pattern for this posting's source",
  // 判定依据 + 数据来源：悬停 title 用，短句写清「为什么现在能投/不能投」。
  "delivery.tooltip": "Judged from the Boss Zhipin / Liepin / Zhaopin golden-hour matrix (guide dated 2026-10-10). Boss Zhipin is chat-first, so evenings 20:00–22:00 and weekends work too; Liepin and Zhaopin are apply-then-screen, so aim for Tue–Thu 09:30–11:00 and 14:00–16:00 on workdays.",

  // ── 平台名（与 source-label.mjs 的域名映射保持同一套展示名） ──
  "delivery.platform.boss": "BOSS Zhipin",
  "delivery.platform.liepin": "Liepin",
  "delivery.platform.zhaopin": "Zhaopin",

  // ── 星期（delivery.clock / delivery.when.other 用） ──
  "delivery.weekday.sun": "Sunday",
  "delivery.weekday.mon": "Monday",
  "delivery.weekday.tue": "Tuesday",
  "delivery.weekday.wed": "Wednesday",
  "delivery.weekday.thu": "Thursday",
  "delivery.weekday.fri": "Friday",
  "delivery.weekday.sat": "Saturday",
};

export const zh: Dict = {
  // ── 常驻条（delivery-time-hint.tsx） ──
  "delivery.title": "投递时机",
  "delivery.verdict.send": "黄金时段，现在可投",
  "delivery.verdict.ok": "可以投，非黄金时段",
  "delivery.verdict.wait": "现在不建议投递",
  "delivery.level.best": "黄金",
  "delivery.level.ok": "可以",
  "delivery.level.avoid": "避开",
  "delivery.chip": "{platform} · {level}",
  "delivery.next": "下一段黄金：{when}",
  "delivery.nextNone": "未来 7 天没有黄金窗口",
  "delivery.when.today": "今天 {time}",
  "delivery.when.tomorrow": "明天 {time}",
  "delivery.when.other": "{weekday} {time}",
  "delivery.aria": "投递时机建议",
  "delivery.clock": "{weekday} {time}",
  // 单平台（报告详情页）额外一行：当前时段几点到几点，回答「还能投多久」。
  "delivery.windowNow": "当前窗口 {start}–{end}",
  // 报告来源不在这三个平台（ATS/公司官网…）时如实说没有规律，不套用别家口径。
  "delivery.noSource": "该职位来源不在 Boss直聘/猎聘/智联，暂无投递时段规律",
  // 判定依据 + 数据来源
  "delivery.tooltip": "按 BOSS直聘/猎聘/智联 的投递黄金时间矩阵判断（指南 2026-10-10）：BOSS直聘是直聊模式，晚间 20:00–22:00 与周末同样有效；猎聘/智联是投递→筛选模式，只认工作日周二~周四 09:30–11:00、14:00–16:00。",

  // ── 平台名（与 source-label.mjs 的域名映射保持同一套展示名） ──
  "delivery.platform.boss": "BOSS直聘",
  "delivery.platform.liepin": "猎聘",
  "delivery.platform.zhaopin": "智联招聘",

  // ── 星期 ──
  "delivery.weekday.sun": "周日",
  "delivery.weekday.mon": "周一",
  "delivery.weekday.tue": "周二",
  "delivery.weekday.wed": "周三",
  "delivery.weekday.thu": "周四",
  "delivery.weekday.fri": "周五",
  "delivery.weekday.sat": "周六",
};
