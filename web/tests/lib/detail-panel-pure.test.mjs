// detail-panel-pure 纯逻辑单测（ADR-0074 / 工单 02）：详情页浮窗的视图态计算——
// 五行读数（报告号 / 已评估 / 快评 / 状态 / 体检）的取值与占位符、分数分档色、药丸总分回退、
// 评估按钮文案切换、可点入口在缺值时隐藏。无 chrome / DOM 依赖，直接 import
// extension/detail-panel-pure.js。
//
// Run:  node --test web/tests/lib/detail-panel-pure.test.mjs
//
// 放在 web/tests/lib 与同族扩展侧测试（badge-pure / report-target-pure / scan-pure /
// wrapup-pure）同级，由 test-all.mjs 的 web/tests/lib 批次一并门住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "detail-panel-pure.js")).href);
const { panelView, scoreBand, STATUS_DICT, statusLabel, mdToHtml, readerErrorText, CHECKUP_GOLD, SCORE_NEUTRAL, QUICK_PURPLE } = mod.default ?? mod;

/** 造一条 /api/report-status 的 evaluated map 条目。 */
const entry = (o = {}) => ({ score: "4.3/5", reportNum: "1121", ...o });

// ---- 分数分档（与 core.js 既有 scoreColor 同阈值） -------------------------

test("分数分档：≥4 绿、≥3 橙、<3 红、非数值灰", () => {
  assert.equal(scoreBand("4.3/5").color, "#00c68d");
  assert.equal(scoreBand("4/5").color, "#00c68d");
  assert.equal(scoreBand("3.0/5").color, "#f5a623");
  assert.equal(scoreBand("2.9/5").color, "#d93026");
  assert.equal(scoreBand("").color, "#8a8f98");
  assert.equal(scoreBand(null).color, "#8a8f98");
  assert.equal(scoreBand("未评分").color, "#8a8f98");
});

// ---- 完全未评估：五行都在、全走占位符（结构不跳动） ------------------------

test("完全未评估 → 报告号「—」、已评估/状态行「未评估」、快评/体检「—」，两个可点入口都隐藏", () => {
  const v = panelView({ entry: null, quick: null });
  assert.equal(v.reportRow.text, "—");
  assert.equal(v.reportRow.color, SCORE_NEUTRAL, "无报告号时不得涂品牌蓝");
  assert.equal(v.evalRow.text, "未评估");
  assert.equal(v.evalRow.openable, false);
  assert.equal(v.evalRow.reportNum, null);
  assert.equal(v.quickRow.text, "—");
  assert.equal(v.statusRow.text, "未评估");
  assert.equal(v.checkupRow.text, "—");
  assert.equal(v.evalBtnLabel, "评估本职位");
  assert.equal(v.pill.scoreText, "—");
});

// ---- 仅快评：快评行有值，其余仍占位；药丸回退到快评分 ----------------------

test("仅快评 → 快评行 x/5，药丸分数用快评分，按钮仍「评估本职位」", () => {
  const v = panelView({ entry: null, quick: { score: 3, grade: "B", reason: "匹配一般" } });
  assert.equal(v.quickRow.text, "3/5");
  assert.equal(v.evalRow.text, "未评估");
  assert.equal(v.evalBtnLabel, "评估本职位");
  assert.equal(v.pill.scoreText, "3/5");
});

test("快评分缺失（null / 无字段）时走占位符；0 仍算一个得分", () => {
  // 与既有快评徽章的 `q.score == null` 口径对齐：不能把 0 当 falsy 抹掉，
  // 否则同一分数在徽章与浮窗上两种说法。
  for (const q of [{ score: null }, {}]) {
    const v = panelView({ entry: null, quick: q });
    assert.equal(v.quickRow.text, "—", JSON.stringify(q));
    assert.equal(v.pill.scoreText, "—", JSON.stringify(q));
  }
  const zero = panelView({ entry: null, quick: { score: 0 } });
  assert.equal(zero.quickRow.text, "0/5");
  assert.equal(zero.pill.scoreText, "0/5");
});

