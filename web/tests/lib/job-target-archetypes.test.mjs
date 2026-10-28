// job-target-archetypes.test.mjs — 求职意向卡的原型（archetypes）名单契约。
//
// 探索页/扫描的关键词播种口径是 target_roles.primary + archetypes[].name 合并
// （与核心 providers/_profile-keywords.mjs 同口径，ADR-0091），但配置页此前只
// 能编辑 primary，archetypes 成了用户看不见、也改不了的第二真相源——探索页
// 关键词框里冒出的「多出来的词」无处可解释。
//
// 这组测试锁定三件事：
//   1. reconcileArchetypes 按名对账：旧名字整条对象原样保留（level/fit/未知键
//      都不丢），新名字补 {name, fit:"primary"}，输出顺序跟随新名单，重名去重。
//   2. extractArchetypes / patchToProfile 的容错映射：畸形 profile 不 throw，
//      空名单 → null 删键（mergeYamlPatch 的 null 语义），undefined 不产出键。
//   3. 等价门：route 的真实写路径（extract → reconcile → patchToProfile →
//      文本级 merge）写出的 YAML load 回来与预期完全一致，且对象块之外的字节
//      （含注释）逐字保留。

import { test } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "js-yaml";
import { extractArchetypes, patchToProfile, reconcileArchetypes } from "../../src/lib/profile-patch.mjs";
import { mergeYamlPatch } from "../../src/lib/core/profile-merge.mjs";

const EXISTING = [
  { name: "软件项目经理", level: "资深", fit: "primary" },
  { name: "技术经理", level: "资深", fit: "primary" },
];

test("reconcile：旧名字整条保留，新名字补默认 fit，顺序跟随新名单", () => {
  const out = reconcileArchetypes(EXISTING, ["技术经理", "研发总监"]);
  assert.deepEqual(out, [
    { name: "技术经理", level: "资深", fit: "primary" }, // 旧对象原样（同一份引用语义的深等价）
    { name: "研发总监", fit: "primary" }, // 新名字，无 level
  ]);
});

test("reconcile：名单里删掉的名字不出现，未提及≠删除（undefined 另走不动分支）", () => {
  assert.deepEqual(reconcileArchetypes(EXISTING, ["软件项目经理"]), [EXISTING[0]]);
});

test("reconcile：重名去重取首次出现，空白项丢弃，非字符串 String 化（与 deal_breakers 同风格）", () => {
  const out = reconcileArchetypes(EXISTING, ["技术经理", " 技术经理 ", "", null, 42]);
  assert.deepEqual(out.map((e) => e.name), ["技术经理", "42"]);
});

test("reconcile：existing 畸形（非数组/条目缺 name）不 throw，只认字符串名字", () => {
  const messy = ["裸字符串条目", { level: "资深" }, { name: "技术经理", level: "资深" }, null];
  assert.deepEqual(reconcileArchetypes(messy, ["软件项目经理", "技术经理"]), [
    { name: "软件项目经理", fit: "primary" },
    { name: "技术经理", level: "资深" },
  ]);
  assert.deepEqual(reconcileArchetypes(undefined, ["A"]), [{ name: "A", fit: "primary" }]);
  assert.deepEqual(reconcileArchetypes(EXISTING, []), []);
});

test("reconcile：按名匹配前两侧归一（trim 不对称 / 数字名）不丢画像字段", () => {
  // 磁盘上 name 带首尾空白、或是 YAML 解析出的数字 —— 都是手改残留的真实形态；
  // 匹配身份统一归一，命中则整条对象原样保留（name 本身不动）。
  const messy = [{ name: " TechLead ", level: "资深", fit: "primary" }, { name: 2026, fit: "adjacent" }];
  assert.deepEqual(reconcileArchetypes(messy, ["TechLead", "2026"]), [
    { name: " TechLead ", level: "资深", fit: "primary" },
    { name: 2026, fit: "adjacent" },
  ]);
});

// ── ADR-0092：对象条目（{name, level?, fit?}）的覆盖/沿用语义 ──

// 字符串条目行为与 ADR-0091 完全一致（上方测试即回归锁）；这里锁对象条目的
// 三态：合法覆盖、缺失沿用、非法回退。

test("reconcile：对象条目——合法 fit 与非空 level 覆盖磁盘值", () => {
  const out = reconcileArchetypes(EXISTING, [
    { name: "软件项目经理", level: "Senior/Staff", fit: "adjacent" },
  ]);
  assert.deepEqual(out, [{ name: "软件项目经理", level: "Senior/Staff", fit: "adjacent" }]);
});

test("reconcile：缺失/空白 level 与 fit 沿用磁盘旧值，未知键保留", () => {
  const existing = [{ name: "技术经理", level: "资深", fit: "secondary", source: "手工" }];
  const out = reconcileArchetypes(existing, [{ name: "技术经理" }, "技术经理"]);
  assert.deepEqual(out, [{ name: "技术经理", level: "资深", fit: "secondary", source: "手工" }]);
});

test("reconcile：非法 fit（枚举外）按未提供处理——旧名字沿用磁盘值，新名字缺省 primary", () => {
  const out = reconcileArchetypes(EXISTING, [
    { name: "软件项目经理", fit: "stretch" },
    { name: "研发总监", fit: "stretch" },
  ]);
  assert.deepEqual(out, [
    { name: "软件项目经理", level: "资深", fit: "primary" },
    { name: "研发总监", fit: "primary" },
  ]);
});

test("reconcile：新名字用提交的 level/fit；level 空白不带 level 键", () => {
  const out = reconcileArchetypes([], [
    { name: "产品经理", level: "高级", fit: "secondary" },
    { name: "技术经理", level: "  ", fit: "adjacent" },
  ]);
  assert.deepEqual(out, [
    { name: "产品经理", level: "高级", fit: "secondary" },
    { name: "技术经理", fit: "adjacent" },
  ]);
});

