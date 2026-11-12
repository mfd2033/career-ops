// 门禁：任何写盘的路由都必须要么埋一条操作台账，要么在豁免表里写明为什么不用。
//
// 为什么需要这条测试：`/logs` 页面只认埋点，漏一个入口不会报错、不会崩、只是那件事
// 永远不出现在台账里。这种缺失没有任何自动信号，靠 code review 记性只会越来越漏
// （本仓库就漏过 10 个入口，补完之后新入口仍在不断加）。所以把它变成红灯。
//
// 判定口径（与 web/src/lib/op-log-server.ts 顶部的分工一致）：
//   - 用户手动触发的写 → 必须记（/api/cv、/api/profile、/api/portals…）
//   - 自动任务 → 不在这里记，事实源在 runs/index.jsonl 与 scan-runs.tsv
//   - 纯运行产物（缓存、临时文件、启动脚本、派生索引）→ 不记
//
// 豁免表不是「以后再说」的垃圾桶：每条都要写清写的是哪个文件、为什么不记；失效的
// 条目（路由已删或已埋点）同样红灯，否则表会越积越旧，最后没人敢信它。
//
// Run: node --test web/tests/lib/api-write-routes-log.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.resolve(HERE, "../../src/app/api");

/** 认作「写盘」的调用。宁可多认（runTrackerScript 有只读用法），豁免表负责解释。 */
const WRITE_SIGNS = [
  "atomicWriteWithBackup(",
  "writeFileAtomic(",
  "writeFileSync(",
  "appendFileSync(",
  "fs.writeFile(",
  "writeVault(",
  "writeAppConfig(",
  "runTrackerScript(",
];

/** 认作「已埋点」的调用。三者覆盖配置类、单条操作、tracker 行。 */
const LOG_SIGNS = ["logConfigWrite(", "logOperation(", "logTrackerRowWrite("];

/**
 * 写盘但不记台账的路由：相对 `web/src/app/api` 的路径（正斜杠）→ 理由。
 * 加新条目请写「写哪个文件 + 为什么不需要台账」，别写「不需要」三个字。
 */
const EXEMPT = new Map([
  ["apply/prefill/route.ts", "唯一写盘是 .career-ops-web/apply-prefill.log 诊断日志；预填答案只流给浏览器，用户层无变更"],
  ["cv/ingest/route.ts", "只写 os.tmpdir() 下随请求销毁的临时 CV；真正落 cv.md 走 /api/cv 已记 cv-save"],
  ["cv-tailor/route.ts", "后台任务，事实源是 runs/index.jsonl 的 kind:cv-tailor，补埋点会让同一次定制出现两条"],
  ["open-cli-session/route.ts", "写的是 .career-ops-web/open-session.cmd 这份固定启动器，内容未变即跳过"],
  ["quick-eval/test/route.ts", "只改 data/quick-eval.json 的 lastTest 探测位；密钥增删改走 /api/quick-config 已记 quick-key"],
  ["runs/save/route.ts", "写 .career-ops-web/runs/<id>.md 的 worker 日志转存，事实源是同目录 runs/index.jsonl"],
  ["tracker/health/route.ts", "GET 只读探针，下游 tracker.mjs health 不建索引、不拿锁、不写文件"],
  ["tracker/sync/route.ts", "只重建 data/applications.db 派生索引（markdown 才是 SSOT），不改任何行内容"],
]);

function walkRoutes(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkRoutes(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(API_DIR, file).replace(/\\/g, "/");

const scanned = walkRoutes(API_DIR).map((file) => {
  const src = fs.readFileSync(file, "utf8");
  return {
    path: rel(file),
    writes: WRITE_SIGNS.filter((s) => src.includes(s)),
    logs: LOG_SIGNS.some((s) => src.includes(s)),
  };
});

const writing = scanned.filter((r) => r.writes.length > 0);

test("扫描本身有效：认得出的写盘路由数量没有塌掉", () => {
  // 这条防的是正则/目录悄悄失效后整个门禁静默通过——假的绿灯比没有门禁更糟。
  assert.ok(scanned.length >= 60, `只扫到 ${scanned.length} 个 route.ts，目录或递归逻辑可能坏了`);
  assert.ok(writing.length >= 15, `只认到 ${writing.length} 个写盘路由，WRITE_SIGNS 可能已经漂移`);
});

test("写盘路由要么埋了台账，要么在豁免表里写清了理由", () => {
  const missing = writing
    .filter((r) => !r.logs && !EXEMPT.has(r.path))
    .map((r) => `${r.path}  [${r.writes.join(", ")}]`);
  assert.deepEqual(
    missing,
    [],
    `这些路由写盘但没有操作台账：\n  ${missing.join("\n  ")}\n` +
      `补上 logConfigWrite / logOperation / logTrackerRowWrite，或在 EXEMPT 里加一行写明「写哪个文件、为什么不用记」。`,
  );
});

test("豁免表没有失效条目：路由还在、且确实仍未埋点", () => {
  const byPath = new Map(scanned.map((r) => [r.path, r]));
  const stale = [];
  for (const key of EXEMPT.keys()) {
    const row = byPath.get(key);
    if (!row) stale.push(`${key}（路由已不存在）`);
    else if (row.writes.length === 0) stale.push(`${key}（已不再写盘）`);
    else if (row.logs) stale.push(`${key}（已补埋点）`);
  }
  assert.deepEqual(stale, [], `豁免表里有失效条目，删掉它们：\n  ${stale.join("\n  ")}`);
});

test("每条豁免都给了具体理由", () => {
  const weak = [...EXEMPT].filter(([, reason]) => typeof reason !== "string" || reason.trim().length < 12).map(([key]) => key);
  assert.deepEqual(weak, [], `这些豁免理由太笼统，写清写的是哪个文件：${weak.join(", ")}`);
});
