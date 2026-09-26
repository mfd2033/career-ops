// Shared tracker ordering/filtering — the SINGLE source of truth for "which
// rows does the pipeline table show, in what order".
//
// Both consumers must produce IDENTICAL results:
//   - pipeline-view.tsx      (the tracker table) — its `filtered` memo used to
//     inline this logic; it now calls orderApplications so the list can carry
//     its exact context into row links.
//   - pipeline/[id]/page.tsx (the report detail page) — reconstructs the same
//     ordered list from the URL context to compute prev/next navigation.
//
// The INBOX tab is special-cased to [] here exactly as the view did: the
// triage queue is NOT the tracker table, so it has no rows to navigate.
//
// Plain .mjs (like clean-chips.mjs / status-alias.mjs) so a `node --test` unit
// test can import it. Kept honest by tests/lib/pipeline-order.test.mjs.

import { canonStatus } from "./status-alias.mjs";
import { scoreNum } from "./score-num.mjs";
import { salaryMedian } from "./report-salary.mjs";

/** The tracker table's own default context — ALL rows, score descending. Used
 *  as the fallback when a report is opened without (or outside) a list
 *  context, so prev/next still work. */
export const DEFAULT_ORDER = {
  tab: "ALL",
  min: null,
  q: "",
  sortKey: "score",
  dir: -1,
};

const SORT_KEYS = ["company", "role", "score", "salary", "checkup", "status", "date", "duration"];

/** The value a row sorts on, under `sortKey`. Numeric for score/duration (a
 *  missing value is -Infinity so it sinks to the bottom of the default
 *  descending sort), the raw string otherwise. `salary` (ADR-0037) and
 *  `checkup` (ADR-0064) are deliberately NOT handled here — both need a
 *  direction-independent "unknown always last" rule, which the (av - bv) * dir
 *  shape cannot express; see compareSalary / compareCheckup. */
function sortKeyValue(row, sortKey) {
  if (sortKey === "score") {
    const n = scoreNum(row.score);
    return Number.isNaN(n) ? -Infinity : n;
  }
  if (sortKey === "duration") return typeof row.evalDuration === "number" ? row.evalDuration : -Infinity;
  return row[sortKey] || "";
}

/** 报告薪资比较（ADR-0037 决议 5/6）：区间中位值（与收件箱 ADR-0024 决议 4 同
 *  口径，一个「薪资排序」概念只定义一次）。
 *
 *  未披露 / 无报告 / 老行没有该字段的行**恒沉底**——不论升降序都在最后，所以这
 *  条分支不把结果乘 dir。这是对上面 score/duration 的 -Infinity 惯例的**有意偏
 *  离**：未知不是一个「很小的薪资」，若让它在升序里冒充最低薪，最该看的那些行
 *  会被顶到列表最前面。
 *
 *  中位值平手 → score 降序 → 报告号降序（完全确定，不依赖 Array.sort 稳定性——
 *  与 ADR-0024 决议 4 同一取向）。 */
function compareSalary(a, b, dir) {
  const am = salaryMedian(a);
  const bm = salaryMedian(b);
  if (am === null || bm === null) {
    if (am === null && bm === null) return compareScoreThenNumber(a, b);
    return am === null ? 1 : -1;
  }
  if (am !== bm) return (am - bm) * dir;
  return compareScoreThenNumber(a, b);
}

/** 数值列平手时的次级比较：score 降序，再报告号降序。salary（ADR-0037）与
 *  checkup（ADR-0064）共用——平手回退链是一个概念，不是一列一个。 */
function compareScoreThenNumber(a, b) {
  const as = scoreNum(a.score);
  const bs = scoreNum(b.score);
  const av = Number.isNaN(as) ? -Infinity : as;
  const bv = Number.isNaN(bs) ? -Infinity : bs;
  if (av !== bv) return bv - av;
  const ai = parseInt(a.n, 10);
  const bi = parseInt(b.n, 10);
  return (Number.isNaN(bi) ? 0 : bi) - (Number.isNaN(ai) ? 0 : ai);
}

/** 体检分数比较（ADR-0064 决议 2/6/7）：排序值 = 页面级 join 的最近一次 star
 *  （与角标/悬停口径一致，不是 minStar）。未体检**恒沉底**、平手回退链都与
 *  compareSalary 同一口径——「未知不是极小值」这个概念只定义一次。整列无值
 *  （台账缺失/全未体检）时回退链把顺序收敛为确定的 score 降序 → 号降序。 */
function checkupStarOf(row) {
  return typeof row.checkupStar === "number" && Number.isFinite(row.checkupStar) ? row.checkupStar : null;
}

function compareCheckup(a, b, dir) {
  const am = checkupStarOf(a);
  const bm = checkupStarOf(b);
  if (am === null || bm === null) {
    if (am === null && bm === null) return compareScoreThenNumber(a, b);
    return am === null ? 1 : -1;
  }
  if (am !== bm) return (am - bm) * dir;
  return compareScoreThenNumber(a, b);
}

