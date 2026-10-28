// followup-scripts 纯逻辑单测：话术模板文件的行式解析 + 占位符填充（ADR-0080）。
// 背景：话术从散落的 sheet 收成一份可机读资产 templates/followup-scripts.md，
// 同一份文件既给人读（行动清单）又给机器读（LogDialog 生成话术）。解析规则必须
// 窄且确定，白名单外的占位符原样保留、绝不静默清空——所以两头都门住：
// 一份「随包文件的结构不漂移」，一份「解析与填充的行为」。
//
// Run:  node --test web/tests/lib/followup-scripts.test.mjs
//
// 放在 web/tests/lib 同族纯逻辑测试之间，由 test-all.mjs 的 web/tests/lib
// 批次自动一并门住（目录级 glob，无需登记）。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SCRIPT_GROUPS,
  LINE_LABELS,
  AUTO_PLACEHOLDER_MAP,
  MANUAL_PLACEHOLDERS,
  placeholderKeys,
  fillText,
  parseScripts,
  fillScript,
  fillScripts,
  groupOrder,
  scriptsInGroup,
  suggestScriptIndex,
  shortName,
  groupLabelKey,
  groupLabel,
} from "../../src/lib/followup-scripts.mjs";

const SHIPPED = readFileSync(new URL("../../../templates/followup-scripts.md", import.meta.url), "utf8");

// ---- 随包文件的结构（内容由用户改写，结构不许漂移）---------------------------

test("随包模板文件解析出 7 条话术（任务 career-ops-50 的口径）", () => {
  assert.equal(parseScripts(SHIPPED).length, 7);
});

test("四个场景桶齐备且顺序稳定（分组顺序即 UI 一级 chips 顺序）", () => {
  assert.deepEqual(groupOrder(parseScripts(SHIPPED)), SCRIPT_GROUPS);
});

test("每条话术都写满三句话：事实 / 意向 / 下一步，一条不缺", () => {
  for (const script of parseScripts(SHIPPED)) {
    for (const label of LINE_LABELS) {
      assert.ok(script.lines[label], `${script.name} 缺「${label}」`);
    }
    assert.ok(script.scenario, `${script.name} 缺「场景」`);
  }
});

test("模板名唯一——重名会让 chips 与 aria 标识撞车", () => {
  const names = parseScripts(SHIPPED).map((s) => s.name);
  assert.equal(new Set(names).size, names.length);
});

test("每条话术用的占位符都在白名单里：自动七个或手填三个", () => {
  const allowed = new Set([...Object.keys(AUTO_PLACEHOLDER_MAP), ...MANUAL_PLACEHOLDERS]);
  for (const script of parseScripts(SHIPPED)) {
    for (const key of script.placeholders) {
      assert.ok(allowed.has(key), `${script.name} 用了白名单外的占位符 ${key}`);
    }
  }
});

test("随包文件只用手填占位符里的这三个——新写一个手填键必须同步登记", () => {
  const used = new Set(parseScripts(SHIPPED).flatMap((s) => s.placeholders));
  const manual = MANUAL_PLACEHOLDERS.filter((key) => used.has(key));
  assert.deepEqual(manual, MANUAL_PLACEHOLDERS);
});

test("自动与手填占位符没有交集——同一个键不能既自动又要人补", () => {
  for (const key of MANUAL_PLACEHOLDERS) {
    assert.ok(!(key in AUTO_PLACEHOLDER_MAP), `${key} 同时躺在两个白名单里`);
  }
});

// ---- parseScripts：窄解析，不猜不丢 -----------------------------------------

test("文件头的说明 bullet 不进正文（只认分组/场景/事实/意向/下一步）", () => {
  const md = [
    "# 标题",
    "",
    "- **自动填充的占位符**（从 tracker 行取）：`{投递日}`",
    "- 格式约束：`##` 标题为模板名",
    "",
    "## 甲",
    "- 分组: 留档",
    "- 场景: 试一下",
    "- 事实: 事实句",
    "- 意向: 意向句",
    "- 下一步: 下一步句",
  ].join("\n");
  const scripts = parseScripts(md);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].lines["事实"], "事实句");
  assert.equal(scripts[0].lines["下一步"], "下一步句");
  assert.ok(!("自动填充的占位符" in scripts[0].lines));
});

test("半角与全角冒号都认（中文习惯容易写成全角）", () => {
  const md = "## 乙\n- 分组：留档\n- 事实：事实句\n- 意向：意向句\n- 下一步：下一步句";
  const scripts = parseScripts(md);
  assert.equal(scripts[0].group, "留档");
  assert.equal(scripts[0].lines["意向"], "意向句");
});

