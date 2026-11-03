"use strict";

// 进程树的走法与「什么绝不杀」（ADR-0063 修订二）。
//
// 这组用例守的是一次真实事故的原样：2026-11-03，打包后用户的 Edge 整个不见了
// （23 个标签页一起）。根因是 `taskkill /F /IM CareerDashboardTray.exe /T`——
// 壳用 shell.openExternal 打开仪表盘时，浏览器以壳为父进程创建，`/T` 沿树连坐。
// 所以下面每条都问同一个问题：这一行会不会让用户丢掉他的浏览器？

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  BROWSER_IMAGES,
  isBrowserImage,
  isProtectedImage,
  parseProcessTable,
  treeOf,
  killPlan,
} = require("../src/process-tree.cjs");

/** 把 `[pid, ppid, name, createdAt]` 拼成 CIM 会打出的行文本。 */
function tableText(rows) {
  return rows.map((r) => r.join("|")).join("\r\n");
}

const T = 1000; // createdAt 的基准（真实值是 100ns 单位的超大数，比较只看先后）

test("parseProcessTable: 认 `pid|ppid|name|createdAt` 行，忽略空行与无法解析的垃圾", () => {
  const text = ["4242|100|CareerDashboardTray.exe|133000000000000000", "", "  ", "not-a-row", "500|4242|node.exe|133000000000000100"].join("\n");
  const table = parseProcessTable(text);
  assert.equal(table.length, 2, "two real rows survive; blank lines and garbage do not become rows with pid 0");
  assert.deepEqual(table[0], { pid: 4242, ppid: 100, name: "careerdashboardtray.exe", createdAt: 133000000000000000 });
  assert.equal(table[1].name, "node.exe");
});

test("parseProcessTable: 缺列不抛，name 退化为空串（宁可少杀，不可乱杀）", () => {
  const table = parseProcessTable("777\n");
  assert.equal(table.length, 1);
  assert.equal(table[0].pid, 777);
  assert.equal(table[0].name, "");
});

test("treeOf: 父在前、子在后，祖先的兄弟不在树里", () => {
  const table = parseProcessTable(
    tableText([
      [100, 1, "explorer.exe", T],
      [4242, 100, "CareerDashboardTray.exe", T + 10],
      [500, 4242, "node.exe", T + 20],
      [600, 4241, "unrelated.exe", T + 20],
    ]),
  );
  assert.deepEqual(
    treeOf(table, 4242).map((r) => r.pid),
    [4242, 500],
    "the tree is the shell and its child — never the shell's sibling",
  );
});

test("treeOf: PPID 复用造出的假子进程（比父进程还老）必须被挡掉", () => {
  // 2026-11-03 实测：csrss / wininit 报的 ParentProcessId 就是壳的 pid。
  const table = parseProcessTable(
    tableText([
      [4242, 100, "CareerDashboardTray.exe", T + 100],
      [4, 4242, "System", T], // 比父进程还老 → 不可能真是它的子进程
      [8, 4242, "csrss.exe", T + 5],
      [500, 4242, "node.exe", T + 200],
    ]),
  );
  assert.deepEqual(
    treeOf(table, 4242).map((r) => r.pid),
    [4242, 500],
    "only rows created after their parent count as children",
  );
});

test("treeOf: 根进程不在表里 → 空树（调用方据此不动手）", () => {
  const table = parseProcessTable(tableText([[500, 4242, "node.exe", T + 20]]));
  assert.deepEqual(treeOf(table, 4242), []);
  assert.deepEqual(treeOf(null, 4242), []);
});

test("killPlan: 浏览器整棵子树跳过，node 子进程照杀", () => {
  // 壳 → {msedge（+ GPU 子进程）, node（dashboard 服务）}
  const table = parseProcessTable(
    tableText([
      [4242, 100, "CareerDashboardTray.exe", T],
      [700, 4242, "msedge.exe", T + 10],
      [701, 700, "msedge.exe", T + 20], // GPU/渲染进程同名
      [500, 4242, "node.exe", T + 10],
    ]),
  );
  const plan = killPlan(table, 4242);
  assert.deepEqual(plan.kill.map((r) => r.pid), [500, 4242], "children die first, the shell last");
  assert.deepEqual(plan.skipped.map((r) => r.pid), [701, 700], "the whole browser subtree is skipped");
  assert.ok(
    plan.kill.every((r) => !BROWSER_IMAGES.has(r.name)),
    "no browser image may ever appear in the kill list",
  );
});

test("killPlan: 系统关键进程即使挂在壳名下也不杀", () => {
  const table = parseProcessTable(
    tableText([
      [4242, 100, "CareerDashboardTray.exe", T],
      [8, 4242, "csrss.exe", T + 10],
      [900, 4242, "winlogon.exe", T + 10],
      [500, 4242, "node.exe", T + 10],
    ]),
  );
  const plan = killPlan(table, 4242);
  assert.deepEqual(plan.skipped.map((r) => r.name), ["winlogon.exe", "csrss.exe"]);
  assert.deepEqual(plan.kill.map((r) => r.name), ["node.exe", "careerdashboardtray.exe"]);
});

test("killPlan: 树里全是受保护进程 → kill 为空（调用方不得回退成 taskkill /T）", () => {
  const table = parseProcessTable(
    tableText([
      [4242, 100, "msedge.exe", T],
      [700, 4242, "msedge.exe", T + 10],
    ]),
  );
  const plan = killPlan(table, 4242);
  assert.deepEqual(plan.kill, []);
  assert.equal(plan.skipped.length, 2);
});

test("isBrowserImage / isProtectedImage: 大小写与空白折叠", () => {
  for (const name of ["msedge.exe", "  Chrome.EXE ", "firefox.exe", "brave.exe", "opera.exe", "vivaldi.exe"]) {
    assert.equal(isBrowserImage(name), true, `${name} is a browser`);
    assert.equal(isProtectedImage(name), true);
  }
  assert.equal(isBrowserImage("node.exe"), false);
  assert.equal(isBrowserImage("careerdashboardtray.exe"), false);
  assert.equal(isBrowserImage(""), false);
  assert.equal(isProtectedImage("csrss.exe"), true, "system-critical images are protected too");
  assert.equal(isProtectedImage("node.exe"), false);
});
