// profile-merge.test.mjs — 配置页保存后，profile.yml 里的注释必须还在。
//
// The config page used to write profile.yml with `yaml.load` → `yaml.dump`. A
// round-trip deletes every comment in the document, and nothing on screen says
// it happened — the user just watches the notes they wrote beside their
// targeting decisions disappear on Save. profile.yml is the user layer, so
// those notes are the rationale for the settings.
//
// So the writer is text surgery: splice only the leaves the patch carries. These
// tests pin what a round-trip cannot give you — that untouched bytes survive,
// that a scalar's trailing comment survives its value being replaced, and that
// clearing a key takes its own comment block with it instead of leaving an
// orphaned explanation behind.
//
// The last test is the equivalence gate: for every patch shape the two routes
// actually send, the spliced text must load to exactly what a deep merge would
// have produced. Without it, "comments survive" could be true while the values
// silently stop matching the form.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "js-yaml";
import { mergeYamlPatch } from "../../src/lib/core/profile-merge.mjs";

/** A hand-maintained profile.yml: real structure, placeholder identity. */
const PROFILE = [
  "# 求职档案 —— 配置页与 CLI 读的都是这一份。",
  "# 改之前先看 ADR-0087。",
  "candidate:",
  "  full_name: 张三",
  "  email: zhangsan@example.com",
  "  location: 郑州",
  "target_roles:",
  "  primary:",
  "    - 软件项目经理",
  "  archetypes:",
  "    - name: 软件项目经理",
  "      level: 资深",
  "compensation:",
  "  target_range: 25K-30K",
  "  currency: CNY  # 结算币种，不要改成 RMB",
  "  minimum: 25K",
  "language:",
  "  output: zh-CN",
  "  # 评估模式（ADR-0087 / CO-65）：市场词汇与评分规则取自该目录的模式集，",
  "  # 报告语言仍由上面的 output 决定。",
  "  modes_dir: modes/zh",
  "narrative:",
  "  deal_breakers:",
  "    - 不做外包",
  "    - 不出差",
  "followup_cadence:",
  "  applied_first_days: 7",
  "",
].join("\n");

const linesOf = (text) => text.split("\n");
const idx = (text, needle) => linesOf(text).findIndex((l) => l.includes(needle));

/** Test-side model of what the merge is supposed to produce (the routes' contract). */
function expectedDoc(patch) {
  const doc = yaml.load(PROFILE);
  const walk = (target, node) => {
    for (const [k, v] of Object.entries(node)) {
      if (v === undefined) continue;
      if (v === null) {
        delete target[k];
        continue;
      }
      if (v && typeof v === "object" && !Array.isArray(v)) {
        target[k] = v && typeof target[k] === "object" && !Array.isArray(target[k]) ? target[k] : {};
        walk(target[k], v);
        continue;
      }
      target[k] = v;
    }
  };
  walk(doc, patch);
  return doc;
}

test("改一个标量：只有那一行变，其余字节（含全部注释）原样保留", () => {
  const { text, changed, written } = mergeYamlPatch(PROFILE, { language: { modes_dir: "modes/de" } });
  assert.equal(changed, true);
  assert.deepEqual(written, ["language.modes_dir"]);

  const before = linesOf(PROFILE);
  const after = linesOf(text);
  assert.equal(after.length, before.length, "行数不该变");
  const changedLines = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
  assert.deepEqual(changedLines, [idx(PROFILE, "modes_dir:")], "只有 modes_dir 那一行允许变");
  assert.ok(text.includes("  modes_dir: modes/de"));
  // 注释还在，且仍紧贴在键上方。
  assert.ok(text.includes("# 评估模式（ADR-0087 / CO-65）：市场词汇与评分规则取自该目录的模式集，"));
});

test("行内注释跟着值走：换掉 currency 的值，`# 结算币种` 不能丢", () => {
  const { text } = mergeYamlPatch(PROFILE, { compensation: { currency: "EUR" } });
  assert.ok(text.includes("  currency: EUR  # 结算币种，不要改成 RMB"));
});

test("清空一个键：连同它上方的注释块一起删，不留孤儿的说明", () => {
  const { text, removed } = mergeYamlPatch(PROFILE, { language: { modes_dir: null } });
  assert.deepEqual(removed, ["language.modes_dir"]);
  assert.ok(!text.includes("modes_dir"), "键应被删掉");
  assert.ok(!text.includes("评估模式（ADR-0087"), "它自己的两行注释也要一起删");
  // 兄弟键与文件头注释不受牵连。
  assert.ok(text.includes("  output: zh-CN"));
  assert.ok(text.includes("# 求职档案 —— 配置页与 CLI 读的都是这一份。"));
  assert.deepEqual(yaml.load(text).language, { output: "zh-CN" });
});

