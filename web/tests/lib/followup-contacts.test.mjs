// followup-contacts 纯逻辑单测：历史联系人聚合 + 「前三个常驻、其余收起」拆分
// + 自绘下拉的候选与过滤。
// 背景：记录跟进弹窗的联系人字段支持从本报告历史跟进里选人；聚合口径（去重、
// 排序、次数）与截断规则都必须可门，避免两个入口（/followups 行内、报告页
// 按钮）行为漂移。
//
// Run:  node --test web/tests/lib/followup-contacts.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { contactOptions, historyContacts, splitHistoryContacts } from "../../src/lib/followup-contacts.mjs";

// ---- historyContacts：聚合 -------------------------------------------------

test("按输入顺序保留（引擎已倒序 → 首个即最近使用），并带上日期/渠道/次数", () => {
  const list = historyContacts([
    { contact: "张伟", date: "2026-10-28", channel: "Email" },
    { contact: "李静", date: "2026-10-12", channel: "LinkedIn" },
    { contact: "张伟", date: "2026-09-30", channel: "Phone" },
  ]);
  assert.deepEqual(list, [
    { contact: "张伟", date: "2026-10-28", channel: "Email", count: 2 },
    { contact: "李静", date: "2026-10-12", channel: "LinkedIn", count: 1 },
  ]);
});

test("去重对大小写与首尾空白不敏感，展示值取最近一次的原文", () => {
  const list = historyContacts([
    { contact: "  Jane.Doe@Acme.cn ", date: "2026-10-20", channel: "Email" },
    { contact: "jane.doe@acme.cn", date: "2026-10-01", channel: "Email" },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].contact, "Jane.Doe@Acme.cn");
  assert.equal(list[0].date, "2026-10-20");
  assert.equal(list[0].count, 2);
});

test("空联系人被跳过，不产生空 chip", () => {
  const list = historyContacts([
    { contact: "", date: "2026-10-28", channel: "Email" },
    { contact: "   ", date: "2026-10-27", channel: "Email" },
    { date: "2026-10-26", channel: "Email" },
  ]);
  assert.deepEqual(list, []);
});

test("缺字段容错：没有 date/channel 时补空串，不崩溃", () => {
  const list = historyContacts([{ contact: "张伟" }]);
  assert.deepEqual(list, [{ contact: "张伟", date: "", channel: "", count: 1 }]);
});

test("非数组输入（旧引擎无 followups 字段）返回空数组", () => {
  assert.deepEqual(historyContacts(undefined), []);
  assert.deepEqual(historyContacts(null), []);
});

// ---- splitHistoryContacts：常驻前三 + 其余收起 ------------------------------

test("超过三个：前三个常驻，其余进溢出", () => {
  const items = ["a", "b", "c", "d", "e"];
  const { visible, overflow } = splitHistoryContacts(items, 3);
  assert.deepEqual(visible, ["a", "b", "c"]);
  assert.deepEqual(overflow, ["d", "e"]);
});

test("等于三个：全部常驻，溢出为空", () => {
  const { visible, overflow } = splitHistoryContacts(["a", "b", "c"], 3);
  assert.deepEqual(visible, ["a", "b", "c"]);
  assert.deepEqual(overflow, []);
});

test("不足三个：有几个显示几个", () => {
  const { visible, overflow } = splitHistoryContacts(["a"], 3);
  assert.deepEqual(visible, ["a"]);
  assert.deepEqual(overflow, []);
});

test("visible 非法时全部进溢出，位置仍然确定", () => {
  for (const bad of [0, -1, Number.NaN, undefined, "3"]) {
    const { visible, overflow } = splitHistoryContacts(["a", "b"], bad);
    if (bad === undefined) {
      // 未传参走默认值 3
      assert.deepEqual(visible, ["a", "b"]);
      assert.deepEqual(overflow, []);
      continue;
    }
    assert.deepEqual(visible, []);
    assert.deepEqual(overflow, ["a", "b"]);
  }
});

test("非数组输入返回空结果", () => {
  assert.deepEqual(splitHistoryContacts(undefined, 3), { visible: [], overflow: [] });
});

// ---- contactOptions：自绘下拉的候选 ----------------------------------------

const HISTORY = historyContacts([
  { contact: "陈女士", date: "2026-11-12", channel: "Platform" },
  { contact: "jane.doe@acme.cn", date: "2026-10-28", channel: "Email" },
]);
const SUGGESTED = [
  { email: "zhang.wei@acme.cn", name: "张伟" },
  { email: "Jane.Doe@acme.cn", name: "Jane" },
];

test("历史在前、建议在后，历史里已有的地址不重复出现", () => {
  const rows = contactOptions({ history: HISTORY, suggested: SUGGESTED });
  assert.deepEqual(
    rows.map((r) => [r.source, r.value, r.label]),
    [
      ["history", "陈女士", "陈女士"],
      ["history", "jane.doe@acme.cn", "jane.doe@acme.cn"],
      ["suggested", "zhang.wei@acme.cn", "张伟"],
    ],
  );
});

test("历史行带日期与渠道，建议行没有", () => {
  const rows = contactOptions({ history: HISTORY, suggested: SUGGESTED });
  assert.deepEqual(
    rows.map((r) => [r.date, r.channel]),
    [
      ["2026-11-12", "Platform"],
      ["2026-10-28", "Email"],
      ["", ""],
    ],
  );
});

test("建议联系人没姓名时标签退化为邮箱", () => {
  const rows = contactOptions({ suggested: [{ email: "solo@acme.cn", name: null }] });
  assert.deepEqual(rows, [
    { value: "solo@acme.cn", label: "solo@acme.cn", date: "", channel: "", source: "suggested" },
  ]);
});

test("输入即过滤：值或标签命中都算，大小写不敏感", () => {
  const byName = contactOptions({ history: HISTORY, suggested: SUGGESTED, query: "张" });
  assert.deepEqual(byName.map((r) => r.value), ["zhang.wei@acme.cn"]);
  const byEmail = contactOptions({ history: HISTORY, suggested: SUGGESTED, query: "  JANE  " });
  assert.deepEqual(byEmail.map((r) => r.value), ["jane.doe@acme.cn"]);
  const noHit = contactOptions({ history: HISTORY, suggested: SUGGESTED, query: "王" });
  assert.deepEqual(noHit, []);
});

test("空输入与缺省参数都返回空列表，不崩溃", () => {
  assert.deepEqual(contactOptions(), []);
  assert.deepEqual(contactOptions({}), []);
  assert.deepEqual(contactOptions({ history: [], suggested: [] }), []);
});
