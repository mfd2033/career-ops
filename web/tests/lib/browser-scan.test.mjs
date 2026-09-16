// Tests for browser-search.mjs — the pure, server-safe helpers behind the
// Explorer's third discovery mode ("browser": scan BOSS直聘/猎聘/智联 through
// the user's own logged-in browser via bsk-extract.mjs).
//
// Run: node --test tests/lib/browser-scan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SEARCH_TEMPLATES,
  BROWSER_SOURCES,
  buildSearchUrls,
  cleanBrowserSources,
  parseBrowserSources,
  browserToParams,
  applyBrowserCity,
  browserCityValue,
  BROWSER_CITY_MAP,
  matchesBrowserCity,
} from "../../src/lib/browser-search.mjs";

// The three supported Chinese platforms must stay fixed — the UI chrome,
// bsk-extract routing and the URL templates all assume them.
test("BROWSER_SOURCES is the closed set of Chinese boards", () => {
  assert.deepEqual([...BROWSER_SOURCES].sort(), ["liepin", "zhaopin", "zhipin"]);
  assert.ok(Object.keys(SEARCH_TEMPLATES).length >= BROWSER_SOURCES.length);
  for (const s of BROWSER_SOURCES) {
    assert.equal(typeof SEARCH_TEMPLATES[s], "string", `template for ${s}`);
    assert.ok(SEARCH_TEMPLATES[s].includes("{q}"), `template for ${s} must carry a {q} slot`);
  }
});

// Every platform keeps a searchable URL template that encodes the query.
test("buildSearchUrls produces one encoded search URL per requested source", () => {
  const urls = buildSearchUrls(["zhipin", "liepin"], "AI 工程师");
  assert.equal(urls.length, 2);
  assert.equal(urls[0], "https://www.zhipin.com/web/geek/job?query=AI%20%E5%B7%A5%E7%A8%8B%E5%B8%88");
  assert.equal(urls[1], "https://www.liepin.com/zhaopin/?key=AI%20%E5%B7%A5%E7%A8%8B%E5%B8%88");
});

test("buildSearchUrls tolerates an empty query and an empty source list", () => {
  assert.deepEqual(buildSearchUrls(["zhipin"], ""), ["https://www.zhipin.com/web/geek/job?query="]);
  assert.deepEqual(buildSearchUrls([], "AI"), []);
});

test("buildSearchUrls skips unknown sources instead of crashing", () => {
  const urls = buildSearchUrls(["zhipin", "not-a-platform", "zhaopin"], "x");
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith("https://")));
});

test("cleanBrowserSources keeps only known sources, dedupes, defaults to all", () => {
  assert.deepEqual(cleanBrowserSources(["zhipin", "zhipin", "liepin"]), ["zhipin", "liepin"]);
  assert.deepEqual(cleanBrowserSources(["bogus", "zhaopin"]), ["zhaopin"]);
  assert.deepEqual(cleanBrowserSources(undefined), [...BROWSER_SOURCES]);
  assert.deepEqual(cleanBrowserSources([]), [...BROWSER_SOURCES]);
  assert.deepEqual(cleanBrowserSources("zhipin"), [...BROWSER_SOURCES]); // non-array → default
});

test("parseBrowserSources splits a comma list and filters unknowns", () => {
  assert.deepEqual(parseBrowserSources("zhipin,liepin"), ["zhipin", "liepin"]);
  assert.deepEqual(parseBrowserSources(" zhipin , bogus "), ["zhipin"]);
  assert.deepEqual(parseBrowserSources(""), []);
});

// The browser-mode URL codec: ?mode=browser&zh=<query>&sources=<csv>. Mirrors
// aiToParams's contract — a browser hunt is shareable/restorable.
test("browserToParams encodes query + sources under mode=browser", () => {
  assert.equal(browserToParams("AI 工程师", ["zhipin", "liepin"]), "mode=browser&zh=AI+%E5%B7%A5%E7%A8%8B%E5%B8%88&sources=zhipin%2Cliepin");
  assert.equal(browserToParams("", ["zhipin"]), "mode=browser&sources=zhipin");
  // empty sources → all sources listed explicitly (so a restore round-trips)
  const all = browserToParams("", []);
  assert.ok(all.startsWith("mode=browser"));
});

// ── City filtering (the browser hunt honors a logical Chinese city per board) ──

test("buildSearchUrls appends the platform-native city slot for a known city", () => {
  // BOSS → &city=<code>; 猎聘 → &dq=<code>; 智联 → &jl=<numeric code> (中文名已失效, 返回全国职位)
  const urls = buildSearchUrls(["zhipin", "liepin", "zhaopin"], "项目经理", "郑州");
  assert.equal(urls[0], "https://www.zhipin.com/web/geek/job?query=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&city=101180100");
  assert.equal(urls[1], "https://www.liepin.com/zhaopin/?key=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&dq=150020");
  assert.equal(urls[2], "https://www.zhaopin.com/jobs?kw=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&jl=719");
});