/** The one sort comparison, shared by orderApplications and navNeighbors'
 *  insertion point — a second copy is what would let "where the row left from"
 *  drift from "the order the list shows". A NaN result (two missing scores) is
 *  treated as a tie, exactly as the spec's SortCompare does for the sort itself;
 *  ties then fall back to the stable (tracker row) order. */
function compareByKey(a, b, sortKey, dir) {
  if (sortKey === "salary") return compareSalary(a, b, dir);
  if (sortKey === "checkup") return compareCheckup(a, b, dir);
  const av = sortKeyValue(a, sortKey);
  const bv = sortKeyValue(b, sortKey);
  if (typeof av === "number" || typeof bv === "number") return (av - bv) * dir;
  return av.localeCompare(bv) * dir;
}

/** Normalize a URL-derived context to the shape every consumer sorts/filters
 *  with. Falls back per field, never throws — the detail page parses raw query
 *  params and hands them straight in. */
function normalizeContext(ctx = {}) {
  return {
    tab: ctx.tab ?? "ALL",
    min: ctx.min ?? null,
    q: ctx.q ?? "",
    sortKey: SORT_KEYS.includes(ctx.sortKey) ? ctx.sortKey : "score",
    dir: ctx.dir === 1 ? 1 : -1,
  };
}

/**
 * Filter + sort applications under the pipeline view's URL context.
 * @param {Array} applications - Application rows ({ n, company, role, score, status, date, evalDuration, ... }).
 * @param {{tab?: string, min?: number|null, q?: string, sortKey?: string, dir?: 1|-1}} ctx
 *   - tab: uppercase canonical tab (INBOX / ALL / EVALUATED / …). Default ALL.
 *   - min: numeric score floor; null/undefined disables.
 *   - q: company+role search needle.
 *   - sortKey: company | role | score | salary | checkup | status | date | duration. Default score.
 *     salary = 报告薪资（ADR-0037）：区间中位值，未披露恒沉底。
 *     checkup = 体检分数（ADR-0064）：最近一次 star，未体检恒沉底。
 *   - dir: 1 ascending, -1 descending. Default -1.
 * @returns {Array} A NEW array (the view used `[...rows].sort`, callers must
 *   not mutate the input).
 */
export function orderApplications(applications, ctx = {}) {
  const { tab, min, q, sortKey, dir } = normalizeContext(ctx);
  if (tab === "INBOX") return [];
  let rows = applications;
  if (tab !== "ALL") rows = rows.filter((r) => canonStatus(r.status).includes(tab));
  if (min != null) {
    rows = rows.filter((r) => {
      const n = scoreNum(r.score);
      return !Number.isNaN(n) && n >= min;
    });
  }
  if (q.trim()) {
    const needle = q.toLowerCase();
    rows = rows.filter((r) => `${r.company} ${r.role}`.toLowerCase().includes(needle));
  }
  return [...rows].sort((a, b) => compareByKey(a, b, sortKey, dir));
}

/** One row per tracker number, first occurrence winning (ADR-0036). The
 *  navigable unit is the report row: a duplicated `#` must not get a prev/next
 *  link of its own — that is what turned "下一个" into a jump back to the first
 *  copy and closed the positions in between into a loop. */
function dedupeById(list) {
  const seen = new Set();
  return list.filter((r) => {
    if (seen.has(r.n)) return false;
    seen.add(r.n);
    return true;
  });
}

/** The slot a row WOULD occupy in `list`, i.e. how many rows sort before it.
 *  Ties are broken by the row's own position in the tracker (the same tie-break
 *  the stable sort applies), so the slot is the one the row really left from. */
function insertionSlot(list, probe, context, rawIndex) {
  const probeRaw = rawIndex.get(probe) ?? Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < list.length; i++) {
    let cmp = compareByKey(probe, list[i], context.sortKey, context.dir);
    if (cmp === 0 || Number.isNaN(cmp)) {
      cmp = probeRaw < (rawIndex.get(list[i]) ?? Number.MAX_SAFE_INTEGER) ? -1 : 1;
    }
    if (cmp < 0) return i;
  }
  return list.length;
}

/**
 * The report detail page's prev/next navigation (ADR-0036) — one implementation
 * for "where am I in the list I was walking", replacing the page's inline
 * `findIndex` + silent fallback.
 *
 * Three rules make it behave the way the user's queue does:
 *   1. `id` matches the context → plain neighbours, as the list shows them.
 *   2. `id` is a real tracker row but no longer matches the context (the user's
 *      own status write just moved it out of the tab they are walking) → STAY in
 *      that context and report the slot it left from. Falling back to ALL here
 *      was the bug: 下一个 jumped out of the queue into an unrelated report.
 *   3. The context cannot host navigation at all — INBOX (the triage queue is
 *      not the tracker table), an empty view (no slot exists), or an `id` the
 *      tracker does not hold — → the historical fallback to DEFAULT_ORDER, so
 *      deep links and deleted rows keep working exactly as before.
 *
 * Returns { prev, next, position, total, context }: the neighbouring rows (null at
 * the boundaries), the 1-based slot, how many rows that context can walk, and —
 * the part callers get wrong — the context that ACTUALLY took effect, which is
 * what the `?tab=…` links must be built from, not the raw query params.
 *
 * @param {Array} applications - tracker rows, in file order.
 * @param {{tab?: string, min?: number|null, q?: string, sortKey?: string, dir?: number}} ctx
 *   `dir` stays a plain number on purpose: it comes from a URL param, and this
 *   function normalizes it (`1` accepted, everything else descending) rather
 *   than making every caller cast.
 * @param {string} id - the row the page is showing.
 */
