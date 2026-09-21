// CV 历史版本纯函数库（ADR-0048 决议 1/2/5）。
//
// 「历史」= cv.md 每次经 web 保存时由 safe-write.backup() 留下的
// `cv.md.bak-{时间戳}` 快照文件（.mjs 纯逻辑，node --test 锁定，与
// pipeline-sections.mjs 等解析器同一惯例）。这里只有三件事：
//   1. 从文件名解析时间戳（白名单，不信任任意输入）
//   2. 扫描快照列表（tolerant：目录缺失/文件不可读 → 空列表，绝不抛错）
//   3. 按保留上限清理最旧快照（best-effort，删除失败不抛）
//
// 时间戳格式来自 backup() 的 `toISOString().replace(/[:.]/g, "-")`，
// 即 `2026-09-21T07-48-13-938Z`；本库是它唯一的读取方约定。
import fs from "node:fs";
import path from "node:path";

/** cv.md 快照文件名前缀（`{前缀}{时间戳}` 即完整文件名）。 */
export const CV_BAK_PREFIX = "cv.md.bak-";

/** 快照文件名里时间戳部分的完整白名单：ISO 形态、冒号/点已替换为连字符。
 *  任何不含此形态的输入（含 `..`、路径分隔符、通配符）都无法通过，
 *  这是防路径遍历的第一道闸。 */
const BAK_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** 从快照文件名解析时间戳；非快照文件名返回 null。
 *  例：`cv.md.bak-2026-09-21T07-48-13-938Z` → `2026-09-21T07-48-13-938Z`。 */
export function parseBakTs(filename) {
  if (typeof filename !== "string" || !filename.startsWith(CV_BAK_PREFIX)) return null;
  const ts = filename.slice(CV_BAK_PREFIX.length);
  return BAK_TS_RE.test(ts) ? ts : null;
}

/** 由时间戳重组快照文件名；非白名单时间戳返回 null（API 层防遍历的唯一入口）。 */
export function snapshotFileName(ts) {
  return BAK_TS_RE.test(ts) ? CV_BAK_PREFIX + ts : null;
}

/** 一份历史快照：{ ts, bytes } —— ts 即文件名后缀（UI 主键），bytes 为文件字节数。 */

/**
 * 扫描 root 下的 cv.md 快照 → [{ts, bytes}]，按时间戳倒序（新→旧）。
 * 目录不存在 / 不可读 → []；单个文件 stat 失败则跳过该文件。
 * 时间戳定宽零填充，字典序即时间序，无需 Date 解析。
 */
export function listCvSnapshots(root) {
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const ts = parseBakTs(name);
    if (!ts) continue;
    try {
      const bytes = fs.statSync(path.join(root, name)).size;
      out.push({ ts, bytes });
    } catch {
      // 快照在列出瞬间被删：跳过，不放大为整个列表失败
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return out;
}

/**
 * 按保留上限清理最旧快照（ADR-0048 决议 5），返回删除的文件名数组。
 * 超出 cap 的部分从最旧端删除；删除失败逐个吞掉（best-effort——
 * 清理永远不能让保存本身报错）。
 */
export function pruneCvSnapshots(root, cap = 20) {
  const snaps = listCvSnapshots(root);
  const removed = [];
  for (const s of snaps.slice(cap)) {
    const name = CV_BAK_PREFIX + s.ts;
    try {
      fs.unlinkSync(path.join(root, name));
      removed.push(name);
    } catch {
      // 文件已被并发删除/被锁：留着也无害，下一轮保存再试
    }
  }
  return removed;
}