test("buildSearchUrls keeps the national search for an unknown or empty city", () => {
  assert.equal(
    buildSearchUrls(["zhipin"], "AI 工程师", "非存在的城市")[0],
    "https://www.zhipin.com/web/geek/job?query=AI%20%E5%B7%A5%E7%A8%8B%E5%B8%88",
  );
  assert.equal(buildSearchUrls(["zhipin"], "AI 工程师", "")[0], "https://www.zhipin.com/web/geek/job?query=AI%20%E5%B7%A5%E7%A8%8B%E5%B8%88");
  assert.equal(buildSearchUrls(["zhipin"], "AI 工程师", undefined)[0], "https://www.zhipin.com/web/geek/job?query=AI%20%E5%B7%A5%E7%A8%8B%E5%B8%88");
});

test("BROWSER_CITY_MAP covers every platform for each listed city", () => {
  for (const [name, entry] of Object.entries(BROWSER_CITY_MAP)) {
    assert.equal(typeof name, "string");
    for (const s of BROWSER_SOURCES) {
      assert.equal(typeof entry[s], "string", `city ${name} missing ${s} value`);
      assert.ok(entry[s].length > 0, `city ${name} has empty ${s} value`);
    }
  }
});

test("browserCityValue resolves known cities, empty for unknown/empty", () => {
  assert.equal(browserCityValue("zhipin", "郑州"), "101180100");
  assert.equal(browserCityValue("liepin", "郑州"), "150020");
  assert.equal(browserCityValue("zhaopin", "郑州"), "719");
  assert.equal(browserCityValue("zhipin", "不存在的城市"), "");
  assert.equal(browserCityValue("zhipin", ""), "");
  assert.equal(browserCityValue("zhipin", undefined), "");
});

// ── Post-discovery city gate (Q2 zero-tolerance backstop) ─────────────────

test("matchesBrowserCity trusts an explicit job city field first", () => {
  assert.equal(matchesBrowserCity({ city: "郑州", title: "项目经理" }, "郑州"), true);
  assert.equal(matchesBrowserCity({ city: "北京", title: "项目经理" }, "郑州"), false);
  assert.equal(matchesBrowserCity({ city: "郑州 金水区", title: "项目经理" }, "郑州"), true);
});

test("matchesBrowserCity falls back to the title when no city field exists", () => {
  assert.equal(matchesBrowserCity({ title: "郑州 项目经理" }, "郑州"), true);
  assert.equal(matchesBrowserCity({ title: "项目经理" }, "郑州"), false);
  assert.equal(matchesBrowserCity({}, "郑州"), false);
  assert.equal(matchesBrowserCity(undefined, "郑州"), false);
});

test("matchesBrowserCity passes everything through when no city is requested", () => {
  assert.equal(matchesBrowserCity({ title: "项目经理" }, ""), true);
  assert.equal(matchesBrowserCity({ title: "项目经理" }, undefined), true);
  assert.equal(matchesBrowserCity(undefined, ""), true);
});

test("applyBrowserCity is a no-op for unknown sources and empty values", () => {
  assert.equal(applyBrowserCity("not-a-source", "https://x.com/", "郑州"), "https://x.com/");
  assert.equal(applyBrowserCity("zhipin", "https://www.zhipin.com/web/geek/job?query=x", ""), "https://www.zhipin.com/web/geek/job?query=x");
});

test("browserToParams carries an optional city slot for restorability", () => {
  assert.equal(browserToParams("项目经理", ["zhipin"], "郑州"), "mode=browser&zh=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&sources=zhipin&city=%E9%83%91%E5%B7%9E");
  assert.equal(browserToParams("项目经理", ["zhipin"], ""), "mode=browser&zh=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&sources=zhipin");
  assert.equal(browserToParams("项目经理", ["zhipin"], undefined), "mode=browser&zh=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&sources=zhipin");
});

// ── bsk 主路径的薪酬门控必须带上站点口径（工单 03 缺陷修复）──────────────
// 门控按站点解析薪资（猎聘裸「万」= 年薪），而 bsk 列表行不带 source；
// browser-scan.ts 正在采的 platform 就是唯一答案。这个调用点无法用单测跑到
// （它在子进程 close 回调里），所以按 decision-card-cta.test.mjs 同口径做源码断言，
// 让「又把它漏掉」直接挂门。