test("列表整体替换：旧项全删、新项按块序列写出，后续段落不受影响", () => {
  const { text } = mergeYamlPatch(PROFILE, { narrative: { deal_breakers: ["不做外包"] } });
  const after = linesOf(text);
  assert.equal(after.filter((l) => l.trim() === "- 不出差").length, 0);
  assert.equal(after.filter((l) => l.trim() === "- 不做外包").length, 1);
  assert.deepEqual(yaml.load(text).narrative.deal_breakers, ["不做外包"]);
  // `followup_cadence:` 仍是顶层，没被吞进序列。
  assert.ok(text.includes("\nfollowup_cadence:\n  applied_first_days: 7\n"));
});

test("新增缺失的子键：插在父块内容末尾，不越过父块", () => {
  const { text } = mergeYamlPatch(PROFILE, { compensation: { location_flexibility: "郑州本地优先，可接受远程" } });
  assert.deepEqual(yaml.load(text).compensation, {
    target_range: "25K-30K",
    currency: "CNY",
    minimum: "25K",
    location_flexibility: "郑州本地优先，可接受远程",
  });
  // 落在 compensation 块的最后一行，而不是文件末尾。
  const after = linesOf(text);
  const inserted = after.findIndex((l) => l.includes("location_flexibility"));
  assert.ok(inserted > idx(text, "minimum:"));
  assert.ok(inserted < idx(text, "language:"));
});

test("父块整个缺失：级联创建父级，值仍落在正确的深度", () => {
  const withoutLanguage = linesOf(PROFILE)
    .filter((_, i) => i < idx(PROFILE, "language:") || i > idx(PROFILE, "modes_dir:"))
    .join("\n");
  const { text } = mergeYamlPatch(withoutLanguage, { language: { modes_dir: "modes/ja" } });
  assert.deepEqual(yaml.load(text).language, { modes_dir: "modes/ja" });
  assert.ok(text.includes("\nlanguage:\n  modes_dir: modes/ja"));
});

test("类型不被 YAML 改写：数字留数字，数字形态的字符串加引号", () => {
  const { text } = mergeYamlPatch(PROFILE, {
    followup_cadence: { applied_first_days: 3, applied_max_followups: "007" },
  });
  const doc = yaml.load(text);
  assert.equal(doc.followup_cadence.applied_first_days, 3);
  assert.equal(doc.followup_cadence.applied_max_followups, "007", "前导零的字符串不能被当数字");
  assert.ok(text.includes("applied_first_days: 3"));
  assert.ok(text.includes('applied_max_followups: "007"'));
});

test("值里的 `: ` 与 ` #` 会被引号保护，往返后仍是同一个字符串", () => {
  const value = "注意: 这是 #1 优先";
  const { text } = mergeYamlPatch(PROFILE, { compensation: { location_flexibility: value } });
  assert.equal(yaml.load(text).compensation.location_flexibility, value);
});

test("幂等：同样的 patch 再来一次，文本不再变", () => {
  const patch = { candidate: { full_name: "李四" }, language: { modes_dir: "modes/de" } };
  const once = mergeYamlPatch(PROFILE, patch).text;
  const twice = mergeYamlPatch(once, patch);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});

test("拒绝把带子块的键改写成标量（宁可跳过，也不吞掉子块）", () => {
  const { text, changed, skipped } = mergeYamlPatch(PROFILE, { candidate: "张三" });
  assert.deepEqual(skipped, ["candidate"]);
  assert.equal(changed, false);
  assert.equal(text, PROFILE);
});

test("等价门：配置页一次完整保存后，load 出来的值与 deepMerge 的预期完全一致", () => {
  const patch = {
    candidate: { full_name: "李四", email: "lisi@example.com", location: "上海" },
    target_roles: { primary: ["技术经理", "研发总监"] },
    compensation: { target_range: "30K-40K", currency: "EUR", location_flexibility: "远程" },
    narrative: { deal_breakers: ["不做外包"] },
    language: { modes_dir: "modes/de" },
    followup_cadence: { applied_first_days: 3, applied_subsequent_days: 5, applied_max_followups: 2 },
  };
  const { text, changed, skipped } = mergeYamlPatch(PROFILE, patch);
  assert.equal(changed, true);
  assert.deepEqual(skipped, []);
  assert.deepEqual(yaml.load(text), expectedDoc(patch));
  // 且整份文件除被改动的行外一字未动。
  assert.ok(text.includes("# 求职档案 —— 配置页与 CLI 读的都是这一份。"));
  assert.ok(text.includes("    - name: 软件项目经理"));
  assert.ok(text.includes("  # 评估模式（ADR-0087 / CO-65）：市场词汇与评分规则取自该目录的模式集，"));
});

