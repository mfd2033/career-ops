// 技能注册表契约测试（ADR-0056 决议 1/2/5）。
//
// 要锁住的三件事：① frontmatter 只取 name/version 两个标量，缺失如实为 null；
// ② 多副本按版本数值位取最高（1.2.0 vs 1.10.0 这类按字典序会排错的用例必须锁死）；
// ③ 单目录缺失/无 SKILL.md 的子目录都静默跳过——换机、skills-manager 未 deploy
// 不是错误（决议 4 的降级语义）。
//
// Run:  node --test web/tests/lib/skill-registry.test.mjs
//
// 全程使用临时目录注入 home，绝不碰真实用户目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseSkillFrontmatter,
  compareVersions,
  scanSkillRegistry,
  groupSkills,
  resolveSkillCopy,
  SKILL_DIR_CANDIDATES,
} from "../../src/lib/skill-registry.mjs";

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-registry-"));
}

function writeSkill(home, agentDir, skillDir, content) {
  const dir = path.join(home, agentDir, skillDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
}

const OFFER_FM = '---\nname: offer体检\ndescription: 招聘/公司体检技能\nversion: 1.2.0\n---\n\n# offer体检\n';

test("parseSkillFrontmatter: 取 name/version 标量，去引号", () => {
  const fm = parseSkillFrontmatter('---\nname: "offer体检"\nversion: \'1.2.0\'\n---\n');
  assert.deepEqual(fm, { name: "offer体检", version: "1.2.0" });
});

test("parseSkillFrontmatter: 无 version 字段 → null（browser-skill 的现状）", () => {
  const fm = parseSkillFrontmatter('---\nname: browser-skill\ndescription: |\n  multi\n  line\n---\n');
  assert.equal(fm.name, "browser-skill");
  assert.equal(fm.version, null);
});

test("parseSkillFrontmatter: 非 frontmatter / 空输入 → 双 null", () => {
  assert.deepEqual(parseSkillFrontmatter("# 没有头部"), { name: null, version: null });
  assert.deepEqual(parseSkillFrontmatter(undefined), { name: null, version: null });
});

test("compareVersions: 数值位比较，1.2.0 < 1.10.0；null 最低", () => {
  assert.ok(compareVersions("1.2.0", "1.10.0") < 0, "字典序会排错，数值位必须对");
  assert.ok(compareVersions("1.10.0", "1.2.0") > 0);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.ok(compareVersions(null, "0.0.1") < 0);
  assert.ok(compareVersions("1.2", "1.2.0") === 0, "缺位补 0");
});

test("scanSkillRegistry: 跨目录收集副本，缺失目录与无 SKILL.md 的子目录跳过", () => {
  const home = makeHome();
  writeSkill(home, ".trae-cn/skills", "offer体检", OFFER_FM);
  writeSkill(home, ".claude/skills", "offer体检", OFFER_FM.replace("1.2.0", "1.1.0"));
  // 无 version 字段的副本（.agents 旧克隆的现状）
  writeSkill(home, ".agents/skills", "offer-checkup", "---\nname: offer-checkup\n---\n# old\n");
  // 子目录没有 SKILL.md：不是副本
  fs.mkdirSync(path.join(home, ".claude/skills", "empty-skill"), { recursive: true });
  // 候选目录存在但为空（无子目录/无 SKILL.md 副本）：静默跳过
  fs.mkdirSync(path.join(home, ".config/opencode/skills"), { recursive: true });

  const copies = scanSkillRegistry({ home });

  assert.equal(copies.length, 3);
  const byAgent = Object.fromEntries(copies.map((c) => [c.agentDir, c]));
  assert.equal(byAgent[".trae-cn/skills"].version, "1.2.0");
  assert.equal(byAgent[".claude/skills"].version, "1.1.0");
  assert.equal(byAgent[".agents/skills"].version, null);
  assert.equal(byAgent[".agents/skills"].name, "offer-checkup");
  // 路径指向该副本自己的 SKILL.md
  assert.equal(byAgent[".trae-cn/skills"].path, path.join(home, ".trae-cn/skills", "offer体检", "SKILL.md"));
  // name 缺失时回退目录名（此处 name 都有，断言清单常量本身可扩展）
  assert.ok(SKILL_DIR_CANDIDATES.includes(".skills-manager/skills"));
});

test("scanSkillRegistry: 整个 home 为空 → 空表，不抛错", () => {
  const home = makeHome();
  assert.deepEqual(scanSkillRegistry({ home }), []);
});

test("groupSkills: 按名聚合，topVersion 取最高，copies 版本降序", () => {
  const home = makeHome();
  writeSkill(home, ".trae-cn/skills", "offer体检", OFFER_FM); // 1.2.0
  writeSkill(home, ".claude/skills", "offer体检", OFFER_FM.replace("1.2.0", "1.1.0"));
  writeSkill(home, ".trae-cn/skills", "browser-skill", "---\nname: browser-skill\n---\n");
  const groups = groupSkills(scanSkillRegistry({ home }));

  const offer = groups.find((g) => g.name === "offer体检");
  assert.equal(offer.topVersion, "1.2.0");
  assert.equal(offer.copies[0].agentDir, ".trae-cn/skills");
  assert.equal(offer.copies[1].agentDir, ".claude/skills");

  const bsk = groups.find((g) => g.name === "browser-skill");
  assert.equal(bsk.topVersion, null, "全部副本无版本 → topVersion 如实为 null");
});

test("resolveSkillCopy: 跨目录取最高版本；找不到 → null；全无版本仍返回其一", () => {
  const home = makeHome();
  writeSkill(home, ".claude/skills", "offer体检", OFFER_FM.replace("1.2.0", "1.1.0"));
  writeSkill(home, ".skills-manager/skills", "offer体检", OFFER_FM); // 1.2.0
  const copies = scanSkillRegistry({ home });

  const top = resolveSkillCopy(copies, "offer体检");
  assert.equal(top.version, "1.2.0");
  assert.equal(top.agentDir, ".skills-manager/skills");

  assert.equal(resolveSkillCopy(copies, "不存在的技能"), null);

  const noVersion = resolveSkillCopy(
    [{ name: "browser-skill", version: null, path: "p1", agentDir: "d1" }],
    "browser-skill",
  );
  assert.equal(noVersion.path, "p1", "全无版本号也返回副本，版本由调用方按未标注处理");
});
