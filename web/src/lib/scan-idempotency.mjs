// scan-idempotency.mjs — route 层的 scanId 幂等(ADR-0007 E5 第二层)。
//
// pipeline.md 与 scan-history.tsv 的写入方(addOffersToPipeline)不去重,幂等必须在
// 路由侧兜底。文档 /api/explore/add 的 content script 采集是"同 scanId、跨批次
// 增量 URL"(本页已采 URL Set 已是最内层去重),故本层把幂等键定为 (scanId, 归一URL):
//   • 同一扫描会话里,某 URL 已被写过 → 重放/连点不重写(不新增行);
//   • 同 scanId 的不同批次(不同 URL)仍各自正常写入(不会被整会话幂等误杀)。
// 纯逻辑 partitionNewOffers 供 node:test 直接 import;load/save 做 TSV 落盘
// (data/scan-idempotency.tsv, tab 分隔 scanId<TAB>urlKey)。

import fs from "node:fs";
import normalizeUrl from "./core/url-key.mjs";

/**
 * 按 (scanId, 归一URL) 把 offers 切成"待写"与"已写/无效跳过"两部分。
 * 纯函数:不修改传入 map/addOffers。scanId 为空 → 全部当作待写(legacy 路径)。
 *
 * @param {Map<string, Set<string>>} map  scanId → 已写 URL key 集合(loadScanMap 装载)
 * @param {string} scanId
 * @param {Array} offers
 * @param {(url:string)=>string} [keyOf]  URL → 幂等键(默认 url-key.mjs normalizeUrl)
 * @returns {{newOffers:Array, skipped:number, keysToAdd:string[]}}
 */
export function partitionNewOffers(map, scanId, offers, keyOf = normalizeUrl) {
  const id = String(scanId ?? "").trim();
  const list = Array.isArray(offers) ? offers : [];
  if (!id) return { newOffers: list.slice(), skipped: 0, keysToAdd: [] };

  const acc = new Set(map.get(id) || new Set()); // 只读快照,partition 不改源 map
  const newOffers = [];
  const keysToAdd = [];
  let skipped = 0;
  for (const o of list) {
    const url = o && typeof o.url === "string" ? o.url : "";
    const key = url ? keyOf(url) : "";
    if (!key || acc.has(key)) {
      skipped += 1;
      continue;
    }
    acc.add(key);
    newOffers.push(o);
    keysToAdd.push(key);
  }
  return { newOffers, skipped, keysToAdd };
}

/**
 * 读取 TSV 幂等表 → Map<scanId, Set<urlKey>>。文件不存在/空 → 空表。
 * 每行 `scanId\turlKey`,非法行(缺分隔/空段)跳过。
 */
export function loadScanMap(filePath) {
  const map = new Map();
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return map; // 首跑无表
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const idx = line.indexOf("\t");
    if (idx <= 0) continue;
    const sid = line.slice(0, idx).trim();
    const key = line.slice(idx + 1);
    if (!sid || !key) continue;
    if (!map.has(sid)) map.set(sid, new Set());
    map.get(sid).add(key);
  }
  return map;
}

/** 把 Map<scanId, Set<urlKey>> 同步写回 TSV(应只在"有新增键"时调用)。 */
export function saveScanMap(filePath, map) {
  const lines = [];
  for (const [sid, keys] of map) {
    for (const k of keys) lines.push(`${sid}\t${k}`);
  }
  fs.writeFileSync(filePath, lines.length ? lines.join("\n") + "\n" : "");
}

/** career-ops data/ 下的幂等表路径拼接(Traverse-safe:仅在这拼接相对文件名)。 */
export function scanIdempotencyPath(dataDir) {
  return typeof dataDir === "string" && dataDir ? `${dataDir}/scan-idempotency.tsv` : "";
}