test("全部清空后再写回：等价门也成立", () => {
  const cleared = mergeYamlPatch(PROFILE, { language: { modes_dir: null } }).text;
  const patch = { language: { modes_dir: "modes/zh" } };
  const back = mergeYamlPatch(cleared, patch).text;
  assert.deepEqual(yaml.load(back), expectedDoc(patch));
  // 清空时删掉的那两行注释不会自己长回来（那是用户没再写的事实，不假装恢复）。
  assert.ok(!back.includes("评估模式（ADR-0087"));
});

// ── 对象块列表（ADR-0091）：archetypes 这类 {name, level, fit} 条目 ──

test("对象块列表整体替换：写成块映射，其余字节与注释逐字保留", () => {
  const patch = {
    target_roles: {
      archetypes: [
        { name: "软件项目经理", level: "资深", fit: "primary" },
        { name: "技术经理", fit: "primary" },
      ],
    },
  };
  const { text, changed, written, skipped } = mergeYamlPatch(PROFILE, patch);
  assert.deepEqual(written, ["target_roles.archetypes"]);
  assert.deepEqual(skipped, []);
  assert.equal(changed, true);
  assert.deepEqual(yaml.load(text).target_roles.archetypes, [
    { name: "软件项目经理", level: "资深", fit: "primary" },
    { name: "技术经理", fit: "primary" },
  ]);
  // 块形态：首键跟在 "- " 后，后续键与首键列对齐（PROFILE 的 item 缩进是 4 空格）。
  assert.ok(text.includes("    - name: 软件项目经理\n      level: 资深\n      fit: primary"));
  assert.ok(text.includes("    - name: 技术经理\n      fit: primary"));
  // 未触碰的字节：文件头注释、primary、后续段落原样。
  assert.ok(text.includes("# 求职档案 —— 配置页与 CLI 读的都是这一份。"));
  assert.ok(text.includes("  primary:\n    - 软件项目经理"));
  assert.ok(text.includes("\ncompensation:\n  target_range: 25K-30K"));
});

test("对象条目的值走标量渲染：数字留数字、特殊字符串加引号", () => {
  const patch = { target_roles: { archetypes: [{ name: "注意: 这是 #1", level: 3, bare: "007" }] } };
  const { text, skipped } = mergeYamlPatch(PROFILE, patch);
  assert.deepEqual(skipped, []);
  assert.ok(text.includes('    - name: "注意: 这是 #1"'));
  assert.ok(text.includes("      level: 3"));
  assert.ok(text.includes('      bare: "007"'));
  assert.deepEqual(yaml.load(text).target_roles.archetypes, [{ name: "注意: 这是 #1", level: 3, bare: "007" }]);
});

test("对象条目与标量条目可混排；嵌套对象值宁可拒写也不留半个块", () => {
  const mixed = mergeYamlPatch(PROFILE, { target_roles: { archetypes: ["替补", { name: "技术经理" }] } });
  assert.deepEqual(yaml.load(mixed.text).target_roles.archetypes, ["替补", { name: "技术经理" }]);

  const nested = mergeYamlPatch(PROFILE, { target_roles: { archetypes: [{ name: { deep: 1 } }] } });
  assert.deepEqual(nested.skipped, ["target_roles.archetypes"]);
  assert.equal(nested.changed, false);
  assert.equal(nested.text, PROFILE);
});

test("对象块写入幂等：同一 patch 再来一次文本不变", () => {
  const patch = { target_roles: { archetypes: [{ name: "技术经理", level: "资深", fit: "primary" }] } };
  const once = mergeYamlPatch(PROFILE, patch).text;
  const twice = mergeYamlPatch(once, patch);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once);
});

test("对象键名与值走同一条引号规则：需引号的键不被写坏，null 写回 null", () => {
  // reconcile 保留的手写条目可能带任意键：需引号的键裸渲染会写坏整个文件，
  // null 值不能被静默改型成空字符串（#数据丢失类守卫）。
  const patch = { target_roles: { archetypes: [{ name: "A", "007": 1, "fit: x": "y", level: null }] } };
  const { text, skipped } = mergeYamlPatch(PROFILE, patch);
  assert.deepEqual(skipped, []);
  assert.ok(text.includes('    - name: A'));
  assert.ok(text.includes('      "007": 1'));
  assert.ok(text.includes('      "fit: x": y'));
  assert.ok(text.includes("      level: null"));
  assert.deepEqual(yaml.load(text).target_roles.archetypes, [{ name: "A", "007": 1, "fit: x": "y", level: null }]);
});
