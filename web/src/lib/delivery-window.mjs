// 投递时机（Kaneo CO-44 / ADR-0085）——把《投简历黄金时间指南-20261010》里
// Boss直聘 / 猎聘 / 智联招聘 的时段矩阵做成一枚纯函数：给定「现在是几点」，
// 回答「现在能不能投、投哪个平台、下一段黄金窗口在什么时候」。
//
// 三条口径说明：
// 1. 矩阵是「时段 × 日型 → 等级」的查表，等级只有三值 best / ok / avoid；
//    引擎不产出任何人类文案，文案全部走 i18n（clusters/delivery.ts）。
// 2. 时间取 `Date` 的本地字段——本产品是本地优先单机应用，服务端与浏览器同机。
// 3. 猎聘与智联共用一套矩阵：指南第三节原文即「规律一致，共用一张」。

/** 平台 id，顺序即 UI 展示顺序。 */
export const PLATFORMS = ["boss", "liepin", "zhaopin"];

/** 时段等级，从好到差。 */
export const LEVELS = ["best", "ok", "avoid"];

/** 日型：周一 / 周二~周四 / 周五 / 周六日。矩阵的列就按这个顺序。 */
export const DAY_TYPES = ["mon", "midweek", "fri", "weekend"];

const DAY_TYPE_INDEX = { mon: 0, midweek: 1, fri: 2, weekend: 3 };

// 时段行：start/end 为当日分钟数（end 不含），levels 与 DAY_TYPES 一一对应。
// 数据来源：指南第二节 Boss直聘矩阵。原文「周一~周四」与「周五」两列取值相同，
// 因此按工作日（mon/midweek/fri）同值存储；原文未列的 00:00–07:00 取 avoid，
// 依据是指南第五节「别在周五下午、深夜、假期中随手投」。
const BOSS_WINDOWS = [
  { start: 0, end: 420, levels: ["avoid", "avoid", "avoid", "avoid"] }, // 00:00–07:00
  { start: 420, end: 540, levels: ["ok", "ok", "ok", "ok"] }, // 07:00–09:00 早起
  { start: 540, end: 660, levels: ["best", "best", "best", "ok"] }, // 09:00–11:00 上午黄金
  { start: 660, end: 720, levels: ["best", "best", "best", "ok"] }, // 11:00–12:00 回复高峰
  { start: 720, end: 840, levels: ["ok", "ok", "ok", "ok"] }, // 12:00–14:00 午休
  { start: 840, end: 1020, levels: ["best", "best", "best", "ok"] }, // 14:00–17:00 下午黄金
  { start: 1020, end: 1140, levels: ["best", "best", "best", "ok"] }, // 17:00–19:00 下班高峰
  { start: 1140, end: 1320, levels: ["best", "best", "best", "best"] }, // 19:00–22:00 晚间高峰
  { start: 1320, end: 1440, levels: ["ok", "ok", "ok", "ok"] }, // 22:00–24:00 深夜
];

// 数据来源：指南第三节猎聘+智联矩阵（四列：周一 / 周二~周四 / 周五 / 周六日）。
// 原文未列的 00:00–08:00 与列出的「18:00后」同归 avoid。
const OUTBOUND_WINDOWS = [
  { start: 0, end: 480, levels: ["avoid", "avoid", "avoid", "avoid"] }, // 00:00–08:00
  { start: 480, end: 570, levels: ["avoid", "ok", "ok", "avoid"] }, // 08:00–09:30 晨会/刚上班
  { start: 570, end: 660, levels: ["ok", "best", "ok", "avoid"] }, // 09:30–11:00 上午黄金
  { start: 660, end: 720, levels: ["ok", "ok", "ok", "avoid"] }, // 11:00–12:00 上午活跃
  { start: 720, end: 840, levels: ["avoid", "avoid", "avoid", "avoid"] }, // 12:00–14:00 午休
  { start: 840, end: 960, levels: ["ok", "best", "ok", "avoid"] }, // 14:00–16:00 下午黄金
  { start: 960, end: 1080, levels: ["ok", "ok", "avoid", "avoid"] }, // 16:00–18:00 收尾
  { start: 1080, end: 1440, levels: ["avoid", "avoid", "avoid", "avoid"] }, // 18:00–24:00
];

const MATRIX = {
  boss: BOSS_WINDOWS,
  liepin: OUTBOUND_WINDOWS,
  zhaopin: OUTBOUND_WINDOWS,
};

/** 日型（mon / midweek / fri / weekend），按本地星期几。 */
export function dayTypeOf(date) {
  const day = date.getDay(); // 0 = 周日
  if (day === 0 || day === 6) return "weekend";
  if (day === 1) return "mon";
  if (day === 5) return "fri";
  return "midweek";
}

/** 当日分钟数（0–1439）。 */
export function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * 分钟数 → "HH:MM"。1440 渲染成 "24:00"（窗口终点用它表示当日结束）。
 * @param {number} min
 * @returns {string}
 */
