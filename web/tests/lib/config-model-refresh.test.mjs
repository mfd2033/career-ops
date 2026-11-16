// AI 引擎页「模型列表单独刷新」的接线守卫。
//
// 与 engine-config-guard.test.mjs 同一取舍：config-form.tsx / clis.ts / route.ts
// 是 TS/TSX，`node --test` 导不进来，按源码断言。断言只取代码片段，不拿注释当证据。
//
// 钉住的行为：
//   1. /api/clis 只在带 cli 参数时走单引擎刷新，未知引擎必须 400，不得静默回落全量；
//   2. 单引擎刷新只重置该引擎自己的模型缓存（opencode / qoder-cn 的模块级缓存），
//      并把结果 splice 回进程内检测缓存——另一个标签页的 plain GET 也要读到新目录；
//   3. 配置页的刷新按钮只对已安装工具出现，在途禁用，结果并回页面状态与浏览器缓存；
//   4. 四条 i18n 文案两种语言都在。
//
// Run:  node --test web/tests/lib/config-model-refresh.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const FORM = read(join(WEB, "src", "components", "config-form.tsx"));
const CLIS = read(join(WEB, "src", "lib", "clis.ts"));
const ROUTE = read(join(WEB, "src", "app", "api", "clis", "route.ts"));
const DICT = read(join(WEB, "src", "lib", "i18n", "clusters", "config.ts"));

/** [startIdx, endIdx) 之间的片段；起点找不到就直接失败，绝不静默放行。 */
function slice(src, startNeedle, endNeedle, label) {
  const from = src.indexOf(startNeedle);
  assert.ok(from >= 0, `${label}: 起点 "${startNeedle}" 不见了 —— 源码形状变了，守卫需要跟着重写`);
  const to = src.indexOf(endNeedle, from);
  assert.ok(to >= 0, `${label}: 终点 "${endNeedle}" 不见了`);
  return src.slice(from, to);
}

// ── 服务端：单引擎刷新入口 ────────────────────────────────────────────────────

test("/api/clis only takes the single-engine path when a cli param is present", () => {
  assert.ok(ROUTE.includes("refreshSingleCliModels(cli)"), "路由没接单引擎刷新");
  // 未知引擎 400：静默回落全量检测会把「刷新一个工具」变成「重扫全部」
  const branch = slice(ROUTE, "if (refresh && cli)", "detectClisCached", "单引擎分支");
  assert.ok(branch.includes('status: 400'), "未知引擎没有返回 400");
  assert.ok(branch.includes("clis: [fresh]"), "单引擎分支没有只返回该引擎一条结果");
});

test("refreshSingleCliModels resets only THAT engine's model cache and splices the result back", () => {
  const fn = slice(CLIS, "export async function refreshSingleCliModels(", "export async function resolveCli(", "refreshSingleCliModels");
  // 两个动态目录引擎的缓存重置必须按 cliId 收窄——无条件重置就成了全量刷新
  assert.ok(fn.includes('if (cliId === "opencode") resetOpencodeModelCache()'), "opencode 的目录缓存没有按引擎收窄重置");
  assert.ok(fn.includes('if (cliId === "qoder-cn") resetQoderModelCache()'), "qoder-cn 的目录缓存没有按引擎收窄重置");
  assert.ok(!fn.includes("resetOpencodeModelCache();\n  resetQoderModelCache();"), "两个缓存被无条件重置了 —— 这就成了全量刷新");
  // 结果必须并回进程内检测缓存：另一个标签页的 plain GET 才能读到新目录
  assert.ok(fn.includes("cachedDetection = cachedDetection.map"), "刷新结果没有并回进程内检测缓存");
  assert.ok(fn.includes("detectOneCli(spec,"), "单引擎刷新没有复用 per-engine 检测（自己另写一套会漂）");
});

test("detectClis reuses the same per-engine detection as the single refresh", () => {
  // 两套检测路径各写一份，模型目录的读取规则迟早漂移（opencode/qoder/claude 三处特判）
  assert.ok(CLIS.includes("function detectOneCli("), "没有抽出 per-engine 检测函数");
  const sweep = slice(CLIS, "export async function detectClis(", "export async function refreshSingleCliModels(", "detectClis");
  assert.ok(sweep.includes("detectOneCli(c, customDirs)"), "全量检测没有走共享的 per-engine 路径");
});

// ── 配置页：按钮、状态与合并 ─────────────────────────────────────────────────

test("the config page wires a per-tool refresh and merges the fresh entry into state + cache", () => {
  assert.ok(FORM.includes("/api/clis?refresh=1&cli="), "配置页没有调用单引擎刷新端点");
  assert.ok(FORM.includes("refreshModelsFor("), "配置页没有单工具刷新的处理函数");
  const fn = slice(FORM, "async function refreshModelsFor(", "async function testCliDir(", "refreshModelsFor");
  // 成功结果必须并回浏览器缓存（ADR-0015：缓存是页面的渲染事实源），失败不碰旧列表
  assert.ok(fn.includes("writeClisCache(next)"), "刷新成功没有回写浏览器侧检测缓存");
  assert.ok(!fn.includes("setClis([]"), "失败路径不得清空页面列表");
  // 头部「重新检测」与单工具刷新互斥：全量重扫进行中不能再点单工具刷新
  assert.ok(fn.includes("if (modelRefreshingFor) return;"), "单工具刷新没有在途防抖");
});

test("the refresh button is gated on an installed tool and disabled while busy", () => {
  const block = slice(FORM, "async function refreshModelsFor(", "async function testCliDir(", "refreshModelsFor 周边状态");
  assert.ok(block.length > 0);
  assert.ok(FORM.includes("selectedCli.installed"), "刷新入口没有按已安装工具收口");
  assert.ok(
    FORM.includes("disabled={modelRefreshingFor !== null || rechecking}"),
    "刷新按钮没有在全量重检或自身在途时禁用",
  );
  assert.ok(FORM.includes('t("config.modelRefreshing")'), "刷新中没有进行态文案");
  assert.ok(FORM.includes('t("config.modelRefreshFailed")'), "失败没有如实回执");
  assert.ok(FORM.includes("aria-live=\"polite\""), "回执行不是 live region —— 读屏用户收不到结果");
});

// ── 文案 ─────────────────────────────────────────────────────────────────────

test("the four refresh strings exist in both languages", () => {
  const keys = ["config.modelRefresh", "config.modelRefreshing", "config.modelRefreshed", "config.modelRefreshFailed"];
  const zhBlock = slice(DICT, "export const zh", "};", "i18n zh");
  for (const key of keys) {
    assert.ok(DICT.includes(`"${key}"`), `缺 ${key} 英文键`);
    assert.ok(zhBlock.includes(`"${key}"`), `缺 ${key} 中文键`);
  }
  assert.ok(FORM.includes('t("config.modelRefreshed", { name:'), "成功回执没有带工具名");
});