test("reconcile：字符串与对象条目混用，trim 与去重跨形态一致", () => {
  const out = reconcileArchetypes(EXISTING, [" 软件项目经理 ", { name: "研发总监", fit: "adjacent" }]);
  assert.deepEqual(out, [EXISTING[0], { name: "研发总监", fit: "adjacent" }]);
});

test("extract：畸形 profile 容错为空数组，正常 profile 取出对象条目", () => {
  assert.deepEqual(extractArchetypes({ target_roles: { archetypes: EXISTING } }), EXISTING);
  assert.deepEqual(extractArchetypes({ target_roles: { archetypes: ["字符串条目", { name: "技术经理" }] } }), [
    { name: "技术经理" },
  ]);
  // 数字/布尔名是 YAML 会自动改型的手写形态：预填要可见，否则用户一保存就静默丢。
  assert.deepEqual(extractArchetypes({ target_roles: { archetypes: [{ name: 2026, fit: "adjacent" }, { name: true }] } }), [
    { name: 2026, fit: "adjacent" },
    { name: true },
  ]);
  assert.deepEqual(extractArchetypes({}), []);
  assert.deepEqual(extractArchetypes(null), []);
  assert.deepEqual(extractArchetypes({ target_roles: { archetypes: "标量" } }), []);
});

test("patchToProfile：archetypes 名单进 target_roles，与 primary 同 patch 合并", () => {
  const out = patchToProfile(
    { roles: ["软件项目经理"], archetypes: ["软件项目经理", "技术经理"] },
    EXISTING,
  );
  assert.deepEqual(out.target_roles, {
    primary: ["软件项目经理"],
    archetypes: [EXISTING[0], EXISTING[1]],
  });
});

test("patchToProfile：空 archetypes → null 删键；undefined → 不产出键", () => {
  const cleared = patchToProfile({ archetypes: [] }, EXISTING);
  assert.deepEqual(cleared, { target_roles: { archetypes: null } });

  const untouched = patchToProfile({ roles: ["软件项目经理"] }, EXISTING);
  assert.deepEqual(untouched.target_roles, { primary: ["软件项目经理"] });

  // 全空白名单等价于空名单（UI 已 trim 过一遍，这里是纵深防御）。
  assert.deepEqual(patchToProfile({ archetypes: ["  ", ""] }, EXISTING), { target_roles: { archetypes: null } });
});

// ── 等价门：route 的真实写路径 ──

const PROFILE = [
  "# 求职档案 —— 配置页与 CLI 读的都是这一份。",
  "candidate:",
  "  full_name: 张三",
  "target_roles:",
  "  primary:",
  "    - 软件项目经理",
  "  archetypes:",
  "    - name: 软件项目经理",
  "      level: 资深",
  "      fit: primary",
  "compensation:",
  "  target_range: 25K-30K  # 结算币种与底线见同块注释",
].join("\n");

test("等价门：删一名加一名后 load 回来与预期一致，对象块之外逐字保留", () => {
  // route 的组合：GET/POST 先 extract，POST 用 reconcile 出的对象列表走文本级 merge。
  const doc = yaml.load(PROFILE);
  const existing = extractArchetypes(doc);
  const proposed = patchToProfile({ roles: ["软件项目经理"], archetypes: ["软件项目经理", "研发总监"] }, existing);
  const { text, skipped } = mergeYamlPatch(PROFILE, proposed);
  assert.deepEqual(skipped, []);

  const after = yaml.load(text);
  assert.deepEqual(after.target_roles, {
    primary: ["软件项目经理"],
    archetypes: [
      { name: "软件项目经理", level: "资深", fit: "primary" },
      { name: "研发总监", fit: "primary" },
    ],
  });
  // 「技术经理」条目随名单整体替换被移除；其余字节（头注释、行内注释）原样。
  assert.ok(!text.includes("技术经理"));
  assert.ok(text.includes("# 求职档案 —— 配置页与 CLI 读的都是这一份。"));
  assert.ok(text.includes("target_range: 25K-30K  # 结算币种与底线见同块注释"));
});

test("等价门：清空名单删整个 archetypes 键，primary 不受牵连", () => {
  const existing = extractArchetypes(yaml.load(PROFILE));
  const proposed = patchToProfile({ roles: ["软件项目经理"], archetypes: [] }, existing);
  const { text } = mergeYamlPatch(PROFILE, proposed);
  const doc = yaml.load(text);
  assert.deepEqual(doc.target_roles, { primary: ["软件项目经理"] });
  assert.ok(!text.includes("archetypes"));
});

test("等价门：对象条目覆盖 level/fit 后 load 回来一致，注释逐字保留", () => {
  const doc = yaml.load(PROFILE);
  const existing = extractArchetypes(doc);
  const proposed = patchToProfile(
    { roles: ["软件项目经理"], archetypes: [{ name: "软件项目经理", level: "Staff", fit: "adjacent" }, "研发总监"] },
    existing,
  );
  const { text, skipped } = mergeYamlPatch(PROFILE, proposed);
  assert.deepEqual(skipped, []);

  const after = yaml.load(text);
  assert.deepEqual(after.target_roles.archetypes, [
    { name: "软件项目经理", level: "Staff", fit: "adjacent" },
    { name: "研发总监", fit: "primary" },
  ]);
  assert.ok(text.includes("# 求职档案 —— 配置页与 CLI 读的都是这一份。"));
  assert.ok(text.includes("target_range: 25K-30K  # 结算币种与底线见同块注释"));
});