export function formatMinutes(min) {
  const clamped = Math.max(0, Math.min(1440, Math.round(min)));
  const hh = String(Math.floor(clamped / 60)).padStart(2, "0");
  const mm = String(clamped % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * 某平台在某日型的矩阵行（含当日全部时段的完整覆盖，行按时间升序）。
 * @param {string} platform
 * @param {string} dayType
 * @returns {Array<{start: number, end: number, level: "best"|"ok"|"avoid"}>}
 */
export function windowsFor(platform, dayType) {
  const rows = MATRIX[platform];
  const idx = DAY_TYPE_INDEX[dayType];
  if (!rows || idx === undefined) return [];
  return rows.map((row) => ({ start: row.start, end: row.end, level: row.levels[idx] }));
}

/**
 * 当前时刻落在哪一段、等级为何。未知平台回退成整日 avoid（调用方当作「无建议」）。
 * @param {string} platform
 * @param {Date} date
 * @returns {{start: number, end: number, level: "best"|"ok"|"avoid"}}
 */
export function windowAt(platform, date) {
  const min = minutesOfDay(date);
  const rows = windowsFor(platform, dayTypeOf(date));
  const hit = rows.find((row) => min >= row.start && min < row.end);
  return hit || { start: 0, end: 1440, level: "avoid" };
}

/** 把「当天 0 点 + 偏移天数」构造成本地 Date。 */
function startOfDay(date, dayOffset = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
}

/**
 * 从 `from` 起（含）向前找第一段目标等级的窗口。
 *
 * - `from` 已经落在目标窗口内 → 返回该窗口本身，`current: true`、`start` 就是窗口起点；
 * - 否则返回下一段的真实起点/终点，`dayOffset` 是相对 `from` 所在日的天数；
 * - 前瞻 `horizonDays` 天内没有目标窗口 → `null`（猎聘/智联的 best 只在周二~周四，
 *   周五深夜往前看一天自然是 null）。
 *
 * @param {string} platform
 * @param {Date} from
 * @param {{levels?: Array<"best"|"ok"|"avoid">, horizonDays?: number}} [opts]
 * @returns {{start: Date, end: Date, startMin: number, endMin: number, level: string, dayOffset: number, current: boolean} | null}
 */
export function nextWindow(platform, from, { levels = ["best"], horizonDays = 7 } = {}) {
  const wanted = new Set(levels);
  for (let dayOffset = 0; dayOffset < horizonDays; dayOffset++) {
    const base = startOfDay(from, dayOffset).getTime();
    const rows = windowsFor(platform, dayTypeOf(new Date(base)));
    for (const row of rows) {
      if (!wanted.has(row.level)) continue;
      const start = new Date(base + row.start * 60000);
      const end = new Date(base + row.end * 60000);
      if (end.getTime() <= from.getTime()) continue; // 已过去的时段
      const current = start.getTime() <= from.getTime();
      return {
        start,
        end,
        startMin: row.start,
        endMin: row.end,
        level: row.level,
        dayOffset,
        current,
      };
    }
  }
  return null;
}

/**
 * 单平台建议：当前等级 + 当前时段 + 下一段黄金窗口。
 * @param {string} platform
 * @param {Date} now
 * @returns {{platform: string, dayType: string, level: string, window: {start: number, end: number, level: string}, nextBest: object|null}}
 */
export function adviceFor(platform, now) {
  const window = windowAt(platform, now);
  return {
    platform,
    dayType: dayTypeOf(now),
    level: window.level,
    window,
    nextBest: nextWindow(platform, now, { levels: ["best"] }),
  };
}

/**
 * 汇总：全局动作码 + 每平台建议 + 最早出现的黄金窗口。
 *
 * action 口径：任一平台 best → "send"；否则任一平台 ok → "ok"；否则 "wait"。
 * nextGold 取所给平台 best 窗口里起点最早的一个（并列取 platformIds 顺序在前者）。
 *
 * `platformIds` 用于「只看该报告来源平台」的场景（ADR-0085）：报告详情页传
 * 一个平台 id，管道页不传（默认全部）。传空数组 → 没有可判的平台，action 为
 * "wait"、nextGold 为 null——调用方据此改说「该来源没有已知规律」。
 *
 * @param {Date} [now]
 * @param {{platformIds?: string[]}} [opts]
 * @returns {{clock: string, dayType: string, action: "send"|"ok"|"wait", platforms: Array<object>, nextGold: object|null}}
 */
export function summarize(now = new Date(), { platformIds = PLATFORMS } = {}) {
  // 过滤未知 id：矩阵里没有的平台宁可当作「没有可判平台」，也不默默地回一
  // 句 avoid——那会把「不知道」说成「不建议投」。
  const ids = (Array.isArray(platformIds) ? platformIds : PLATFORMS).filter((id) => PLATFORMS.includes(id));
  const platforms = ids.map((platform) => adviceFor(platform, now));
  const levels = platforms.map((p) => p.level);
  const action = levels.includes("best") ? "send" : levels.includes("ok") ? "ok" : "wait";

  let nextGold = null;
  for (const advice of platforms) {
    const candidate = advice.nextBest;
    if (!candidate) continue;
    if (!nextGold || candidate.start.getTime() < nextGold.start.getTime()) {
      nextGold = { ...candidate, platform: advice.platform };
    }
  }

  return {
    clock: formatMinutes(minutesOfDay(now)),
    dayType: dayTypeOf(now),
    action,
    platforms,
    nextGold,
  };
}
