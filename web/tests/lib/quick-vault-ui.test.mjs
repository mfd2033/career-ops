// 密钥库卡接线守卫（ADR-0083 工单 02）。
//
// config-form.tsx / key-vault-card.tsx 是 TSX，node --test 导不进来，按仓库约定
// （engine-config-guard 同族）以源码文本锁接线形状：旧单密钥面板不得还魂、
// 密钥库卡必须真的挂在 key 档上、i18n 中英成对。
//
// Run: node --test web/tests/lib/quick-vault-ui.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const FORM = read(join(WEB, "src", "components", "config-form.tsx"));
const CARD = read(join(WEB, "src", "components", "key-vault-card.tsx"));
const TEST_ROUTE = read(join(WEB, "src", "app", "api", "quick-eval", "test", "route.ts"));
const EVAL_LIB = read(join(WEB, "src", "lib", "quick-eval.ts"));
const DICT = read(join(WEB, "src", "lib", "i18n", "clusters", "config.ts"));
const ZH = DICT.slice(DICT.indexOf("export const zh"));

test("旧单密钥面板已退役：provider 顶部大卡与单密钥输入框都不在配置页了", () => {
  assert.ok(!FORM.includes("PROVIDERS.map"), "provider 顶部单选卡又回来了（ADR-0083 决议 1：provider 归入密钥束）");
  assert.ok(!FORM.includes('t("config.pasteKey")'), "旧「粘贴 AI 密钥」单输入框又回来了");
  assert.ok(!FORM.includes("setApiKey"), "config-form 不应再持有 apiKey 状态");
  assert.ok(!FORM.includes("career-ops:quickeval"), "快评 localStorage 镜像已退役");
});

test("密钥库卡挂在 key 档上，activate/add/update/remove 都走 /api/quick-config 的 action 协议", () => {
  assert.ok(FORM.includes("<KeyVaultCard />"), "key 档没挂密钥库卡");
  assert.match(CARD, /action:\s*"activate",\s*id/, "点行切换必须即时 PUT activate");
  assert.match(CARD, /action:\s*"add"/, "添加表单必须走 add 动作");
  assert.match(CARD, /action:\s*"update"/, "编辑表单必须走 update 动作");
  assert.match(CARD, /action:\s*"remove"/, "删除必须走 remove 动作");
  assert.ok(CARD.includes('fetch("/api/quick-config")'), "卡必须从 GET 库视图取数");
});

test("编辑留空=不改密钥的前端侧：只有非空密钥才随 update 提交（ADR-0083 决议 3）", () => {
  // update 请求体里 key 只能条件展开；无条件带 key 就是「留空即清空」的回归。
  assert.match(CARD, /\.\.\.\(key \? \{ key \} : \{\}\)/, "update 的 key 字段必须留空不提交");
  assert.ok(CARD.includes('t("config.vaultKeyKeepHint")'), "编辑态没有明示留空语义");
});

test("删除确认是行内的，且删空/删使用中都有如实回执", () => {
  assert.ok(CARD.includes("confirmDelId"), "行内删除确认态缺失");
  assert.ok(!CARD.includes("confirm("), "不得用全局 confirm 对话框");
  assert.ok(CARD.includes('t("config.vaultDeletedActive"'), "删使用中那把没有自动切换回执");
  assert.ok(CARD.includes('t("config.vaultDeletedEmpty"'), "删空没有引导回执");
});

test("切换失败必须回滚显示——徽标不能谎称已生效（ADR-0073 同教训）", () => {
  const at = CARD.indexOf("async function activate");
  assert.ok(at >= 0, "activate 函数不见了");
  const body = CARD.slice(at, CARD.indexOf("// ── 添加表单"));
  assert.ok(body.includes("setView(before)"), "activate 失败没有回滚到切换前的库视图");
});

test("前端只消费打码串：组件里不存在任何读取明文密钥的路径", () => {
  assert.ok(!CARD.includes("apiKey"), "密钥库卡不应接触 apiKey 字段（GET 视图里根本没有它）");
  assert.ok(CARD.includes("k.masked"), "行上应渲染服务端派生的打码串");
});

test("连接测试（工单 04）：keyId 分支落盘 lastTest，草稿分支绝不写库", () => {
  // 草稿分支（无 keyId）在第一个 writeVault 之前就 return，结构上用 early-return 隔离。
  const draftAt = TEST_ROUTE.indexOf("草稿密钥：只测不落盘");
  const writeAt = TEST_ROUTE.indexOf("writeVault(root, nextVault)");
  assert.ok(draftAt > 0 && writeAt > 0 && draftAt > writeAt, "草稿分支位置异常——它必须在落盘分支之后直接 return，不碰 writeVault");
  assert.ok(!TEST_ROUTE.slice(draftAt).includes("writeVault"), "草稿分支里出现了 writeVault——草稿测试必须不落盘");
  assert.match(TEST_ROUTE, /keyId/, "keyId 分支缺失");
});

test("超时预算层级：探测内层 8s < 前端外层 12s（quick-eval-timeout 同族）", () => {
  const inner = Number(EVAL_LIB.match(/const\s+QUICK_TEST_TIMEOUT_MS\s*=\s*(\d+)/)[1]);
  const outerMatches = [...CARD.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(outerMatches.length >= 2, "行测试与表单测试都应有外层超时");
  for (const outer of outerMatches) {
    assert.ok(outer > inner, `前端外层 ${outer}ms 必须大于探测内层 ${inner}ms，否则外层先 abort、分类文案永远显示不出来`);
  }
  // 内层也不能紧过火：下限 5s，上限仍远小于快评主链路 15s。
  assert.ok(inner >= 5000 && inner < 15000, `探测内层超时 ${inner}ms 超出合理区间`);
});

test("vault 文案中英成对", () => {
  const keys = [
    "config.vaultBundleHint", "config.vaultTitle", "config.vaultCount", "config.vaultEmpty",
    "config.vaultInUse", "config.vaultAdded", "config.vaultAddNew", "config.vaultSwitched",
    "config.vaultSwitchFailed", "config.vaultNeedKey", "config.vaultAddFailed",
    "config.vaultSaveReceipt", "config.vaultAddedFirst", "config.vaultFieldName",
    "config.vaultFieldNameHint", "config.vaultFieldNamePh", "config.vaultKeyLabel",
    "config.vaultKeyStored", "config.vaultReveal", "config.vaultHide", "config.vaultCancel",
    "config.vaultSave", "config.vaultLoadFailed",
    "config.vaultEdit", "config.vaultDelete", "config.vaultDeleteQ", "config.vaultDeleted",
    "config.vaultDeletedActive", "config.vaultDeletedEmpty", "config.vaultDeleteFailed",
    "config.vaultKeyKeepHint", "config.vaultKeyKeepPh", "config.vaultUpdate",
    "config.vaultUpdated", "config.vaultUpdateFailed",
    "config.vaultTest", "config.vaultTesting", "config.vaultTestConn", "config.vaultTestOk",
    "config.vaultTestBadgeOk", "config.vaultTestBadgeFail", "config.vaultTestError",
    "config.vaultTestFailAuth", "config.vaultTestFailNotFound", "config.vaultTestFailTimeout",
    "config.vaultTestFailNetwork", "config.vaultTestFailHttp",
  ];
  for (const key of keys) {
    assert.ok(DICT.includes(`"${key}":`), `缺英文键 ${key}`);
    assert.ok(ZH.includes(`"${key}":`), `缺中文键 ${key}`);
  }
});
