"use strict";

// browser.cjs 的行为测试：钉「地址比对」「命中就切、不命中才开」「后台标签靠标题筛 + URL 核对」
// 这几条规则，不启 PowerShell、不碰真浏览器（注入假的扫描/切标签/激活回调）。

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  brandTokenFromTitle,
  matchesTarget,
  normalizeUrl,
  openOrFocus,
  parseTabs,
  parseWindowList,
  pickCandidateTabs,
  pickReusableWindow,
  tabTitleMatches,
} = require("../src/browser.cjs");

const BRAND = ["career-ops"];

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
    { pid: 2612, url: "localhost:3000/config", tabs: [] },
  ]);
  // PowerShell 5.1 在单元素时会把数组折成对象
  assert.deepEqual(parseWindowList('{"pid":2612,"url":"localhost:3000"}'), [
    { pid: 2612, url: "localhost:3000", tabs: [] },
  ]);
  assert.deepEqual(parseWindowList(""), []);
  assert.deepEqual(parseWindowList("not json"), []);
  assert.deepEqual(parseWindowList('[{"pid":"x","url":"localhost:3000"},{"pid":0,"url":"y"}]'), []);
});

test("parseWindowList：带标签条的窗口——只有标签没有地址也要留下来（后台标签命中就靠它）", () => {
  const stdout = JSON.stringify([
    { pid: 30772, url: "https://qoder.com.cn/cli", tabs: { index: 0, title: "career-ops — official web experience", selected: false } },
    { pid: 40000, url: "", tabs: [] },
  ]);
  assert.deepEqual(parseWindowList(stdout), [
    {
      pid: 30772,
      url: "https://qoder.com.cn/cli",
      tabs: [{ index: 0, title: "career-ops — official web experience", selected: false }],
    },
  ]);
  // 标签条没有 index 时按位置补，坏行丢掉
  assert.deepEqual(parseTabs([{ title: "a" }, { index: 5, title: "b" }]), [
    { index: 0, title: "a", selected: false },
    { index: 5, title: "b", selected: false },
  ]);
  assert.deepEqual(parseTabs(null), []);
});

test("brandTokenFromTitle：取标题首段作品牌词，太短/空给空串", () => {
  assert.equal(brandTokenFromTitle("career-ops — official web experience"), "career-ops");
  assert.equal(brandTokenFromTitle("Career-Ops | scoring methodology"), "career-ops");
  // 分隔符不带空格时不会切（`career-ops` 自己带连字符）
  assert.equal(brandTokenFromTitle("career-ops"), "career-ops");
  assert.equal(brandTokenFromTitle("首页 - Excel"), "");
  assert.equal(brandTokenFromTitle(""), "");
  assert.equal(brandTokenFromTitle(null), "");
});

test("tabTitleMatches：标题含品牌词才算候选", () => {
  assert.equal(tabTitleMatches("career-ops — official web experience", BRAND), true);
  assert.equal(tabTitleMatches("Career-Ops — scoring methodology", BRAND), true);
  assert.equal(tabTitleMatches("我的首页_猎聘", BRAND), false);
  assert.equal(tabTitleMatches("", BRAND), false);
  assert.equal(tabTitleMatches("career-ops", []), false);
});

