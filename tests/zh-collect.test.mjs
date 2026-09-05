// zh-collect.mjs 纯函数单测 — normalizeJobUrl + dedupeJobs。
//
// 采集去重是 browser-scan.ts → zh-collect.mjs 输出契约（BskListing）的基石：
// 同职位不同列表位会带不同 ka/pos 跟踪参数，归一化剥掉后按 URL 去重；智联
// 列表非严格按城市过滤，city 按 anchor 携带并保留在 job 上。全部为纯函数，
// 不触浏览器。
//
// Run:  node --test tests/zh-collect.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeJobUrl, dedupeJobs, isKickedUrl, shouldRetryCollect } from "../zh-collect.mjs";

// ── normalizeJobUrl ──

test("strips known tracking params but keeps the meaningful ones", () => {
  const raw = "https://www.zhipin.com/job_detail/abc.html?ka=search_1&from=zhaopin&pos=3&query=AI";
  const out = normalizeJobUrl(raw);
  assert.equal(out, "https://www.zhipin.com/job_detail/abc.html?query=AI");
});

test("strips hash", () => {
  assert.equal(normalizeJobUrl("https://www.liepin.com/job/123/#fragment"), "https://www.liepin.com/job/123/");
});

test("identical job with different ka/pos collapses to one key", () => {
  const a = normalizeJobUrl("https://www.zhipin.com/job_detail/abc.html?ka=search_1&pos=1");
  const b = normalizeJobUrl("https://www.zhipin.com/job_detail/abc.html?ka=search_2&pos=9");
  assert.equal(a, b);
});

test("invalid URL returns the raw string unchanged (never throws)", () => {
  assert.equal(normalizeJobUrl("not a url"), "not a url");
  assert.equal(normalizeJobUrl(""), "");
  assert.equal(normalizeJobUrl(null), "");
  assert.equal(normalizeJobUrl(undefined), "");
});

// ── dedupeJobs ──

test("resolves relative hrefs against baseUrl", () => {
  const jobs = dedupeJobs([{ href: "/job_detail/abc.html", label: "高级后端工程师" }], "https://www.zhipin.com/web/geek/job", 200);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, "https://www.zhipin.com/job_detail/abc.html");
  assert.equal(jobs[0].title, "高级后端工程师");
});

test("dedupes by normalized URL, keeps first occurrence", () => {
  const anchors = [
    { href: "https://www.zhipin.com/job_detail/abc.html?ka=search_1", label: "高级后端工程师" },
    { href: "https://www.zhipin.com/job_detail/abc.html?ka=search_5&pos=7", label: "高级后端工程师（重复位）" },
    { href: "https://www.zhipin.com/job_detail/def.html", label: "数据工程师" },
  ];
  const jobs = dedupeJobs(anchors, "https://www.zhipin.com/", 200);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, "高级后端工程师");
  assert.equal(jobs[1].title, "数据工程师");
});

test("carries city when present, omits when absent", () => {
  const jobs = dedupeJobs(
    [{ href: "/job/1.html", label: "前端工程师", city: "杭州" }, { href: "/job/2.html", label: "测试工程师" }],
    "https://www.zhipin.com/",
    200,
  );
  assert.equal(jobs[0].city, "杭州");
  assert.equal("city" in jobs[1], false);
});

test("drops empty / too-short titles", () => {
  const jobs = dedupeJobs(
    [{ href: "/a.html", label: "" }, { href: "/b.html", label: "AI" }, { href: "/c.html", label: "算法工程师" }],
    "https://www.zhipin.com/",
    200,
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "算法工程师");
});

test("drops navigation-placeholder labels even on job-detail URLs", () => {
  // BOSS「查看更多信息」安全链接是 job_detail + securityId，URL 过滤挡不住，
  // 但 label 是导航文案——绝不能当职位输出。
  const jobs = dedupeJobs(
    [
      { href: "/job_detail/abc.html?securityId=long", label: "查看更多信息" },
      { href: "/job_detail/def.html", label: "软件项目经理" },
      { href: "/job_detail/ghi.html", label: "查看全部" },
    ],
    "https://www.zhipin.com/",
    200,
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].title, "软件项目经理");
});