// ---- 完整评估：分数 + 报告号 + 按钮文案 + 可点入口 --------------------------

test("已完整评估 → 分数按档着色、带报告号、行尾可点、按钮变「重新评估」", () => {
  const v = panelView({ entry: entry(), quick: { score: 2 } });
  assert.equal(v.evalRow.text, "4.3/5");
  assert.equal(v.evalRow.color, "#00c68d");
  assert.equal(v.evalRow.reportNum, "1121");
  assert.equal(v.reportRow.text, "#1121", "报告号行独立显示带 # 前缀的 tracker#");
  assert.equal(v.reportRow.color, "#4aa3ff");
  assert.equal(v.evalRow.openable, true);
  assert.equal(v.evalBtnLabel, "重新评估");
});

test("药丸总分：已评估分数优先于快评分；色点跟状态走、分数另带自己的色", () => {
  const v = panelView({ entry: entry({ score: "3.2/5" }), quick: { score: 5 } });
  assert.equal(v.pill.scoreText, "3.2/5");
  assert.equal(v.pill.scoreColor, "#f5a623");
  assert.equal(v.pill.dotColor, v.statusRow.color, "药丸色点不得用分数色冒充状态色");
});

test("有 evaluated 条目但分数为空 → 分数仍占位，按钮文案仍按「已评估过」走", () => {
  const v = panelView({ entry: entry({ score: "" }), quick: { score: 4 } });
  assert.equal(v.evalRow.text, "未评估");
  assert.equal(v.evalBtnLabel, "重新评估");
  // 已评估行没分数时药丸退回快评分，不显示空串
  assert.equal(v.pill.scoreText, "4/5");
});

test("有分数但没有报告号（tracker 行链接缺失）→ 行尾入口隐藏，行本身照常显示", () => {
  const v = panelView({ entry: entry({ reportNum: "" }), quick: null });
  assert.equal(v.evalRow.text, "4.3/5");
  assert.equal(v.evalRow.reportNum, null);
  assert.equal(v.evalRow.openable, false);
});

test("报告号缺失的两种写法（空串 / null）都归一为 null", () => {
  for (const n of ["", null, undefined]) {
    assert.equal(panelView({ entry: entry({ reportNum: n }), quick: null }).evalRow.reportNum, null, String(n));
  }
});

// ---- 状态字典（接缝 C）：与两份真值逐状态钉住 ----------------------------
//
// 扩展侧的中文状态标签是有意的第二份副本（web 侧在 TS i18n，content script import
// 不进去）。双份就会漂移，所以这里不靠约定，靠读两份真值文件逐状态对账。
const STATES_YML = readFileSync(join(ROOT, "templates", "states.yml"), "utf8");
const I18N_ZH = (() => {
  const src = readFileSync(join(ROOT, "web", "src", "lib", "i18n", "clusters", "pipeline.ts"), "utf8");
  const at = src.indexOf("export const zh");
  assert.ok(at > 0, "i18n 集群里找不到 zh 段（改结构了就同步改这个对账测试）");
  return src.slice(at);
})();
const CANONICAL_LABELS = [...STATES_YML.matchAll(/^\s+label:\s*(\S+)\s*$/gm)].map((m) => m[1]);