test("pickCandidateTabs：只挑标题像目标的，记住同窗口当前选中标签、封顶 limit", () => {
  const windows = [
    {
      pid: 30772,
      url: "https://qoder.com.cn/cli",
      tabs: [
        { index: 0, title: "career-ops — official web experience", selected: false },
        { index: 1, title: "研发编程助手", selected: true },
        { index: 2, title: "career-ops — scoring methodology", selected: false },
      ],
    },
    { pid: 40000, url: "https://example.com/", tabs: [] },
  ];
  assert.deepEqual(pickCandidateTabs(windows, BRAND), [
    { pid: 30772, index: 0, restoreIndex: 1, title: "career-ops — official web experience" },
    { pid: 30772, index: 2, restoreIndex: 1, title: "career-ops — scoring methodology" },
  ]);
  assert.equal(pickCandidateTabs(windows, BRAND, 1).length, 1);
  assert.deepEqual(pickCandidateTabs(windows, ["nope"]), []);
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

test("openOrFocus：目标页在**后台标签**里 → 选中它并激活窗口，不开新标签", async () => {
  const opened = [];
  const activated = [];
  const selected = [];
  const result = await openOrFocus("http://localhost:3000/", {
    platform: "win32",
    openExternal: (url) => opened.push(url),
    brandTokens: async () => BRAND,
    scanWindows: async () => [
      {
        pid: 30772,
        url: "https://qoder.com.cn/cli",
        tabs: [
          { index: 0, title: "career-ops — official web experience", selected: false },
          { index: 1, title: "研发编程助手", selected: true },
        ],
      },
    ],
    selectTab: async (pid, index) => {
      selected.push([pid, index]);
      return "http://localhost:3000/";
    },
    activateWindow: async (pid) => {
      activated.push(pid);
      return true;
    },
  });

  assert.deepEqual(selected, [[30772, 0]]);
  assert.deepEqual(activated, [30772]);
  assert.deepEqual(opened, []);
  assert.equal(result.focused, true);
  assert.equal(result.opened, false);
  assert.equal(result.backgroundTab, true);
  assert.equal(result.url, "http://localhost:3000/");
});

test("openOrFocus：候选标签读回来的 URL 不对 → 切回原标签，再试下一个，都不对才新开", async () => {
  const opened = [];
  const selected = [];
  const result = await openOrFocus("http://localhost:3000/pipeline?tab=APPLIED", {
    platform: "win32",
    openExternal: (url) => opened.push(url),
    brandTokens: async () => BRAND,
    scanWindows: async () => [
      {
        pid: 1,
        url: "https://example.com/",
        tabs: [
          { index: 0, title: "career-ops — official web experience", selected: true },
          { index: 1, title: "career-ops — scoring methodology", selected: false },
        ],
      },
    ],
    // 两个候选都不是目标页：第一个是选中态（无需回切），第二个要回切到 index 0
    selectTab: async (pid, index) => {
      selected.push([pid, index]);
      return index === 1 ? "http://localhost:3000/methodology" : "http://localhost:3000/";
    },
    activateWindow: async () => {
      throw new Error("不该被调用");
    },
  });

  assert.deepEqual(selected, [
    [1, 0],
    [1, 1],
    [1, 0],
  ]);
  assert.deepEqual(opened, ["http://localhost:3000/pipeline?tab=APPLIED"]);
  assert.equal(result.opened, true);
  assert.equal(result.backgroundTab, false);
});

test("openOrFocus：窗口里没有标签条 → 不去猜品牌词、不切标签，直接开", async () => {
  const opened = [];
  let brandAsked = false;
  await openOrFocus("http://localhost:3000/", {
    platform: "win32",
    openExternal: (url) => opened.push(url),
    brandTokens: async () => {
      brandAsked = true;
      return BRAND;
    },
    scanWindows: async () => [{ pid: 1, url: "https://example.com/", tabs: [] }],
    selectTab: async () => {
      throw new Error("不该被调用");
    },
    activateWindow: async () => true,
  });
  assert.deepEqual(opened, ["http://localhost:3000/"]);
  assert.equal(brandAsked, false);
});

test("openOrFocus：活动标签命中但激活失败 → 仍然开（不给用户一个打不开的浏览器）", async () => {
  const opened = [];
  const result = await openOrFocus("http://localhost:3000/", {
    platform: "win32",
    openExternal: (url) => opened.push(url),
    brandTokens: async () => BRAND,
    scanWindows: async () => [
      { pid: 2, url: "localhost:3000", tabs: [{ index: 0, title: "career-ops — official web experience", selected: true }] },
    ],
    selectTab: async () => "localhost:3000",
    activateWindow: async () => false,
  });
  assert.equal(result.opened, true);
  // 后台标签也没必要再试：已经停在对的标签上
  assert.deepEqual(opened, ["http://localhost:3000/"]);
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
