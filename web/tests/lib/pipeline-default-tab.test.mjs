// 管道页默认 tab 选择（无 tab 参数时）：已评估 > 0 → EVALUATED，否则 ALL。
//
// 为什么是纯函数单测：这条规则只读状态行、不碰 UI，抽到 pipeline-order.mjs 后
// 可以直接 node --test 覆盖全部分支（TSX 组件无渲染测试基建，见 pipeline-inbox-tab.test.mjs 先例）。
//
// 口径绑定：判定必须与 tabs 计数同源（canonStatus().includes("EVALUATED")），
// 否则会出现「tab 上写着 87，默认却落到别的页」。
//
// Run:  node --test tests/lib/pipeline-default-tab.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultPipelineTab } from "../../src/lib/pipeline-order.mjs";

test("没有已评估行 → ALL", () => {
  const rows = [
    { n: "1", status: "Applied" },
    { n: "2", status: "Rejected" },
    { n: "3", status: "" },
  ];
  assert.equal(defaultPipelineTab(rows), "ALL");
});

test("已有一行已评估 → EVALUATED", () => {
  const rows = [{ n: "1", status: "Applied" }, { n: "2", status: "Evaluated" }];
  assert.equal(defaultPipelineTab(rows), "EVALUATED");
});

test("全部已评估 → EVALUATED", () => {
  assert.equal(defaultPipelineTab([{ n: "1", status: "Evaluated" }]), "EVALUATED");
});

test("空 tracker / 非数组输入 → ALL（不抛错）", () => {
  assert.equal(defaultPipelineTab([]), "ALL");
  assert.equal(defaultPipelineTab(undefined), "ALL");
  assert.equal(defaultPipelineTab(null), "ALL");
});

test("状态别名（Evaluada / Evaluar / Hold / Condicional）同样算已评估", () => {
  for (const status of ["Evaluada", "Evaluar", "Hold", "Condicional", "Evaluado"]) {
    assert.equal(defaultPipelineTab([{ n: "1", status }]), "EVALUATED", `别名 ${status} 未计入已评估`);
  }
});

test("相邻状态不误判：Applied / Applied-something / SKIP / Rejected 都不算已评估", () => {
  for (const status of ["Applied", "SKIP", "Rejected", "Interview", "—"]) {
    assert.equal(defaultPipelineTab([{ n: "1", status }]), "ALL", `${status} 被误判为已评估`);
  }
});