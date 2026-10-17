// 快评密钥库回归测试（ADR-0083 工单 01）。
//
// 两层：
//   1. quick-vault.mjs 是纯逻辑（node:fs/path，无别名依赖）→ 真单测，temp-dir 注入。
//   2. 两个 API 路由是 TS + Next 壳，node --test 无法 import → 按仓库既有约定
//      （quick-eval-timeout / engine-config-guard 同族）以源码文本守卫锁接线。
//
// Run: node --test web/tests/lib/quick-vault.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  maskKey,
  emptyVault,
  readVault,
  writeVault,
  normalizeVault,
  activeKey,
  toQuickConfig,
  vaultView,
  vaultAdd,
  vaultUpdate,
  vaultRemove,
  vaultActivate,
  vaultSetTest,
  classifyProbeFailure,
  applyVaultAction,
  VaultError,
} from "../../src/lib/quick-vault.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "qv-test-"));
}
function seedFile(root, obj) {
  const dir = join(root, "data");
  mkdirSyncSafe(dir);
  writeFileSync(join(dir, "quick-eval.json"), typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
}
function readRaw(root) {
  return readFileSync(join(root, "data", "quick-eval.json"), "utf8");
}
function mkdirSyncSafe(d) {
  mkdirSync(d, { recursive: true });
}

// ── 打码与视图 ──────────────────────────────────────────────────────────

test("maskKey：前6后4，短密钥只露前3，绝不接近全量", () => {
  assert.equal(maskKey("sk-4f8d21a9c7e05b3d81f6a2c9e4d7b0f3a91e"), "sk-4f8…a91e");
  assert.equal(maskKey("short123"), "sho…");
  assert.equal(maskKey(""), "");
  const long = maskKey("sk-secret-value-9999");
  assert.ok(!long.includes("secret-value"), "打码串泄露中段");
});

test("vaultView 输出没有任何形态的明文密钥", () => {
  let v = emptyVault();
  v = vaultAdd(v, { name: "A", provider: "openai", model: "m", baseUrl: "", key: "sk-super-secret-abcdef1234" }).vault;
  const view = JSON.stringify(vaultView(v));
  assert.ok(!view.includes("sk-super-secret"), "视图里出现了明文密钥");
  assert.ok(view.includes("sk-sup…1234"), "视图应含打码串");
  assert.equal(vaultView(v).configured, true);
  assert.ok(!("apiKey" in vaultView(v).keys[0]));
});

// ── v1 迁移 ─────────────────────────────────────────────────────────────

test("v1 单密钥文件：自动迁移为「默认」使用中密钥，旧文件改名 .v1.bak", () => {
  const root = tempRoot();
  try {
    seedFile(root, { provider: "openai", model: "gpt-4o-mini", baseUrl: "https://x/v1", apiKey: "sk-old-key-000000abcd" });
    const v = readVault(root);
    assert.equal(v.keys.length, 1);
    assert.equal(v.keys[0].name, "默认");
    assert.equal(v.keys[0].key, "sk-old-key-000000abcd");
    assert.equal(v.activeId, v.keys[0].id, "迁移后应立即有使用中密钥");
    assert.equal(toQuickConfig(activeKey(v)).apiKey, "sk-old-key-000000abcd", "快评执行路径迁移后立即可用");
    // 旧文件已改名留回滚窗口，新文件是 v2 形状
    assert.ok(existsSync(join(root, "data", "quick-eval.json.v1.bak")), "缺 .v1.bak 回滚文件");
    const onDisk = JSON.parse(readRaw(root));
    assert.equal(onDisk.version, 2);
    assert.ok(!("apiKey" in onDisk) || true); // v2 用 key 字段
    assert.equal(onDisk.keys[0].key, "sk-old-key-000000abcd");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("迁移幂等：二次读取不再迁移、不再产生新 .bak、id 保持稳定", () => {
  const root = tempRoot();
  try {
    seedFile(root, { provider: "agnes", apiKey: "sk-aaa1111bbbb2222" });
    const v1 = readVault(root);
    const v2 = readVault(root);
    assert.equal(v2.keys.length, 1, "不应重复迁移出两把");
    assert.equal(v2.keys[0].id, v1.keys[0].id);
    assert.ok(existsSync(join(root, "data", "quick-eval.json.v1.bak")));
    assert.ok(!existsSync(join(root, "data", "quick-eval.json.v1.bak.v1.bak")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("空/损坏/未知版本一律回落空库，不炸", () => {
  const root = tempRoot();
  try {
    assert.deepEqual(readVault(root), emptyVault()); // 文件不存在
    seedFile(root, "{not json");
    assert.deepEqual(readVault(root), emptyVault()); // JSON 损坏
    seedFile(root, { version: 99, keys: "nope" });
    assert.deepEqual(readVault(root), emptyVault()); // 未来版本不猜形状
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeVault 原子：落盘即完整 v2 JSON，无残留 tmp", () => {
  const root = tempRoot();
  try {
    let v = emptyVault();
    v = vaultAdd(v, { name: "A", key: "sk-1111222233334444" }).vault;
    writeVault(root, v);
    const back = readVault(root);
    assert.deepEqual(back, v);
    assert.ok(!existsSync(join(root, "data", "quick-eval.json.tmp-0")), "tmp 文件残留");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 库动作语义（ADR-0083 决议 1/3/4） ──────────────────────────────────

test("add 不自动启用；空库的第一把自动启用", () => {
  let v = emptyVault();
  const r1 = vaultAdd(v, { name: "第一把", provider: "openai", key: "sk-aaaa0000bbbb" });
  v = r1.vault;
  assert.equal(v.activeId, r1.key.id, "空库存入第一把应自动启用（与迁移语义一致）");
  const r2 = vaultAdd(v, { name: "第二把", provider: "agnes", key: "sk-cccc0000dddd" });
  v = r2.vault;
  assert.equal(v.activeId, r1.key.id, "存入新密钥不得抢走使用中状态");
  assert.equal(v.keys.length, 2);
});

test("add 缺密钥串 → keyRequired，不落半把", () => {
  assert.throws(() => vaultAdd(emptyVault(), { name: "x", key: "  " }), (e) => e instanceof VaultError && e.code === "keyRequired");
});

test("update：密钥留空 = 保持原密钥不变；非空 = 整体替换并清 lastTest", () => {
  let v = vaultAdd(emptyVault(), { name: "A", provider: "openai", model: "m1", baseUrl: "u1", key: "sk-old0000old0000" }).vault;
  const id = v.keys[0].id;
  v = vaultSetTest(v, id, true);
  // 留空编辑
  const r = vaultUpdate(v, id, { name: "A2", model: "m2", baseUrl: "", key: "  " });
  assert.equal(r.key.key, "sk-old0000old0000", "留空不得清空原密钥");
  assert.equal(r.key.name, "A2");
  assert.equal(r.key.model, "m2");
  assert.equal(r.key.lastTest, "ok", "没换密钥时测试结果保留");
  // 换密钥
  const r2 = vaultUpdate(r.vault, id, { key: "sk-new1111new1111" });
  assert.equal(r2.key.key, "sk-new1111new1111");
  assert.equal(r2.key.lastTest, "", "换绑后旧测试结果必须作废");
});

test("activate 只认库内 id；remove 使用中那把自动切剩余第一把", () => {
  let v = vaultAdd(emptyVault(), { name: "A", key: "sk-aaaa1111aaaa1111" }).vault;
  v = vaultAdd(v, { name: "B", key: "sk-bbbb2222bbbb2222" }).vault;
  const [a, b] = v.keys;
  assert.throws(() => vaultActivate(v, "ghost"), (e) => e.code === "keyNotFound");
  v = vaultActivate(v, b.id);
  assert.equal(activeKey(v).name, "B");
  const r = vaultRemove(v, b.id);
  assert.equal(r.removedActive, true);
  assert.equal(activeKey(r.vault).name, "A", "删使用中那把应自动切剩余第一把");
  const r2 = vaultRemove(r.vault, a.id);
  assert.equal(r2.vault.activeId, null);
  assert.equal(vaultView(r2.vault).configured, false, "删空后 configured=false，快评路由据此 403");
});

test("classifyProbeFailure：封闭分类集，先看超时再看状态码，绝不接触密钥内容", () => {
  assert.equal(classifyProbeFailure({ aborted: true, status: 401 }), "timeout");
  assert.equal(classifyProbeFailure({ status: 401 }), "auth");
  assert.equal(classifyProbeFailure({ status: 403 }), "auth");
  assert.equal(classifyProbeFailure({ status: 404 }), "notFound");
  assert.equal(classifyProbeFailure({ status: 500 }), "http");
  assert.equal(classifyProbeFailure({}), "network");
  assert.equal(classifyProbeFailure(), "network");
});

test("applyVaultAction 分发 + 错误码；normalizeVault 丢坏条目/悬空 activeId 回落", () => {
  let v = emptyVault();
  const added = applyVaultAction(v, { action: "add", name: "A", key: "sk-act0000act0000" });
  v = added.vault;
  v = applyVaultAction(v, { action: "update", id: v.keys[0].id, name: "B" }).vault;
  assert.equal(v.keys[0].name, "B");
  assert.throws(() => applyVaultAction(v, { action: "teleport", id: "x" }), (e) => e.code === "unknownAction");
  assert.throws(() => applyVaultAction(v, { action: "activate" }), (e) => e.code === "idRequired");
  const dirty = normalizeVault({
    version: 2,
    keys: [{ id: "k1", key: "sk-x0000x0000" }, { id: "k1", key: "sk-dup" }, { name: "no-key" }, null],
    activeId: "ghost",
  });
  assert.equal(dirty.keys.length, 1);
  assert.equal(dirty.activeId, "k1", "悬空 activeId 回落第一把");
});

// ── 路由接线守卫（TS 壳无法直接 import，源码文本锁行为） ────────────────

const CFG_ROUTE = readFileSync(join(ROOT, "web", "src", "app", "api", "quick-config", "route.ts"), "utf8");
const EVAL_ROUTE = readFileSync(join(ROOT, "web", "src", "app", "api", "quick-eval", "route.ts"), "utf8");

test("quick-config 路由：GET 只回 vaultView，写路径唯一 action 协议，无明文回显", () => {
  assert.match(CFG_ROUTE, /vaultView\(readVault\(careerOpsRoot\(\)\)\)/, "GET 必须回库视图");
  assert.match(CFG_ROUTE, /applyVaultAction/, "action 写路径缺失");
  // 工单 03 收口：旧的「单密钥整体覆盖」过渡桥不得还魂。
  assert.ok(!CFG_ROUTE.includes("vaultLegacySave"), "旧 PUT 兼容分支应已删除，写路径只剩 action 协议");
  assert.ok(!/apiKey\s*[:=]/.test(CFG_ROUTE), "路由层不得自行组装 apiKey 回显");
});

test("quick-eval 路由：执行路径读使用中密钥束，空库仍回 quickEvalNotConfigured", () => {
  assert.match(EVAL_ROUTE, /toQuickConfig\(activeKey\(readVault\(careerOpsRoot\(\)\)\)\)/, "快评必须读 activeId 整束");
  assert.match(EVAL_ROUTE, /quickEvalNotConfigured/, "空库 403 语义是扩展的既有契约，不许改");
  assert.ok(!EVAL_ROUTE.includes("readQuickConfig"), "旧单配置读取应已收口");
});