test("状态字典覆盖 templates/states.yml 全部九个规范状态，且中文与 web i18n 逐字一致", () => {
  assert.equal(CANONICAL_LABELS.length, 9, "states.yml 状态数变了 → 字典要同步");
  for (const label of CANONICAL_LABELS) {
    const hit = STATUS_DICT[label];
    assert.ok(hit, `扩展字典缺状态 ${label}`);
    const m = new RegExp(`"pipeline\\.status\\.${label.toLowerCase()}":\\s*"([^"]+)"`).exec(I18N_ZH);
    assert.ok(m, `web i18n 缺 pipeline.status.${label.toLowerCase()}`);
    assert.equal(hit.zh, m[1], `${label} 的中文标签与 web i18n 漂移`);
    assert.match(hit.color, /^#[0-9a-f]{6}$/i, `${label} 缺色值`);
  }
  // 反向：字典不得自己长出 states.yml 里没有的状态
  for (const k of Object.keys(STATUS_DICT)) {
    assert.ok(CANONICAL_LABELS.includes(k), `扩展字典多出未知状态 ${k}`);
  }
});

test("statusLabel：已知码出中文+生命周期色，大小写不敏感", () => {
  assert.deepEqual(statusLabel("Applied"), { text: "已申请", color: "#4aa3ff", known: true, title: "状态：Applied" });
  assert.equal(statusLabel("  applied ").text, "已申请", "tracker 值带空格 / 换大小写都得认");
  assert.equal(statusLabel("SKIP").text, "跳过", "skip 两边都是「跳过」，不带「已」");
  assert.equal(statusLabel("Offer").text, "录用通知");
});

test("statusLabel：未知码回退中性「已评估」，原值只进 title 供悬停核对", () => {
  const st = statusLabel("WeirdThirdPartyState");
  assert.equal(st.text, "已评估");
  assert.equal(st.color, SCORE_NEUTRAL, "认不出的码不得冒充任何生命周期色");
  assert.equal(st.known, false);
  assert.match(st.title, /WeirdThirdPartyState/);
});

test("statusLabel：空值走占位符（连 tracker 行都没有）", () => {
  for (const raw of ["", "   ", null, undefined]) {
    assert.equal(statusLabel(raw).text, "未评估", JSON.stringify(raw));
  }
});

test("状态行接契约：已申请上色、画色点、药丸同步带状态位", () => {
  const v = panelView({ entry: { score: "4.3/5", reportNum: "1121", status: "Interview" }, quick: null });
  assert.equal(v.statusRow.text, "面试中");
  assert.equal(v.statusRow.color, "#f5a623");
  assert.equal(v.statusRow.dot, true);
  assert.equal(v.statusRow.raw, "Interview");
  assert.equal(v.pill.statusText, "面试中");
  assert.equal(v.pill.dotColor, "#f5a623", "药丸色点就是状态色");
});

test("有 tracker 行但契约不带状态 → 退「已评估」中性色，不画色点", () => {
  const v = panelView({ entry: { score: "4.3/5", reportNum: "1121" }, quick: null });
  assert.equal(v.statusRow.text, "已评估");
  assert.equal(v.statusRow.color, SCORE_NEUTRAL);
  assert.equal(v.statusRow.dot, false);
  assert.equal(v.statusRow.raw, null);
});

test("无 tracker 行 → 状态行占位符「未评估」（即使有快评分也不假装走到了一步）", () => {
  const v = panelView({ entry: null, quick: { score: 4 } });
  assert.equal(v.statusRow.text, "未评估");
  assert.equal(v.statusRow.dot, false);
  assert.equal(v.pill.statusText, "未评估");
});

// ---- 色轨只在有值时上色 ----------------------------------------------------

test("缺值的快评/体检行走中性灰轨；有值才上自己的色，不用颜色宣称结果", () => {
  assert.equal(panelView({ entry: null, quick: null }).quickRow.color, SCORE_NEUTRAL);
  assert.equal(panelView({ entry: null, quick: { score: 3 } }).quickRow.color, QUICK_PURPLE);
  assert.equal(panelView({}).checkupRow.color, SCORE_NEUTRAL);
  assert.notEqual(panelView({}).checkupRow.color, CHECKUP_GOLD);
  assert.equal(panelView({}).statusRow.dot, false, "状态缺值时不画色点");
});

// ---- 体检行（工单 04）：契约 checkupStar → 推荐 x/5 + 金色轨 ----------------

test("有体检 → 「推荐 x/5」金色轨、行尾 ↗ 可点", () => {
  const v = panelView({ entry: entry({ checkupStar: 4.5 }), quick: null });
  assert.equal(v.checkupRow.text, "推荐 4.5/5");
  assert.equal(v.checkupRow.color, CHECKUP_GOLD);
  assert.equal(v.checkupRow.openable, true);
  assert.match(v.checkupRow.title, /1121/, "悬停文案说清点下去的是哪一份报告");
});

test("体检星固定一位小数：5 → 「推荐 5.0/5」，不写成「推荐 5/5」", () => {
  assert.equal(panelView({ entry: entry({ checkupStar: 5 }) }).checkupRow.text, "推荐 5.0/5");
  assert.equal(panelView({ entry: entry({ checkupStar: 3.25 }) }).checkupRow.text, "推荐 3.3/5");
});

test("无体检（null / 缺字段 / 0 / NaN / 非数字）→ 占位符「—」+ 中性灰 + ↗ 隐藏", () => {
  for (const star of [null, undefined, 0, NaN, "abc", ""]) {
    const v = panelView({ entry: entry({ checkupStar: star }), quick: null });
    assert.equal(v.checkupRow.text, "—", JSON.stringify(star));
    assert.equal(v.checkupRow.color, SCORE_NEUTRAL, JSON.stringify(star));
    assert.equal(v.checkupRow.openable, false, JSON.stringify(star));
    assert.equal(v.checkupRow.title, "", JSON.stringify(star));
  }
});

test("有体检但没有报告号 → ↗ 隐藏（点了没去处，不留一个假入口）", () => {
  const v = panelView({ entry: entry({ checkupStar: 3.5, reportNum: "" }), quick: null });
  assert.equal(v.checkupRow.text, "推荐 3.5/5", "星子本身是真的，正文照写");
  assert.equal(v.checkupRow.color, CHECKUP_GOLD);
  assert.equal(v.checkupRow.openable, false);
});

test("体检星不报进药丸总分、不报进状态位（ADR-0064：只供展示）", () => {
  const v = panelView({ entry: entry({ checkupStar: 5 }), quick: null });
  assert.equal(v.pill.scoreText, "4.3/5", "药丸总分仍是评估分，不被体检星顶掉");
  assert.equal(v.pill.dotColor, SCORE_NEUTRAL, "体检星不伪装成生命周期状态色");
});

// ---- 五行恒定存在（结构不跳动的契约） --------------------------------------

test("任何输入组合下五行读数都在，行名固定", () => {
  for (const [e, q] of [[null, null], [entry(), null], [null, { score: 1 }], [entry(), { score: 1 }]]) {
    const v = panelView({ entry: e, quick: q });
    assert.deepEqual(
      [v.reportRow.label, v.evalRow.label, v.quickRow.label, v.statusRow.label, v.checkupRow.label],
      ["报告号", "已评估", "快评", "状态", "体检"]
    );
  }
});

test("缺参数（(undefined) 调用）不抛错，退化成未评估态", () => {
  const v = panelView();
  assert.equal(v.evalRow.text, "未评估");
  assert.equal(v.statusRow.text, "未评估");
  assert.equal(v.evalBtnLabel, "评估本职位");
});

// ---- mdToHtml（接缝 E）：页内阅读弹窗里的评估报告渲染 ---------------------
//
// 报告正文是 untrusted 程度中等的东西（它由我们自己的流程生成，但内容源头是
// 陌生 JD），所以渲染口径与体检 iframe 一致：先整体转义、再上标记。这个测试组
// 钉的就是「转义先于标记」与「目录 id 跟正文对得上」。

const REPORT = [
  "# Evaluation: 某公司 — 高级 AI 工程师",
  "",
  "**Company:** 某公司",
  "**URL:** https://www.zhipin.com/job_detail/1.html",
  "",
  "## Block A — 匹配度",
  "",
  "先看 `关键词`，再谈 **权重**。",
  "",
  "| 维度 | 结论 |",
  "|---|---|",
  "| 技术 | 强 |",
  "",
  "- 要点一",
  "- 要点二",
  "",
  "> 一句话风险提示",
  "",
  "## Block B — 风险",
  "",
  "### 子标题",
  "",
  "```yaml",
  "score: 4.3",
  "```",
  "",
  "---",
  "",
  "详情见 [职位页](https://example.com/j/1)。",
].join("\n");

test("常见排版元素各归其位：标题/段落/表格/列表/引用/分隔线/内联标记", () => {
  const { html } = mdToHtml(REPORT);
  assert.match(html, /<h1>Evaluation: 某公司/);
  assert.match(html, /先看 <code>关键词<\/code>，再谈 <b>权重<\/b>。/);
  assert.match(html, /<table><thead><tr><th>维度<\/th><th>结论<\/th><\/tr><\/thead><tbody><tr><td>技术<\/td><td>强<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<ul><li>要点一<\/li><li>要点二<\/li><\/ul>/);
  assert.match(html, /<blockquote>一句话风险提示<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<a href="https:\/\/example\.com\/j\/1" target="_blank" rel="noopener">职位页<\/a>/);
});

test("有序列表单独成 ol，不跟无序列表串在一起", () => {
  const { html } = mdToHtml("1. 甲\n2. 乙\n\n- 丙");
  assert.match(html, /<ol><li>甲<\/li><li>乙<\/li><\/ol>/);
  assert.match(html, /<ul><li>丙<\/li><\/ul>/);
});

test("toc 只收 h2/h3，id 与正文一一对应，默认从 sec-0 递增", () => {
  const { html, toc } = mdToHtml(REPORT);
  assert.deepEqual(toc, [
    { id: "sec-0", level: 2, text: "Block A — 匹配度" },
    { id: "sec-1", level: 2, text: "Block B — 风险" },
    { id: "sec-2", level: 3, text: "子标题" },
  ]);
  for (const t of toc) assert.ok(html.includes(`<h${t.level} id="${t.id}">`), `正文里找不到 ${t.id}`);
  assert.ok(!html.includes("<h1 id="), "h1 不进目录");
});

test("标题里的 markdown 标记在 toc 里被括平，正文里仍带标记", () => {
  const { html, toc } = mdToHtml("## 带 **粗体** 与 `代码` 的标题");
  assert.equal(toc[0].text, "带 粗体 与 代码 的标题");
  assert.match(html, /<h2 id="sec-0">带 <b>粗体<\/b> 与 <code>代码<\/code> 的标题<\/h2>/);
});

test("报告头 **键:** 值 排成元信息网格，URL 值变成可点链接", () => {
  const { html } = mdToHtml(REPORT);
  assert.match(html, /<div class="cr-kvs">/);
  assert.match(html, /<div class="cr-kv"><b>Company:<\/b><span>某公司<\/span><\/div>/);
  assert.match(html, /<a href="https:\/\/www\.zhipin\.com\/job_detail\/1\.html"/);
});

test("yaml / json 围栏默认展开（用户定稿），其它语言围栏就是 <pre>", () => {
  const y = mdToHtml("```yaml\nscore: 4.3\n```").html;
  assert.match(y, /<details open><summary>机器可读摘要（yaml）<\/summary><pre><code>score: 4\.3/);
  const j = mdToHtml("```json\n{}\n```").html;
  assert.match(j, /<details open>/);
  const plain = mdToHtml("```\nplain text\n```").html;
  assert.match(plain, /^<pre><code>plain text<\/code><\/pre>$/, "无语言围栏不伪装成摘要");
  const bash = mdToHtml("```bash\nnpm i<\/bin\n```").html;
  assert.ok(!bash.includes("<details"));
});

test("先转义再上标记：正文里的 HTML 标签不会被当成标记", () => {
  const evil = [
    "# T",
    "## S",
    "<script>alert(1)</script>",
    "",
    "| a | b |",
    "|---|---|",
    "| <img src=x onerror=alert(1)> | 2 |",
    "",
    "## & 号 <i>标签</i>",
  ].join("\n");
  const { html, toc } = mdToHtml(evil);
  assert.ok(!html.includes("<script"), "绝对不能出现可执行 script 标签");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "原文以转义形式可见，而不是被吞掉");
  assert.ok(!html.includes("<img"), "表格单元里的标签同样逃不出转义");
  assert.equal(toc.length, 2);
  assert.equal(toc[1].text, "& 号 <i>标签</i>", "toc 交胶水用 textContent 写，所以给原文");
});