test("只有标题没有正文的空块被跳过——空面板不进 UI", () => {
  const md = "## 空壳\n\n## 丙\n- 分组: 留档\n- 事实: 事实句";
  const scripts = parseScripts(md);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].name, "丙");
});

test("输入不是字符串不抛异常", () => {
  assert.deepEqual(parseScripts(undefined), []);
  assert.deepEqual(parseScripts(null), []);
});

// ---- placeholderKeys：花括号收集 --------------------------------------------

test("收集一段文本里的全部占位符，含用户新写的未知键", () => {
  assert.deepEqual(placeholderKeys("我 {投递日} 投了「{岗位名}」，{新键}"), [
    "{投递日}",
    "{岗位名}",
    "{新键}",
  ]);
});

test("空值与无占位符文本返回空数组", () => {
  assert.deepEqual(placeholderKeys(""), []);
  assert.deepEqual(placeholderKeys(undefined), []);
  assert.deepEqual(placeholderKeys("没有占位符"), []);
});

// ---- fillText / fillScript：取不到就留着，绝不静默清空 -----------------------

const ROW = {
  num: 137,
  company: "云枢科技",
  role: "高级后端工程师",
  appliedDate: "10-02",
  daysSinceApplication: 14,
  followupCount: 2,
  followups: [{ date: "10-09" }, { date: "10-12" }],
};

test("自动占位符按 CadenceEntry 字段替换", () => {
  const { text, missing } = fillText(
    "{投递日} / {岗位名} / {编号} / {公司名} / {天数} / {上次跟进日} / {跟进次数}",
    ROW,
  );
  assert.equal(text, "10-02 / 高级后端工程师 / 137 / 云枢科技 / 14 / 10-12 / 2");
  assert.deepEqual(missing, []);
});

test("编号是数字时不留小数点尾巴（137.0 这种脏值不进话术）", () => {
  assert.equal(fillText("{编号}", { num: "137.0" }).text, "137.0"); // 字符串原样
  assert.equal(fillText("{编号}", { num: 137 }).text, "137");
});

test("手填占位符没有数据源——原样保留并上报为缺值", () => {
  const { text, missing } = fillText("在 {城市}，因为 {原因}", ROW);
  assert.equal(text, "在 {城市}，因为 {原因}");
  assert.deepEqual(missing, ["{城市}", "{原因}"]);
});

test("取不到的自动值也保留花括号——不静默清空、不猜", () => {
  const { text, missing } = fillText("{上次跟进日}", { ...ROW, followups: [] });
  assert.equal(text, "{上次跟进日}");
  assert.deepEqual(missing, ["{上次跟进日}"]);
});

test("缺值清单去重（同一键出现三次只报一次）", () => {
  assert.deepEqual(fillText("{城市}{城市}{城市}", ROW).missing, ["{城市}"]);
});

test("row 为空（引擎不可用等）时不抛异常，全部保留", () => {
  const { text, missing } = fillText("{投递日}", null);
  assert.equal(text, "{投递日}");
  assert.deepEqual(missing, ["{投递日}"]);
});

test("fillScript 返回三行 + 合并后的缺值清单", () => {
  const script = parseScripts(SHIPPED).find((s) => s.name.includes("投递后无回应"));
  const filled = fillScript(script, ROW);
  assert.deepEqual(filled.lines.map((l) => l.label), LINE_LABELS);
  assert.equal(filled.lines[0].text, "我 10-02 投了「高级后端工程师」（#137），到今天第 14 天");
  assert.deepEqual(filled.missing, []);
});

test("fillScript 不改动原模板（纯函数）", () => {
  const scripts = parseScripts(SHIPPED);
  const before = JSON.stringify(scripts);
  fillScripts(scripts, ROW);
  assert.equal(JSON.stringify(scripts), before);
});

test("fillScripts 逐条填充，条数不变", () => {
  const scripts = parseScripts(SHIPPED);
  const filled = fillScripts(scripts, ROW);
  assert.equal(filled.length, scripts.length);
  assert.deepEqual(
    filled.map((f) => f.name),
    scripts.map((s) => s.name),
  );
});

// ---- 分组挑选 ---------------------------------------------------------------

test("未知分组沉底而不是消失——用户在文件里新加一个桶不会丢", () => {
  const scripts = parseScripts(
    "## 甲\n- 分组: 新桶\n- 事实: a\n## 乙\n- 分组: 留档\n- 事实: b\n## 丙\n- 分组: 首轮跟进\n- 事实: c",
  );
  assert.deepEqual(groupOrder(scripts), ["首轮跟进", "留档", "新桶"]);
});