test("caps at max", () => {
  const anchors = Array.from({ length: 10 }, (_, i) => ({ href: `/job/${i}.html`, label: `职位 ${i}` }));
  const jobs = dedupeJobs(anchors, "https://www.zhipin.com/", 3);
  assert.equal(jobs.length, 3);
});

test("non-array anchors yields empty list (never throws)", () => {
  assert.equal(dedupeJobs(undefined, "https://x.com/").length, 0);
  assert.equal(dedupeJobs(null, "https://x.com/").length, 0);
  assert.equal(dedupeJobs([], "https://x.com/").length, 0);
});

// ── isKickedUrl：风控踢出判定 ──

test("about:blank and empty URLs are kicked", () => {
  assert.equal(isKickedUrl("about:blank"), true);
  assert.equal(isKickedUrl(""), true);
  assert.equal(isKickedUrl(undefined), true);
});

test("off-domain redirects are kicked (login/user walls)", () => {
  assert.equal(isKickedUrl("https://web/user/login"), true);
  assert.equal(isKickedUrl("https://other.example.com/"), true);
  assert.equal(isKickedUrl("https://www.zhipin.com/web/user/"), true); // BOSS 未登录被顶到用户页
  assert.equal(isKickedUrl("https://www.zhipin.com/web/passport/zp/security.html?code=37"), true); // 安全挑战页
});

test("real search result pages are NOT kicked", () => {
  assert.equal(isKickedUrl("https://www.zhipin.com/web/geek/jobs?query=x"), false);
  assert.equal(isKickedUrl("https://www.zhaopin.com/jobs/?query=x"), false);
  assert.equal(isKickedUrl("https://www.liepin.com/zhaopin/?key=x"), false);
});

// ── shouldRetryCollect：空结果 + 被踢 → 重试 ──

test("empty jobs on a kicked URL retries while attempts remain", () => {
  const p = { platform: "zhipin", jobs: 0, url: "about:blank", attempt: 0, maxAttempts: 3 };
  assert.equal(shouldRetryCollect(p), true);
});

test("non-empty jobs on a kicked URL retries while attempts remain", () => {
  // 回归（H1 修复）：被顶到 web/user 的推荐职位只是部分结果，绝不当"到底"。
  // rebuilt: run 实测 15 个被顶到 web/user，但对 BOSS 未登录那只是未登录推荐，
  // 真实搜索结果远不止。被踢 URL 必须重试，collect 主循环会累积更优尝试。
  const p = { platform: "zhipin", jobs: 15, url: "https://www.zhipin.com/web/user/", attempt: 0, maxAttempts: 3 };
  assert.equal(shouldRetryCollect(p), true);
});

test("non-empty jobs on a healthy result URL does not retry", () => {
  // 真正滚到底/翻页到底且 URL 仍健康 → 完整结果，不重试。
  const p = { platform: "zhipin", jobs: 15, url: "https://www.zhipin.com/web/geek/jobs?query=x", attempt: 0, maxAttempts: 3 };
  assert.equal(shouldRetryCollect(p), false);
});

test("empty jobs on a healthy result URL does not retry", () => {
  // 真实空结果（查询无匹配）与被踢不同：URL 正常，重载也无济于事。
  const p = { platform: "zhipin", jobs: 0, url: "https://www.zhipin.com/web/geek/jobs?query=none", attempt: 0, maxAttempts: 3 };
  assert.equal(shouldRetryCollect(p), false);
});

test("liepin empty on a healthy URL does not retry (true empty)", () => {
  const p = { platform: "liepin", jobs: 0, url: "https://www.liepin.com/zhaopin/?key=none", attempt: 0, maxAttempts: 3 };
  assert.equal(shouldRetryCollect(p), false);
});

test("liepin empty on a kicked URL retries", () => {
  const p = { platform: "liepin", jobs: 0, url: "about:blank", attempt: 0, maxAttempts: 3 };
  assert.equal(shouldRetryCollect(p), true);
});

test("last attempt on a kicked URL never retries", () => {
  // 已用尽重试次数：即始仍被踢也不重试（防悬挂）。
  const p = { platform: "zhipin", jobs: 15, url: "https://www.zhipin.com/web/user/", attempt: 2, maxAttempts: 3 };
  assert.equal(shouldRetryCollect(p), false);
});
