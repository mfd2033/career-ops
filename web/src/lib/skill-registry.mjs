// web/src/lib/skill-registry.mjs — ADR-0056 决议 1/2/5/8：本机 agent 技能注册表。
//
// 单一事实源：/api/skills 的展示数据与 /api/run 体检派发的技能指针都从这里来。
// 纯 .mjs（同 checkup-live / checkup-request 惯例），node --test 可锁，不 import tsx。
//
// 扫描语义（ADR-0056）：
//  - 目录清单是常量（决议 1 的五处；新 agent 目录加在这里）；home 可注入，测试用临时目录。
//  - 直接子目录里有 SKILL.md 才算一个副本；frontmatter 只取 name/version 两个标量
//    （不引 YAML 依赖），无 version → null（browser-skill 如实「未标注」，决议 3）。
//  - 单目录缺失/失败 → 静默跳过：换机、skills-manager 未 deploy 都不是错误（决议 4）。
//  - 不做二进制探测、不走 skills-manager-cli（决议 1）；每请求实时扫，无缓存（决议 8）。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** ADR-0056 决议 1：扫描目录清单（相对 home）。 */
export const SKILL_DIR_CANDIDATES = [
  ".trae-cn/skills",
  ".claude/skills",
  ".skills-manager/skills",
  ".config/opencode/skills",
  ".agents/skills",
];

/** 体检技能的注册名（frontmatter name，非目录名）。服务端查找键的唯一声明处——
 *  api/run/route.ts 的解析与消费方都从这里取，改技能名只改这一处。展示层
 *  （skills-panel.tsx）不 import 本模块（它带 node:fs），白名单字面量自行维护。 */
export const OFFER_CHECKUP_SKILL_NAME = "offer体检";

/**
 * 解析 SKILL.md 头部 frontmatter 的 name/version 两个标量。
 * 两个值都可能缺 → null；引号包裹的值去引号。
 * @param {string | undefined} text
 * @returns {{ name: string | null, version: string | null }}
 */
export function parseSkillFrontmatter(text) {
  if (typeof text !== "string" || !text.startsWith("---")) return { name: null, version: null };
  const end = text.indexOf("\n---", 3);
  const head = end === -1 ? text.slice(3) : text.slice(3, end);
  const pick = (key) => {
    const m = head.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    if (!m) return null;
    const v = m[1].trim().replace(/^["']+|["']+$/g, "");
    return v || null;
  };
  return { name: pick("name"), version: pick("version") };
}

/**
 * 数值位版本比较（1.2.0 < 1.10.0）；null/空视为最低。返回负 / 0 / 正。
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b ?? "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 扫描本机技能副本。home 可注入（测试用临时目录，不碰真实用户目录）。
 * @param {{ home?: string, candidates?: string[] }} [opts]
 * @returns {Array<{ name: string, version: string | null, path: string, agentDir: string }>}
 *          name 缺 frontmatter 时回退目录名。
 */
export function scanSkillRegistry({ home = os.homedir(), candidates = SKILL_DIR_CANDIDATES } = {}) {
  const copies = [];
  for (const agentDir of candidates) {
    const base = path.join(home, agentDir);
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue; // 目录缺失/不可读：如实缺席，不是错误（决议 1/4）
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(base, entry.name, "SKILL.md");
      let text;
      try {
        text = fs.readFileSync(skillMd, "utf8");
      } catch {
        continue; // 无 SKILL.md：不是技能副本
      }
      const { name, version } = parseSkillFrontmatter(text);
      copies.push({ name: name ?? entry.name, version, path: skillMd, agentDir });
    }
  }
  return copies;
}

/**
 * 按技能名聚合：每组 { name, topVersion, copies[] }，copies 按版本降序
 * （最高版本在前，即「当前版本」）。
 * @param {Array<{ name: string, version: string | null, path: string, agentDir: string }>} copies
 */
export function groupSkills(copies) {
  const byName = new Map();
  for (const copy of copies) {
    const list = byName.get(copy.name) ?? [];
    list.push(copy);
    byName.set(copy.name, list);
  }
  return [...byName.entries()].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => compareVersions(b.version, a.version));
    return { name, topVersion: sorted[0]?.version ?? null, copies: sorted };
  });
}

/**
 * 解析某技能的最高版本副本（体检指针用，决议 5）。没有 → null。
 * 全部副本都无版本号时仍返回其一（排序稳定，compare 全 0）——有路径可注入就注入，
 * 版本如实为 null，调用方按「未标注」处理。
 * @param {Array<{ name: string, version: string | null, path: string, agentDir: string }>} copies
 * @param {string} name
 */
export function resolveSkillCopy(copies, name) {
  const sorted = copies
    .filter((c) => c.name === name)
    .sort((a, b) => compareVersions(b.version, a.version));
  return sorted[0] ?? null;
}
