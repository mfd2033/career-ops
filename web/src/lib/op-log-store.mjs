/**
 * op-log-store.mjs — 操作日志的写入链与读盘层。
 *
 * 唯一写入点：`<root>/.career-ops-web/op-log.jsonl`（gitignored 运行产物区，与
 * launcher.log / runs/ 同一片目录，不占用 data/ 的用户层契约）。
 *
 * 为什么放 .career-ops-web/ 而不是 data/：这是纯运行时产物，可丢可重建；用户层
 * （data/）的每个 TSV 都要在 DATA_CONTRACT.md 登记列定义与唯一写入者，而这份台账
 * 的写入者是 dashboard 自己。七日窗口内的历史由既有台账（status-log / runs /
 * scan-runs / follow-ups）补齐，所以这里丢了也不影响回看。
 *
 * 纪律：
 *   1. 一次操作一行 JSON，追加写，绝不原地改（改历史是另一件事）。
 *   2. 写入失败绝不冒泡——台账写不进去不能让用户的操作跟着失败。
 *   3. 类型白名单在 op-log.mjs；未知类型直接拒绝落盘，脏类型进不了页面。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { clipText, isOpLogType } from "./op-log.mjs";

const META_KEY_RE = /^[a-z][a-z-]*$/;
const MAX_READ_LINES = 5000;

/** @param {string} root - career-ops 仓库根 */
export function opLogPath(root) {
  return path.join(root, ".career-ops-web", "op-log.jsonl");
}

/**
 * 追加一条操作记录。调用方不必 try/catch：任何异常（磁盘只读、权限、JSON 序列化）
 * 都被吞掉并返回 null。
 *
 * @param {string} root - career-ops 仓库根
 * @param {object} entry
 * @param {"manual"|"auto"} [entry.trigger] - 默认 manual
 * @param {string} entry.type - 必须命中 OP_LOG_TYPES
 * @param {string} [entry.title] - 主标题（公司 · 岗位 / 任务标题）
 * @param {{k: string, v: string}[]} [entry.meta] - 结构化附加信息
 * @param {"done"|"failed"} [entry.status]
 * @param {number} [entry.durationSec]
 * @param {string} [entry.href] - 站内相对路径
 * @param {string} [entry.dedupeKey] - 与旧台账去重的键
 * @param {number} [entry.at] - epoch ms，默认现在
 * @returns {object|null} 落盘的记录，失败为 null
 */
export function appendOpLog(root, entry) {
  try {
    const type = clipText(entry?.type, 40);
    if (!isOpLogType(type)) return null;
    const rawAt = Number(entry?.at);
    const at = Number.isFinite(rawAt) && rawAt > 0 ? rawAt : Date.now();

    const rec = {
      id: randomUUID(),
      at,
      trigger: entry?.trigger === "auto" ? "auto" : "manual",
      type,
    };
    const title = clipText(entry?.title, 160);
    if (title) rec.title = title;
    const meta = Array.isArray(entry?.meta)
      ? entry.meta
          .filter((m) => m && META_KEY_RE.test(String(m.k ?? "")))
          .map((m) => ({ k: String(m.k), v: clipText(m.v, 120) }))
          .filter((m) => m.v !== "")
          .slice(0, 6)
      : [];
    if (meta.length > 0) rec.meta = meta;
    if (entry?.status === "done" || entry?.status === "failed") rec.status = entry.status;
    const durationSec = Number(entry?.durationSec);
    if (Number.isFinite(durationSec) && durationSec >= 0) rec.durationSec = Math.round(durationSec);
    const href = clipText(entry?.href, 200);
    if (href.startsWith("/")) rec.href = href;
    const dedupeKey = clipText(entry?.dedupeKey, 200);
    if (dedupeKey) rec.dedupeKey = dedupeKey;

    const file = opLogPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
    return rec;
  } catch {
    // 纪律 2：台账失败绝不能影响操作本身。
    return null;
  }
}

/**
 * 读台账。容错：坏行跳过，绝不为一行脏数据抛错；只解析文件末尾 maxLines 行，
 * 让全年滚动的台账不会拖慢每次页面加载。
 *
 * @param {string} root - career-ops 仓库根
 * @param {number} [maxLines] - 最多解析多少行（从文件末尾算）
 * @returns {object[]} 记录数组（文件顺序，老在前）
 */
export function readOpLog(root, maxLines = MAX_READ_LINES) {
  let text;
  try {
    text = fs.readFileSync(opLogPath(root), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const tail = lines.slice(-Math.max(1, maxLines));
  const out = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      continue; // 坏行跳过，不抛
    }
  }
  return out;
}
