// ADR-0073 的接线守卫：引擎配置的写入边界与跨引擎脏模型守卫。
//
// 与 model-ownership.test.mjs 的分工：那一份钉判定规则本身（纯函数），这一份钉
// 「规则确实被调用在唯一那几个位置上」。config-form.tsx / clis.ts / route.ts 都是
// TS/TSX，`node --test` 导不进来，所以按源码断言 —— 与 clis-coverage.test.mjs、
// unknown-employer-policy.test.mjs 同一套刻意取舍。
//
// 断言只取代码片段（slice + 精确串），不拿注释当证据，也不写会随中文注释漂移的正则。
//
// Run:  node --test web/tests/lib/engine-config-guard.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// 换行统一成 \n：这些断言靠多行片段定位，CRLF 检出不能让它们变成假阳。
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const FORM = read(join(WEB, "src", "components", "config-form.tsx"));
const SAVED = read(join(WEB, "src", "lib", "saved-cli.ts"));
const CLIS = read(join(WEB, "src", "lib", "clis.ts"));
const DICT = read(join(WEB, "src", "lib", "i18n", "clusters", "config.ts"));
const RUN_ROUTE = read(join(WEB, "src", "app", "api", "run", "route.ts"));
const BATCH_EVAL = read(join(WEB, "src", "app", "api", "batch-evaluate", "route.ts"));
const BATCH_CHECKUP = read(join(WEB, "src", "app", "api", "batch-checkup", "route.ts"));

/** [startIdx, endIdx) 之间的片段；起点找不到就直接失败，绝不静默放行。 */
function slice(src, startNeedle, endNeedle, label) {
  const from = src.indexOf(startNeedle);
  assert.ok(from >= 0, `${label}: 起点 "${startNeedle}" 不见了 —— 源码形状变了，守卫需要跟着重写`);
  const to = src.indexOf(endNeedle, from);
  assert.ok(to >= 0, `${label}: 终点 "${endNeedle}" 不见了`);
  return src.slice(from, to);
}

// ── 决议 2：打开配置页不再改写服务端引擎 ──────────────────────────────────────

test("config page never persists the CLI on load", () => {
  // Given: 那次事故的产地就是「一次页面打开 = 一次 POST cliId」
  // Then: 配置页里连这个写通道都不再引用（注释也不留，防止后来者顺手接回去）
  assert.ok(!FORM.includes("persistCliId"), "config-form.tsx 仍引用 persistCliId —— 打开页面就会改写服务端镜像");
  assert.ok(
    FORM.includes('setCliId((prev) => prev || pickDefaultInstalled(list) || "");'),
    "applyClis 不再走「只高亮不落盘」的显示路径",
  );
  assert.ok(FORM.includes("if (!readSavedCliId()) setEngineUnsaved(true);"), "空配置时没有落下「未保存」标记");
});

test("the unsaved-engine notice is wired and translated in both languages", () => {
  assert.ok(FORM.includes('t("config.engineUnsavedHint")'), "引擎卡上没有「未保存」提示的调用点");
  const zhBlock = slice(DICT, "export const zh", "};", "i18n zh");
  assert.ok(DICT.includes('"config.engineUnsavedHint"'), "缺 config.engineUnsavedHint 英文键");
  assert.ok(zhBlock.includes('"config.engineUnsavedHint"'), "缺 config.engineUnsavedHint 中文键");
});

test("an unsaved browser still gets the engine header, but under the honest label", () => {
  // Given: 回执头带着「重新检测」入口 —— 把它整块遮住就是一个找不到刷新按钮的新浏览器
  // Then: 未保存时头仍在，但标签换成「本机默认（未保存）」，不谎称「当前使用」
  assert.ok(
    FORM.includes("const headerCli = currentCli ?? (engineUnsaved ? selectedCli : null);"),
    "引擎头不再为未保存的浏览器兜住「重新检测」入口",
  );
  assert.ok(
    FORM.includes('t(headerUnsaved ? "config.defaultTool" : "config.currentTool")'),
    "未保存时头部标签又在说「当前使用」",
  );
  const zhBlock = slice(DICT, "export const zh", "};", "i18n zh");
  assert.ok(DICT.includes('"config.defaultTool"'), "缺 config.defaultTool 英文键");
  assert.ok(zhBlock.includes('"config.defaultTool"'), "缺 config.defaultTool 中文键");
});

test('"current tool" readout follows the saved pick only', () => {
  // Given: 未保存时下拉里是本机默认 —— 把它点亮就是「没人改过但引擎变了」的界面表现
  assert.ok(
    FORM.includes("const currentCli = savedCliId ? (clis?.find((c) => c.id === savedCliId) ?? null) : null;"),
    "「当前使用」又回退到未保存的默认值了",
  );
});

// ── 决议 1：mode 的唯一真值源是主配置 ────────────────────────────────────────

