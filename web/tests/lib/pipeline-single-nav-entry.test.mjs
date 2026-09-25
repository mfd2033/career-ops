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

test("only the checkbox cell and the company link stop propagation", () => {
  // 行点击（ADR-0038）靠 stopPropagation 才不被劫持。去链后 tbody 里该只剩两处：
  // 复选框 <td> 与公司 <Link>。任何新增的拦截格都意味着那一格又不再参与勾选。
  assert.equal(count(TBODY_CODE, "e.stopPropagation()"), 2,
    "职位/分数/角标该冒泡到行 = 切换勾选，不再自行拦截");
});

test("the checkup badges live OUTSIDE the company link", () => {
  // 角标（ADR-0026/0041）从 <Link> 内移出成兄弟：点它 = 勾选，与全行一致；
  // 悬停提示必须留着，否则「这家体检过没有」的信息无从得知。
  const close = TBODY.indexOf("</Link>");
  assert.ok(close > 0, "公司 <Link> 未闭合 — 结构变了，本断言需随 ADR-0062 的宿主改写");
  // 只看公司格内 </Link> 之后的那一段：薪资 <td> 也带 title 提示，全 tbody 计数会误报。
  const cell = TBODY.slice(close, TBODY.indexOf("</td>", close));
  assert.ok(cell.includes("checkupTone(c.star)"),
    "体检★ 角标必须在 </Link> 之后（仍在链接内就会被点击导航劫走）");
  assert.ok(cell.includes('t("pipeline.suggestCheckup")'),
    "「建议体检」角标同上，必须是链接的兄弟节点");
  assert.equal(count(cell, "title={"), 2, "两枚角标移出后仍各自保留 title 提示");
});
