// ADR-0032 决议 3：报告路由 parity 守卫。
//
// 一切渲染 <ReportView> 的路由（page.tsx）都必须把体检数据传下去。漏传的后果
// 是按钮静默消失——用户视角是「功能没了」，而它发生在**路由文件**里，组件层
// 的测试完全看不见（组件只是照 props 渲染）。
//
// 为什么用自动发现而不是硬编码两条路径：这个差异在仓库里出现过两次
// （/report/{n} 少 checkup props，见 ADR-0032），下一个新增的报告路由
// 理应被同一个门拦下，而不是等用户再报一次。
//
// Run: node --test web/tests/lib/report-route-parity.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "app");

/** ReportView 的 props 契约里，体检相关的必传项（形状单一来源 career-ops.ts）。 */
const REQUIRED_PROPS = ["checkup", "checkupTarget"];

function collectPageFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectPageFiles(full));
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

/** `<ReportView …>` 的 props 段（到自闭合 `/>` 为止）。 */
function reportViewProps(src) {
  const start = src.indexOf("<ReportView");
  if (start === -1) return null;
  const rest = src.slice(start);
  const end = rest.indexOf("/>");
  return end === -1 ? rest : rest.slice(0, end);
}

const hosts = collectPageFiles(APP)
  .map((file) => ({ file, props: reportViewProps(readFileSync(file, "utf8")) }))
  .filter((h) => h.props !== null);

// 夹具自检：若路由文件被改写形态（改名、换成动态渲染），守卫会静默变成空循环
// ——先让「找得到宿主」本身成为断言。
test("守卫夹具自检：仍能发现 ReportView 宿主路由", () => {
  assert.ok(hosts.length >= 2, `expected ≥2 ReportView hosts, found ${hosts.length}`);
});

for (const { file, props } of hosts) {
  const rel = relative(APP, file).replace(/\\/g, "/");
  test(`${rel} 把体检数据传给 ReportView`, () => {
    for (const prop of REQUIRED_PROPS) {
      assert.match(
        props,
        new RegExp(`\\b${prop}=\\{`),
        `${rel} 的 <ReportView> 缺少 ${prop}={…}——体检按钮会静默消失（ADR-0032）`,
      );
    }
  });
}