test("scriptsInGroup 保持文件里的顺序", () => {
  const scripts = parseScripts(SHIPPED);
  const first = scriptsInGroup(scripts, "首轮跟进");
  assert.equal(first.length, 2);
  assert.match(first[0].name, /投递后无回应/);
  assert.match(first[1].name, /已读不回/);
});

// ---- 二级 chips 短名 + 分组显示翻译 ------------------------------------------

test("短名取模板名 `·` 之后的最后一段（二级 chips 用）", () => {
  assert.equal(shortName("首轮跟进 · 投递后无回应"), "投递后无回应");
  assert.equal(shortName("二轮保岗 · 面后等结果"), "面后等结果");
});

test("没有分隔符时短名就是整名——不会显示成空按钮", () => {
  assert.equal(shortName("留档"), "留档");
  assert.equal(shortName(""), "");
  assert.equal(shortName(undefined), "");
});

test("随包文件每条话术的短名都非空且唯一（chips 不撞车）", () => {
  const shorts = parseScripts(SHIPPED).map((s) => shortName(s.name));
  assert.ok(shorts.every((s) => s.length > 0));
  assert.equal(new Set(shorts).size, shorts.length);
});

test("四个已知分组各有 i18n 键；键名带分组字面量（同 channelLabelKey 的款）", () => {
  for (const group of SCRIPT_GROUPS) {
    assert.equal(groupLabelKey(group), `followups.scriptGroup.${group}`);
  }
});

test("未知分组返回 null → 调用方原样显示，不显示键名", () => {
  assert.equal(groupLabelKey("新桶"), null);
  assert.equal(groupLabelKey(""), null);
});

test("groupLabel 对未知分组原样返回，不查表", () => {
  const t = (key) => `T:${key}`;
  assert.equal(groupLabel("留档", t), "T:followups.scriptGroup.留档");
  assert.equal(groupLabel("新桶", t), "新桶");
});

// ---- suggestScriptIndex：按推进情况自动挑话术（不让用户选轮次）----------------

const ENTRY = (over = {}) => ({ status: "applied", followupCount: 0, ...over });

test("applied 且从未跟进 → 首轮跟进·投递后无回应", () => {
  const scripts = parseScripts(SHIPPED);
  const idx = suggestScriptIndex(scripts, ENTRY());
  assert.match(scripts[idx].name, /首轮跟进 · 投递后无回应/);
});

test("applied 且已跟进仍无回应 → 已读不回再触达", () => {
  const scripts = parseScripts(SHIPPED);
  const idx = suggestScriptIndex(scripts, ENTRY({ followupCount: 1 }));
  assert.match(scripts[idx].name, /已读不回/);
});

test("applied 且已跟进、引擎判定冻结 → 二轮保岗·岗位或将关闭（冻结优先于常规再触达）", () => {
  const scripts = parseScripts(SHIPPED);
  const idx = suggestScriptIndex(scripts, ENTRY({ followupCount: 2, freezeSuggested: true }));
  assert.match(scripts[idx].name, /岗位或将关闭/);
});

test("responded（约面阶段）→ 售前问出差·约面先问清", () => {
  const scripts = parseScripts(SHIPPED);
  const idx = suggestScriptIndex(scripts, ENTRY({ status: "responded" }));
  assert.match(scripts[idx].name, /约面先问清/);
});

test("interview（面后等结果）→ 二轮保岗·面后等结果", () => {
  const scripts = parseScripts(SHIPPED);
  const idx = suggestScriptIndex(scripts, ENTRY({ status: "interview", followupCount: 3 }));
  assert.match(scripts[idx].name, /面后等结果/);
});

test("变体关键词匹配不到时落桶内第一条——用户改写模板名不空手", () => {
  const scripts = parseScripts(
    "## 首轮跟进 · 换了个名字\n- 分组: 首轮跟进\n- 事实: a\n## 首轮跟进 · 又一个\n- 分组: 首轮跟进\n- 事实: b",
  );
  const idx = suggestScriptIndex(scripts, ENTRY());
  assert.equal(idx, 0); // 目标桶第一条，而不是整体消失
});

test("目标桶整个不存在 → 落第一条，不报错不空手", () => {
  const scripts = parseScripts("## 留档 · 婉拒\n- 分组: 留档\n- 事实: a");
  assert.equal(suggestScriptIndex(scripts, ENTRY()), 0);
});

test("未知状态 / row 为空 / 空数组的兜底", () => {
  const scripts = parseScripts(SHIPPED);
  assert.equal(suggestScriptIndex(scripts, ENTRY({ status: "offer" })), 0);
  assert.equal(suggestScriptIndex(scripts, null), 0);
  assert.equal(suggestScriptIndex([], ENTRY()), -1);
  assert.equal(suggestScriptIndex(undefined, ENTRY()), -1);
});