test("链接 URL 里夹引号也不能逃逸 href 属性", () => {
  const { html } = mdToHtml('[点我](https://example.com/" onmouseover="alert(1))');
  assert.ok(!/ onmouseover="/u.test(html), "属性注入必须失败");
  assert.ok(!html.includes("<a href=\"https://example.com/\""));
});

test("空 / 非字符串输入 → 空正文空目录，不抛错", () => {
  for (const src of ["", null, undefined, 42, {}]) {
    const r = mdToHtml(src);
    assert.equal(r.html, "", JSON.stringify(src) ?? String(src));
    assert.deepEqual(r.toc, []);
  }
});

test("畸形表格行（`|` 开头但下一行不是分隔行）当普通段落读，绝不卡死", () => {
  // 回归门：这个 bug 的失败模式不是抛错而是同步无限循环 —— 在 node 里连测试超时都
  // 触发不了（事件循环被卡住），所以这条用例本身就是那道门：一旦回归，整个测试进程直接挂死。
  // 存量报告里有三份真能命中（表头行缺前导管道、分隔行里混中文）。
  const cases = [
    ["| a | b |\nnext line", "a | b"],
    ["| 风险 | 影响 |\n| 无 SaaS | 中高 |", "风险"],
    ["| 只有半行", "只有半行"],
    ["**Advertised (JD) | 5-6K/月 | JD |\n| x | y |", "Advertised"],
  ];
  for (const [src, needle] of cases) {
    const { html } = mdToHtml(src);
    assert.ok(html.includes("<p>"), `${JSON.stringify(src)} 应落成段落`);
    assert.ok(html.includes(needle), `${JSON.stringify(src)} 的文本不得被吞掉`);
  }
});

// ---- 弹窗错误文案（版本错配必须可操作，不能丢开发者黑话） -------------------

test("旧 service worker 回 unknown message type → 翻成「重新加载扩展」提示", () => {
  // 这条错配是就地改扩展文件迭代的常态：content script 每次注入现读磁盘（新），
  // MV3 的 SW 注册在扩展加载时（不点重新加载就一直跑旧代码）。用户看到英文黑话
  // 只会以为功能坏了，不会想到去 chrome://extensions。
  const msg = readerErrorText({ ok: false, error: "unknown message type" }, "兜底文案");
  assert.match(msg, /重新加载/, "必须给出下一步动作");
  assert.match(msg, /chrome:\/\/extensions/, "必须指出在哪里操作");
  assert.ok(!msg.includes("unknown message type"), "开发者黑话不得进用户可见正文");
});

test("错配靠 code 认，不靠英文散文（后台改了措辞也不退化）", () => {
  const byCode = readerErrorText({ ok: false, code: "unknown-message-type", error: "whatever the SW says" }, "兜底");
  assert.match(byCode, /重新加载/);
  assert.ok(!byCode.includes("whatever"));
});

test("后台已经给出可操作中文时原样透出，不改写、不编造", () => {
  const ns = readerErrorText({ ok: false, error: "本地 web 服务未运行（扫描 127.0.0.1:3000-3040 未命中）" }, "兜底");
  assert.equal(ns, "本地 web 服务未运行（扫描 127.0.0.1:3000-3040 未命中）");
  const nf = readerErrorText({ ok: false, error: "本地报告读不出来（404）" }, "兜底");
  assert.equal(nf, "本地报告读不出来（404）");
});

test("没有可用错误串（端口关闭 / lastError / 非字符串）→ 用调用方兜底文案", () => {
  const fb = "本地报告打不开：本地 web 服务可能未运行";
  for (const res of [null, undefined, {}, { ok: false }, { ok: false, error: "" }, { ok: false, error: 42 }]) {
    assert.equal(readerErrorText(res, fb), fb, JSON.stringify(res) ?? String(res));
  }
});
