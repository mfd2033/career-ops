"use strict";

// browser.cjs 的行为测试：只钉「地址比对」与「命中就切、不命中才开」这两条规则，
// 不启 PowerShell、不碰真浏览器（注入假的扫描/激活回调）。

const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesTarget, normalizeUrl, openOrFocus, parseWindowList, pickReusableWindow } = require("../src/browser.cjs");

test("normalizeUrl：补 scheme、环回别名归一、去尾斜杠", () => {
  assert.deepEqual(normalizeUrl("localhost:3000/config"), { host: "localhost:3000", path: "/config", search: "" });
  assert.deepEqual(normalizeUrl("http://localhost:3000/"), { host: "localhost:3000", path: "", search: "" });
  assert.deepEqual(normalizeUrl("http://127.0.0.1:3000/pipeline?tab=APPLIED"), {
    host: "localhost:3000",
    path: "/pipeline",
    search: "?tab=APPLIED",
  });
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("   "), null);
  assert.equal(normalizeUrl("file:///C:/tmp/x.html"), null);
});

test("matchesTarget：目标为根地址时同源即命中（/config 开着也不必再开根标签）", () => {
  assert.equal(matchesTarget("localhost:3000/config", "http://localhost:3000"), true);
  assert.equal(matchesTarget("http://127.0.0.1:3000/", "http://localhost:3000/"), true);
  assert.equal(matchesTarget("http://localhost:3100/", "http://localhost:3000/"), false);
  assert.equal(matchesTarget("https://example.com/", "http://localhost:3000/"), false);
  assert.equal(matchesTarget("", "http://localhost:3000/"), false);
});

test("matchesTarget：目标为具体页面时必须 path + query 都对上", () => {
  const target = "http://localhost:3000/pipeline?tab=APPLIED";
  assert.equal(matchesTarget("http://localhost:3000/pipeline?tab=APPLIED", target), true);
  assert.equal(matchesTarget("http://localhost:3000/pipeline?tab=OFFER", target), false);
  assert.equal(matchesTarget("http://localhost:3000/pipeline", target), false);
  assert.equal(matchesTarget("http://localhost:3000/", target), false);
});

test("parseWindowList：数组 / 单对象 / 空串 / 垃圾输入都折成合法数组", () => {
  assert.deepEqual(parseWindowList('[{"pid":2612,"url":"localhost:3000/config"}]'), [
    { pid: 2612, url: "localhost:3000/config" },
  ]);
  // PowerShell 5.1 在单元素时会把数组折成对象
  assert.deepEqual(parseWindowList('{"pid":2612,"url":"localhost:3000"}'), [{ pid: 2612, url: "localhost:3000" }]);
  assert.deepEqual(parseWindowList(""), []);
  assert.deepEqual(parseWindowList("not json"), []);
  assert.deepEqual(parseWindowList('[{"pid":"x","url":"localhost:3000"},{"pid":0,"url":"y"}]'), []);
});

test("pickReusableWindow：多窗口里挑命中项，没有就 null", () => {
  const windows = [
    { pid: 1, url: "https://example.com/" },
    { pid: 2, url: "localhost:3000/config" },
  ];
  assert.deepEqual(pickReusableWindow(windows, "http://localhost:3000/"), { pid: 2, url: "localhost:3000/config" });
  assert.equal(pickReusableWindow(windows, "http://localhost:4000/"), null);
});

test("openOrFocus：已有标签页 → 只激活窗口，不开新标签", async () => {
  const opened = [];
  const activated = [];
  const result = await openOrFocus("http://localhost:3000/", {
    platform: "win32",
    openExternal: (url) => opened.push(url),
    scanWindows: async () => [{ pid: 2612, url: "localhost:3000/config" }],
    activateWindow: async (pid) => {
      activated.push(pid);
      return true;
    },
  });

  assert.deepEqual(activated, [2612]);
  assert.deepEqual(opened, []);
  assert.equal(result.focused, true);
  assert.equal(result.opened, false);
  assert.equal(result.pid, 2612);
});

test("openOrFocus：没有命中 / 激活失败 / 扫描抛错 → 都要真的打开", async () => {
  const cases = [
    {
      name: "没有命中",
      scanWindows: async () => [{ pid: 1, url: "https://example.com/" }],
      activateWindow: async () => {
        throw new Error("不该被调用");
      },
    },
    {
      name: "激活失败",
      scanWindows: async () => [{ pid: 2, url: "localhost:3000" }],
      activateWindow: async () => false,
    },
    {
      name: "扫描抛错",
      scanWindows: async () => {
        throw new Error("UIA 不可用");
      },
      activateWindow: async () => true,
    },
  ];

  for (const item of cases) {
    const opened = [];
    const result = await openOrFocus("http://localhost:3000/", {
      platform: "win32",
      openExternal: (url) => opened.push(url),
      scanWindows: item.scanWindows,
      activateWindow: item.activateWindow,
    });
    assert.deepEqual(opened, ["http://localhost:3000/"], item.name);
    assert.equal(result.opened, true, item.name);
  }
});

test("openOrFocus：非 Windows 平台不做探测，直接打开", async () => {
  const opened = [];
  await openOrFocus("http://localhost:3000/", {
    platform: "darwin",
    openExternal: (url) => opened.push(url),
    scanWindows: async () => {
      throw new Error("不该被调用");
    },
    activateWindow: async () => true,
  });
  assert.deepEqual(opened, ["http://localhost:3000/"]);
});

test("openOrFocus：缺少 openExternal 立即报错（不静默吞掉打开动作）", async () => {
  await assert.rejects(() => openOrFocus("http://localhost:3000/", {}), /openExternal/);
});