export function navNeighbors(applications, ctx = {}, id) {
  const rows = Array.isArray(applications) ? applications : [];
  const requested = normalizeContext(ctx);
  const rawIndex = new Map();
  rows.forEach((r, i) => {
    if (!rawIndex.has(r)) rawIndex.set(r, i);
  });

  let context = requested;
  let list = dedupeById(orderApplications(rows, context));
  let index = list.findIndex((a) => a.n === id);

  if (index === -1) {
    const probe = rows.find((a) => a.n === id) ?? null;
    if (context.tab !== "INBOX" && probe && list.length > 0) {
      const at = insertionSlot(list, probe, context, rawIndex);
      return {
        prev: at > 0 ? list[at - 1] : null,
        next: at < list.length ? list[at] : null,
        // The slot it left from, clamped so a row that departed from the tail
        // cannot read "69 / 68" (its 下一个 is null either way).
        position: Math.min(at + 1, list.length),
        total: list.length,
        context,
      };
    }
    context = { ...DEFAULT_ORDER };
    list = dedupeById(orderApplications(rows, context));
    index = list.findIndex((a) => a.n === id);
  }

  return {
    prev: index > 0 ? list[index - 1] : null,
    next: index >= 0 && index < list.length - 1 ? list[index + 1] : null,
    position: index >= 0 ? index + 1 : null,
    total: list.length,
    context,
  };
}

/**
 * How many of the batch-selected rows the current view HIDES.
 *
 * Deliberately the opposite scope from the explore results bar
 * (`results-view.mjs`), and the contrast is the point — the two labels make
 * different promises:
 *   - explore: 「全选可加入 (N)」 promises what a SELECT-ALL will take, so N must
 *     be the visible set; a count taken over the whole result set made a
 *     filtered confirm write rows the user never saw.
 *   - here: 「已选 N 项」 reports what the user checked. Checking rows in one tab,
 *     filtering, then confirming is a legitimate sequence — the selection is the
 *     batch, the filter is only the window. Narrowing the count here would
 *     silently drop half a batch instead.
 * What must never happen on either surface is acting on rows the user cannot see
 * WITHOUT saying so, so the hidden-but-selected count is shown next to the pill.
 * The action behind it (`reevaluateSelected`) spends real evaluation cost per
 * URL, which is why the invisible part is the part worth naming.
 *
 * `applications` is everything the page holds — not the filtered rows — so a
 * selected row the filter hides is still counted, while a key left over from a
 * finished refresh (no longer in `applications`) is NOT reported as hidden.
 *
 * @param {Array<{n: string}>} applications - every tracker row the page holds.
 * @param {Array<{n: string}>} visible - rows the current tab/filter shows.
 * @param {Set<string>} selected - selected row keys (`r.n`).
 * @returns {number} selected rows that exist but sit outside the current view.
 */
export function countSelectedOffView(applications, visible, selected) {
  if (selected.size === 0) return 0;
  const onScreen = new Set(visible.map((r) => r.n));
  let off = 0;
  for (const a of applications) {
    if (selected.has(a.n) && !onScreen.has(a.n)) off += 1;
  }
  return off;
}

/**
 * Serialize the same context into a URL query string ("?tab=APPLIED&min=4…").
 * Used by pipeline-view.tsx to append context to row links and by the report
 * page to build prev/next + back links — both must emit IDENTICAL queries so a
 * round-trip preserves the view.
 *
 * The tab is ALWAYS serialized: the list page's no-param default is INBOX (the
 * triage queue), which has no tracker rows to link. Omitting tab=ALL would make
 * a row link (and the report page's back link) fall back to INBOX instead of
 * the table the user actually came from. Only min/sort/dir/q — whose omissions
 * resolve to the same tracker-table defaults — are elided.
 * @param {{tab?: string, min?: number|null, q?: string, sortKey?: string, dir?: number}} ctx
 *   `dir` accepts any number (the URL param / navNeighbors' own inferred
 *   return): only `1` means ascending, everything else serializes as descending.
 * @returns {string} "?tab=ALL" for the empty/default context.
 */
export function buildContextQuery(ctx = {}) {
  // Normalized by the same function the sort/filter use — a second copy of the
  // defaulting rules is what would let the serialized query and the list it
  // reproduces drift apart.
  const { tab, min, sortKey, dir } = normalizeContext(ctx);
  const q = (ctx.q ?? "").trim();
  const sp = new URLSearchParams();
  sp.set("tab", tab);
  if (min != null) sp.set("min", String(min));
  if (sortKey !== "score") sp.set("sort", sortKey);
  if (dir !== -1) sp.set("dir", "1");
  if (q) sp.set("q", q);
  return `?${sp.toString()}`;
}