test("browser-scan.ts passes the platform into the salary gate", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/core/browser-scan.ts"),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(
    src,
    /applyBrowserSalaryGate\(.*?filters\.zhSalaryMin, platform\)/,
    "the bsk gate call must pass platform as the board fallback, or 猎聘's annual 万 parses as 智联's monthly ×10",
  );
});

// ── 两条 driver 的采集门组合必须一致（ADR-0029 决议 1/7）────────────────────
// browser-scan 的门在子进程 close 回调里、explore-provider 的门在 React 事件里，
// 单测都跑不到，所以按上条同口径做源码断言：两处都必须是「城市门套薪资门，并传
// 入各自的 city」。城市门此前只接在服务端路径上——ADR-0007 E4 的注释声称猎聘/BOSS
// 的城市过滤「复用 web 端 matchesBrowserCity」，实际没有，带城市条件的扩展扫描
// 因此漏进异地卡片（叉车司机【安庆】、食品化验员【宁波】）。

test("browser-scan.ts composes all three collection gates in one expression", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/core/browser-scan.ts"),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(
    src,
    /applyBrowserTitleGate\( applyBrowserCityGate\(applyBrowserSalaryGate\(/,
    "the bsk path must run all three gates at list level, as one composition (薪资门 → 城市门 → 标题门)",
  );
  assert.match(src, /filters\.zhSalaryMin, platform\), city\)/, "the bsk path must pass the requested city into the city gate");
  assert.match(
    src,
    /\{ positive: filters\.positive, negative: filters\.negative \}/,
    "the bsk path must filter titles by the EXPLORER's seeded title_filter, not by re-reading portals.yml",
  );
  assert.match(src, /kind: "folded"/, "the rejects must reach the page — the ledger row and the 已过滤 fold both need them (ADR-0029 决议 4)");
  assert.ok(
    !src.includes("matchesBrowserCity"),
    "browser-scan.ts must not keep a second, per-job city check — every gate lives at list level, so the two drivers cannot drift",
  );
});

test("explore-provider.tsx composes the same three gates for the extension path", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/components/explore/explore-provider.tsx"),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(
    src,
    /applyBrowserTitleGate\(applyBrowserCityGate\(applyBrowserSalaryGate\(found, f\.zhSalaryMin\), city\), \{/,
    "the extension path must run all three gates at scan-offers retrieval — a city-filtered hunt must not leak 异地 postings, nor a keyword hunt the search page's 相关推荐 rail",
  );
  assert.match(
    src,
    /positive: f\.positive, negative: f\.negative/,
    "the extension path must use the same seeded word list as the server path",
  );
});

// ── 被毙岗位的台账送达（ADR-0029 决议 4）──────────────────────────────
// 两条 driver 的 dropped 都必须在同一处落台账、且带 skipped_title：bsk 的来自
// kind:"folded" 事件，扩展路径的是页面侧算的。这里钉住「一个写入点 + 正确的状态」，
// 因为漏掉它正是本仓反复吃过的那类 bug（新流程写了记录、没人标记它在哪结束）。
test("both browser drivers hand their rejects to one ledger write", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/components/explore/explore-provider.tsx"),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(src, /recordFiltered\(gated\.dropped, scanId\)/, "the extension path must record its rejects");
  assert.match(src, /recordFiltered\(foldedAcc, bskScanId\)/, "the bsk path must record the folded batch it received");
  assert.match(src, /status: "skipped_title"/, "the ledger row must carry skipped_title — the value the CLI scanner already writes");
  assert.match(src, /\/api\/explore\/seen/, "the rejects must land in the seen ledger, the same file collection writes to");
});

// ── 被毙原因要穿过服务端路径的重建（gate-visibility 工单 03）────────────────
// 扩展路径的 rejects 是页面侧算的、天然带 gateReason；服务端 bsk 路径会把每条 offer 经
// toOffer 重建一次，字段漏一个就是「同一个折叠区，跑哪条 driver 长得不一样」——一个有解释，
// 一个只有标题和平台。这个错不会让任何测试变红，只会让用户对着「已过滤」猜自己被哪个词毙了。
test("browser-scan.ts carries the title-gate reason through toOffer", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/core/browser-scan.ts"),
    "utf8",
  ).replace(/\s+/g, " ");
  assert.match(src, /dropped\.map\(toOffer\)/, "the rejects leave through toOffer — the one place a field can be silently dropped");
  assert.match(
    src,
    /\.\.\.\(j\.gateReason \? \{ gateReason: j\.gateReason \} : \{\}\)/,
    "toOffer must carry gateReason, or the bsk path's 「已过滤」 fold renders a title and a platform with no explanation while the extension path shows one",
  );
});