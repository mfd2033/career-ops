import path from "node:path";

// Plain .mjs (same pattern as tracker-table.mjs/pdf-paths.mjs) so both the
// TypeScript side (career-ops.ts) and the Node-run test suites can import it.
// A .ts home would have been unreachable from `node --test`, which is why this
// convention had drifted into two copies before landing here.

/**
 * True for a `{n}-RESERVED.md` placeholder sentinel — never a real report.
 *
 * THE definition of that convention for `web/`. `reserve-report-num.mjs` writes
 * an empty `NNN-RESERVED.md` to claim a report number before a worker has
 * written the report; it is deleted once the real report lands (or GC'd after
 * 4h if abandoned). Two consumers must agree on what that looks like:
 *
 * - `findReportFile` (career-ops.ts) — "RESERVED" sorts before nearly every real
 *   slug, so a surviving sentinel could be returned INSTEAD of the real report,
 *   making the report body and the Apply/PDF-ready checks disappear.
 * - `completedReportNames` (run-cli-support.mjs) — a sentinel must not count as
 *   persistence, or an evaluation that wrote nothing passes the honesty gate.
 *
 * They previously carried separate predicates that already disagreed on
 * `notes-RESERVED.md`; one definition is the point of this module.
 *
 * The number prefix is required: only a numbered sentinel comes from the
 * reservation path, so a hypothetical `notes-RESERVED.md` is a real report.
 *
 * @param {string} file - A filename or path; only the basename is examined.
 * @returns {boolean}
 */
export function isReservedReportFile(file) {
  return /^\d+-RESERVED\.md$/.test(path.basename(file));
}

/**
 * 「报告号 → 文件名」索引（ADR-0098 决议 7）。
 *
 * WHY: 报告定位原先在逐行循环里 `readdirSync(reports/)`（816 行 = 816 次目录扫描，
 * 每次 824 个条目）。目录清单一次读进来建索引，循环里只剩一次 Map 查找。
 *
 * 规则与 `resolveReportPathFor` 的兜底同源：只有 `.md`、跳过 `{n}-RESERVED.md` 哨兵、
 * 号取文件名前缀里的整数。**同号多个文件时首个胜出**——与 `readdir` 的顺序一致，
 * 也与既有 `files.find(...)` 的行为一致，不引入新的优先级。
 *
 * @param {string[]} names - `reports/` 的文件名清单（不含路径）
 * @returns {Map<number, string>} 号 → 文件名
 */
export function reportFileIndex(names) {
  const index = new Map();
  for (const name of names || []) {
    if (typeof name !== "string" || !name.endsWith(".md")) continue;
    if (isReservedReportFile(name)) continue;
    const num = parseInt(name, 10);
    if (!Number.isFinite(num) || index.has(num)) continue;
    index.set(num, name);
  }
  return index;
}
