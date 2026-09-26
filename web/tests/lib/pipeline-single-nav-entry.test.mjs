// 管道追踪器表的「唯一站内导航入口」不变量（ADR-0062）。
//
// 为什么钉在源码上：TSX 不可在 node --test 里导入（web 组件无渲染测试基建，
// ADR-0057/0059/0060 同口径），而这条约束恰好是纯声明式的结构事实——「一行里
// 只有一个 <Link>」。先例：unknown-employer-policy.test.mjs、
// report-route-parity.test.mjs 都用源码守卫锁同类不变量。
//
// 这条不变量的代价是真实的：ADR-0038 之后一行有三个链接（公司 / 职位 / 分数），
// 用户想勾选行做批量却误点跳页，丢列表筛选与滚动位置（ADR-0062 背景 2）。
// 没有守卫，下次有人「为了方便」把职位或分数改回链接不会有任何东西变红。
//
// Run:  node --test tests/lib/pipeline-single-nav-entry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = readFileSync(join(WEB, "src", "components", "pipeline-view.tsx"), "utf8");

// 只取追踪器表的 tbody 段——表头 th 的排序 onClick、收件箱分支都不在本不变量内。
const TBODY = SRC.slice(SRC.indexOf("<tbody"), SRC.indexOf("</tbody>"));

/**
 * 剥掉注释，只留代码。源码守卫量的是结构，不是散文：否则一句提到 `<Link>` 或
 * 报告页路由的注释就能让计数假性变红（本件实现时真实踩到过一次）。
 */
function stripComments(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
}

const TBODY_CODE = stripComments(TBODY);
const SRC_CODE = stripComments(SRC);

/** 字符串在 src 里出现的次数（用 split 计，避开正则转义 `${` 的坑）。 */
function count(src, needle) {
  return src.split(needle).length - 1;
}

test("the tracker table has exactly ONE in-app navigation link, and it is the company", () => {
  assert.ok(TBODY.length > 0, "pipeline-view.tsx shape changed — the tracker <tbody> was not found");
  assert.equal(count(TBODY_CODE, "<Link"), 1, "只有公司名该是 <Link>；职位/分数改回链接即违反 ADR-0062");
  assert.equal(count(TBODY_CODE, '`/pipeline/${r.n}${contextQuery}`'), 1, "唯一的链接必须是带列表上下文的 /pipeline/{n}");
});

test("the list has no link to the minimal report page anymore", () => {
  // /report/{n} 从 ADR-0062 起只服务扩展深链与工作器 #N（ADR-0018/0055），
  // 管道列表不再提供入口，也不另找地方补回来。
  // 不锁 /jobs/：本组件为了启动批量任务就得 import `@/components/jobs/job-store`，
  // 那属于模块路径不是导航目标；真的多出一个 Link 会被上一节的计数拦住。
  assert.equal(count(SRC_CODE, "/report/"), 0, "列表里不该再有通往极简报告页的旁路入口");
});

test("role and score render as plain content", () => {
  assert.match(TBODY, /\{r\.role\}/, "职位单元格必须仍在（去链不是删列）");
  assert.match(TBODY, /<Badge tone=\{scoreTone\(r\.score\)\}>\{r\.score \|\| "—"\}<\/Badge>/,
    "分数徽章必须仍以裸 Badge 渲染，取色口径不变");
});

test("company and role are single-line truncated (ADR-0064 修订决议 11)", () => {
  // 行高一致靠截断不靠换行：两列各有一处 truncate，完整文本进 title 悬停。
  assert.equal(count(TBODY_CODE, "truncate"), 2, "公司/职位各一处 truncate，多一列就查谁把行高带回来了");
  assert.match(TBODY, /title=\{companyLabel\(r\)\}/, "公司全名必须可悬停读到");
  assert.match(TBODY, /title=\{r\.role\}/, "职位全文必须可悬停读到");
});

test("only the checkbox cell and the company link stop propagation", () => {
  // 行点击（ADR-0038）靠 stopPropagation 才不被劫持。去链后 tbody 里该只剩两处：
  // 复选框 <td> 与公司 <Link>。任何新增的拦截格都意味着那一格又不再参与勾选。
  assert.equal(count(TBODY_CODE, "e.stopPropagation()"), 2,
    "职位/分数/角标该冒泡到行 = 切换勾选，不再自行拦截");
});

test("checkup state lives in exactly one place: the checkup column (ADR-0064 修订决议 1/5)", () => {
  // 曾是「角标是公司 <Link> 的兄弟节点」（ADR-0062/0026）；同日修订后公司格
  // 不再持任何体检信息，★ 与建议 chip 的唯一落点是体检列——同一行出现两颗
  // 体检状态就是本次要修的重复与换行根源。
  assert.equal(count(TBODY_CODE, "checkupTone(c.star)"), 1, "★ chip 全 tbody 仅体检列一处");
  assert.equal(count(TBODY_CODE, 't("pipeline.suggestCheckup")'), 1, "建议 chip 全 tbody 仅体检列一处");
  assert.match(TBODY, /tab === "EVALUATED" && suggests\?\.has\(r\.n\)/,
    "chip 渲染必须带已评估 tab 门控——suggests 集合离开该 tab 后残留，不得泄漏到其他 tab");
  // 公司格内段（</Link> 之后到本 td 闭合）必须干净
  const close = TBODY.indexOf("</Link>");
  assert.ok(close > 0, "公司 <Link> 未闭合 — 结构变了，本断言需随宿主改写");
  const cell = TBODY.slice(close, TBODY.indexOf("</td>", close));
  assert.ok(!/checkup|suggest/i.test(cell), "公司格不得再出现任何体检 chip");
});

test("the clickable row uses the default arrow, not the hand cursor", () => {
  // 点行 = 切换勾选（ADR-0038），不是跳转。手型按团队规范只代表链接/导航
  // （ADR-0062 增补），所以行本身不能挂 cursor-pointer——否则“点哪都跳”的错觉又回来。
  // 行内 checkbox（原生控件）与公司 <Link>（真链接）仍各自保留手型，不在本断言范围。
  const tr = TBODY_CODE.match(/<tr[\s\S]*?>/)[0];
  assert.ok(tr, "未找到追踪器行 <tr> — 结构变了，本断言需随宿主改写");
  assert.ok(!/cursor-pointer/.test(tr),
    "数据行不该用 cursor-pointer；手型只留给真链接，点行只是勾选");
});
