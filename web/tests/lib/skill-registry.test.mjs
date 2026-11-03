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
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSkillFrontmatter,
  compareVersions,
  scanSkillRegistry,
  groupSkills,
  resolveSkillCopy,
  normalizeSkillDir,
  sanitizeSkillDirs,
  MAX_CUSTOM_SKILL_DIRS,
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

// 本机技能库的真实形态：skills-manager deploy 在 agent 目录下放的是**指向库目录的
// 链接**，不是真目录。Windows 用 junction（普通权限可建，dirent 同样报
// isSymbolicLink()=true / isDirectory()=false，与真实部署的判定面一致），
// POSIX 用 dir 符号链接。
function linkSkill(home, agentDir, skillDir, libraryDir) {
  const dir = path.join(home, agentDir, skillDir);
  fs.mkdirSync(path.join(home, agentDir), { recursive: true });
  fs.symlinkSync(libraryDir, dir, process.platform === "win32" ? "junction" : "dir");
}

function makeLibrary() {
  const lib = fs.mkdtempSync(path.join(os.tmpdir(), "skill-library-"));
  writeSkill(lib, ".", "offer体检", OFFER_FM);
  writeSkill(lib, ".", "browser-skill", "---\nname: browser-skill\n---\n");
  return lib;
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

// 真机形态回归（用户报告：配置页搜不到技能安装位置，实际在 D:\.skills-manager\skills）。
// agent 目录下 113 份部署全是符号链接，只认 isDirectory() 的旧判定会把整机判成 0 副本。
test("scanSkillRegistry: 部署为符号链接的技能目录必须被扫到", () => {
  const home = makeHome();
  const lib = makeLibrary();
  linkSkill(home, ".claude/skills", "offer体检", path.join(lib, "offer体检"));
  linkSkill(home, ".trae-cn/skills", "browser-skill", path.join(lib, "browser-skill"));

  const copies = scanSkillRegistry({ home });
  assert.equal(copies.length, 2, "链接形态的副本不能被判成未安装");

  const offer = copies.find((c) => c.name === "offer体检");
  assert.equal(offer.version, "1.2.0", "经链接读到的 frontmatter 与真目录一致");
  assert.equal(offer.agentDir, ".claude/skills");
});

test("scanSkillRegistry: 链接副本的 realPath 指向库里的真实位置（面板「安装位置」用它）", () => {
  const home = makeHome();
  const lib = makeLibrary();
  linkSkill(home, ".claude/skills", "offer体检", path.join(lib, "offer体检"));

  const [offer] = scanSkillRegistry({ home });
  // 两侧都取 realpath：本机 TEMP 本身可能是指向别的盘的链接（C:\...\Temp → G:\Temp），
  // 拿未解析的 mkdtemp 路径做等值会比出假失败。
  assert.equal(
    offer.realPath,
    fs.realpathSync(path.join(lib, "offer体检", "SKILL.md")),
    "realPath 必须解析到中央库，而不是 home 下的链接路径",
  );
  assert.ok(offer.path.startsWith(home), "path 保留派发侧看到的部署路径（agentDir 语义不丢）");
});

test("scanSkillRegistry: 断链（目标不存在）静默跳过，不抛错", () => {
  const home = makeHome();
  const lib = makeLibrary();
  linkSkill(home, ".claude/skills", "offer体检", path.join(lib, "offer体检"));
  fs.rmSync(path.join(lib, "offer体检"), { recursive: true, force: true });

  assert.deepEqual(scanSkillRegistry({ home }), [], "指向已消失目标的链接不是副本");
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

// --- 手动指定安装目录（配置页输入/选择）----------------------------------------

const HOME = path.resolve("home", "tester");
/** 平台无关的绝对目录（不同平台拼出来的形状不同，期望值也用 path 算）。 */
const ABS = path.resolve("library", "skills");

test("normalizeSkillDir: 绝对路径、~、home 相对写法都归一化，引号与尾分隔符去掉", () => {
  assert.equal(normalizeSkillDir(ABS, HOME), ABS);
  assert.equal(normalizeSkillDir(`${ABS}${path.sep}`, HOME), ABS, "尾分隔符不参与身份");
  assert.equal(normalizeSkillDir(`  ${ABS}  `, HOME), ABS, "首尾空白不是路径的一部分");
  assert.equal(normalizeSkillDir(`"${ABS}"`, HOME), ABS, "资源管理器『复制为路径』的引号");
  assert.equal(normalizeSkillDir("~", HOME), HOME);
  assert.equal(normalizeSkillDir(`~${path.sep}skills`, HOME), path.join(HOME, "skills"));
  // 默认清单本身是相对 home 的写法，用户照抄候选清单时必须成立。
  assert.equal(normalizeSkillDir(".claude/skills", HOME), path.resolve(HOME, ".claude", "skills"));
  assert.equal(normalizeSkillDir("", HOME), null);
  assert.equal(normalizeSkillDir("   ", HOME), null);
  assert.equal(normalizeSkillDir(42, HOME), null);
  assert.equal(normalizeSkillDir(`${path.sep}${"x".repeat(600)}`, HOME), null, "超长值基本是粘贴事故");
});

test("sanitizeSkillDirs: 默认清单已有的、重复的、非法项全部丢弃", () => {
  const dirs = sanitizeSkillDirs(
    [ABS, `${ABS}${path.sep}`, ".claude/skills", "~/.claude/skills", "", null, 42],
    HOME,
  );
  // `.claude/skills` 与 `~/.claude/skills` 都解析到默认清单里的目录 → 丢掉；
  // 两个 ABS 写法是同一个目录 → 只留一个。
  assert.deepEqual(dirs, [ABS]);
  assert.deepEqual(sanitizeSkillDirs(null, HOME), [], "非数组 → 空表，不抛错");
  assert.deepEqual(sanitizeSkillDirs("D:\\skills", HOME), [], "整表必须是数组");
});

test("sanitizeSkillDirs: 数量有上限，超出部分截断", () => {
  const raw = Array.from({ length: MAX_CUSTOM_SKILL_DIRS + 5 }, (_, i) => path.join(HOME, `extra-${i}`));
  assert.equal(sanitizeSkillDirs(raw, HOME).length, MAX_CUSTOM_SKILL_DIRS);
});

test("scanSkillRegistry: extraDirs 收 home 之外的绝对目录，且不会被拼到 home 上", () => {
  const home = makeHome();
  const library = makeHome();
  writeSkill(library, ".", "offer体检", OFFER_FM);

  const copies = scanSkillRegistry({ home, extraDirs: [library, `${library}${path.sep}`] });
  assert.equal(copies.length, 1, "同一目录的两种写法只扫一次");
  const [offer] = copies;
  assert.equal(offer.name, "offer体检");
  assert.equal(offer.version, "1.2.0");
  assert.equal(offer.path, path.join(library, "offer体检", "SKILL.md"), "path.resolve 不能把绝对目录接到 home 后面");
  assert.equal(offer.agentDir, library);
});

// --- 接线：服务端持久化 + 展示与派发同源 ---------------------------------------

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(WEB, ...parts), "utf8");

const APP_CONFIG = read("src", "lib", "app-config.ts");
const SKILLS_ROUTE = read("src", "app", "api", "skills", "route.ts");
const RUN_ROUTE = read("src", "app", "api", "run", "route.ts");
const BATCH_ROUTE = read("src", "app", "api", "batch-checkup", "route.ts");
const PANEL = read("src", "components", "skills-panel.tsx");
const DICT = read("src", "lib", "i18n", "clusters", "config.ts");

test("skillDirs 是服务端持久化配置，读入时清洗", () => {
  assert.match(APP_CONFIG, /skillDirs\?: string\[\]/, "AppConfig must carry skillDirs");
  assert.match(APP_CONFIG, /sanitizeSkillDirs\(raw\.skillDirs/, "readAppConfig must sanitize what it reads");
});

test("GET/POST /api/skills 用同一份扫描输入，POST 落库后立即回扫", () => {
  assert.match(SKILLS_ROUTE, /export async function POST/, "POST /api/skills must exist");
  assert.match(SKILLS_ROUTE, /sanitizeSkillDirs\(body\.skillDirs/, "the route must sanitize before writing");
  assert.match(SKILLS_ROUTE, /writeAppConfig\(next\)/, "the route must persist the list");
  assert.match(SKILLS_ROUTE, /scanSkillRegistry\(\{ extraDirs/, "GET and POST must scan with the extra dirs");
  assert.match(SKILLS_ROUTE, /readAppConfig\(\)\.skillDirs/, "GET must read the persisted list");
});

test("展示与体检派发共用同一份额外目录输入", () => {
  assert.match(RUN_ROUTE, /scanSkillRegistry\(\{ extraDirs: readAppConfig\(\)\.skillDirs/, "single checkup must see custom dirs");
  assert.match(BATCH_ROUTE, /scanSkillRegistry\(\{ extraDirs: readAppConfig\(\)\.skillDirs/, "batch checkup must see them too");
});

test("面板：可输入、可选择、可移除，且保存走服务端", () => {
  assert.match(PANEL, /fetch\("\/api\/clis\/pick-dir"/, "the folder picker must be wired");
  assert.match(PANEL, /body: JSON.stringify\(\{ skillDirs: next \}\)/, "the panel must POST the whole list");
  assert.match(PANEL, /e\.key === "Enter"/, "typing a path and pressing Enter must add it");
  assert.match(PANEL, /config\.skillsDirsRemove/, "saved dirs need a remove action");
  assert.match(PANEL, /config\.skillsDirsEmpty/, "an empty list needs a stated empty state");
  assert.match(PANEL, /config\.skillsDirAlreadyScanned/, "a duplicate must be reported, not silently dropped");
});

test("面板守 UI 清单：cursor、live region、hover 不位移、对比度、触控", () => {
  // Tailwind v4 preflight 把 button 设成 cursor: default，手型必须显式给。
  assert.match(PANEL, /cursor-pointer items-center justify-center rounded-lg/, "buttons need a pointer cursor");
  assert.match(PANEL, /disabled:cursor-not-allowed/, "busy/empty states must not look clickable");
  // hover 只换颜色：挂 padding/size/scale 都会让整行跳一下。
  assert.doesNotMatch(PANEL, /hover:(?:p-|m-|w-|h-|scale|text-\[|gap-)/, "hover must not change geometry");
  assert.match(PANEL, /role="status"\s*\n\s*aria-live="polite"/, "the result must be a persistent live region");
  assert.match(PANEL, /placeholder:text-faint/, "the placeholder needs the AA token");
  assert.match(PANEL, /focus-visible:ring-2 focus-visible:ring-brand\/40/, "inputs and buttons need a visible focus ring");
  assert.match(PANEL, /max-sm:min-h-\[44px\]/, "touch targets need 44px on phones");
  assert.match(PANEL, /<label\s*\n\s*htmlFor=\{dirInputId\}/, "the path field needs a real label");
});

test("新增文案在中英两本字典里都存在", () => {
  const [enBlock, zhBlock] = DICT.split("export const zh");
  assert.ok(enBlock && zhBlock, "config.ts shape changed — key parsing is stale");
  const KEYS = [
    "config.skillsDirsLabel",
    "config.skillsDirsHint",
    "config.skillsDirsPlaceholder",
    "config.skillsDirsAdd",
    "config.skillsDirsEmpty",
    "config.skillsDirsRemove",
    "config.skillsDirInvalid",
    "config.skillsDirAlreadyScanned",
    "config.skillsDirSaveError",
  ];
  for (const key of KEYS) {
    assert.ok(enBlock.includes(`"${key}":`), `English dict is missing ${key}`);
    assert.ok(zhBlock.includes(`"${key}":`), `Chinese dict is missing ${key}`);
  }
});