test("mode restores from the main store, never from the quick-eval store", () => {
  assert.ok(
    FORM.includes('if (v.mode === "cli" || v.mode === "key") setMode(v.mode as Mode);'),
    "主配置不再恢复 mode（或档位集合变了）",
  );
  assert.ok(!FORM.includes("setMode(q."), "快评存储里的 mode 又回来覆盖主配置了 —— 每次打开都会落在快评上");
});

test("the quick-eval store no longer carries mode, and key-mode save writes mode to the main store", () => {
  const keyBranch = slice(FORM, 'if (mode === "key") {', "return; //", "save() key 分支");
  assert.ok(
    keyBranch.includes("JSON.stringify({ provider: savedProvider, model: quickModel, baseUrl: quickBaseUrl })"),
    "快评存储的写入形状变了 —— 只要还带 mode，档位就会再次分裂成两个真值源",
  );
  assert.ok(!keyBranch.includes("{ mode, provider: savedProvider"), "mode 仍被写进快评存储");
  assert.ok(keyBranch.includes("STORAGE_KEY") && keyBranch.includes("\n            mode,"), "key 分支没把档位写进主配置");
});

// ── 决议 3：写 cliId 的两条路径都带模型校正 ──────────────────────────────────

test("both cliId write paths reconcile the model against the engine catalogues", () => {
  assert.ok(FORM.includes("reconcileEnginePick({"), "配置页保存前不再校正模型");
  assert.ok(SAVED.includes("reconcileEnginePick({"), "persistCliId 不再校正模型");
  const persist = slice(SAVED, "export function persistCliId(", "/** 未知雇主策略", "persistCliId");
  assert.ok(persist.includes('if (picked.dropped) patch.model = "";'), "判定为脏组合时没有把 model 一起 POST 掉");
  assert.ok(persist.includes("pushServerConfig(patch)"), "服务端镜像仍在收只带 cliId 的半份配置");
  assert.ok(SAVED.includes("persistCliId(pick, list)"), "resolveCliId 没有把模型目录交给落盘路径（拿不到证据就校正不了）");
});

// ── 决议 4：三条派发路由在拼 argv 前清洗模型 ─────────────────────────────────

test("every dispatch route drops a cross-engine model before building argv", () => {
  for (const [label, src] of [["/api/run", RUN_ROUTE], ["/api/batch-evaluate", BATCH_EVAL], ["/api/batch-checkup", BATCH_CHECKUP]]) {
    assert.ok(src.includes("dropCrossEngineModel(cliId,"), `${label} 少了跨引擎脏模型守卫`);
  }
  // 单任务：账本与池快照读的都是清洗后的值，不谎报一个从未生效的模型（ADR-0043）
  assert.ok(RUN_ROUTE.includes("model: knownModel || undefined,"), "run 账本又记起了原始请求值");
  assert.ok(RUN_ROUTE.includes("model: knownModel,"), "runPipeline / 并发池没拿到清洗后的模型");
  // 批量：变量名即证据 —— 原始请求值只能当守卫的输入，不能再往下游传
  for (const [label, src] of [["/api/batch-evaluate", BATCH_EVAL], ["/api/batch-checkup", BATCH_CHECKUP]]) {
    assert.ok(src.includes("const model = dropCrossEngineModel(cliId, requestedModel);"), `${label} 的清洗点变了`);
    assert.ok(
      src.includes('const requestedModel = typeof body.model === "string" ? body.model : "";'),
      `${label} 的原始模型不再走守卫输入`,
    );
    // 原始值只允许出现两次：声明 + 守卫输入。多一处就是有人把它接下去了。
    assert.equal(
      (src.match(/\brequestedModel\b/g) ?? []).length,
      2,
      `${label} 里未清洗的原始模型被第三处读了 —— 它只能当守卫的输入`,
    );
  }
});

test("the guard reads the static catalogue and never spawns a detection sweep", () => {
  const fn = slice(CLIS, "export function dropCrossEngineModel(", "// `name` comes from cli-labels.mjs", "dropCrossEngineModel");
  assert.ok(fn.includes("dropForeignModel(catalog, cliId, model)"), "守卫不再走共享判定函数（两份规则会漂）");
  assert.ok(!fn.includes("detectClis"), "派发守卫动起了真检测 —— 那会为一次判定 spawn 探针");
});

test("the real incident shape: hy3 belongs to codebuddy, not to claude", () => {
  // 静态表就是守卫的证据来源，这两条断言是它「认得」那次事故的最低保证
  const claudeEntry = slice(CLIS, 'const MODELS: Record<string, ModelMeta> = {\n  claude: {', "  codex: {", "MODELS.claude");
  const codebuddyEntry = slice(CLIS, "  codebuddy: {", "\n};", "MODELS.codebuddy");
  assert.ok(!claudeEntry.includes('"hy3"'), "claude 的目录里出现了 hy3 —— 守卫的判定前提塌了");
  assert.ok(codebuddyEntry.includes('{ id: "hy3"'), "codebuddy 的目录里没有 hy3 —— 守卫的判定前提塌了");
});
