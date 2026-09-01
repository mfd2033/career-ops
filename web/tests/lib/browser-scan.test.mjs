// Tests for browser-search.mjs — the pure, server-safe helpers behind the
// Explorer's third discovery mode ("browser": scan BOSS直聘/猎聘/智联 through
// the user's own logged-in browser via bsk-extract.mjs).
//
// Run: node --test tests/lib/browser-scan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
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
  // BOSS → &city=<code>; 猎聘 → /city-<slug>/ path; 智联 → &jl=<name>
  const urls = buildSearchUrls(["zhipin", "liepin", "zhaopin"], "项目经理", "郑州");
  assert.equal(urls[0], "https://www.zhipin.com/web/geek/job?query=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&city=101180100");
  assert.equal(urls[1], "https://www.liepin.com/city-zhengzhou/zhaopin/?key=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86");
  assert.equal(urls[2], "https://sou.zhaopin.com/jobs/searchresult.ashx?t=%E9%A1%B9%E7%9B%AE%E7%BB%8F%E7%90%86&jl=%E9%83%91%E5%B7%9E");
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
  assert.equal(browserCityValue("liepin", "郑州"), "zhengzhou");
  assert.equal(browserCityValue("zhaopin", "郑州"), "郑州");
  assert.equal(browserCityValue("zhipin", "不存在的城市"), "");
  assert.equal(browserCityValue("zhipin", ""), "");
  assert.equal(browserCityValue("zhipin", undefined), "");
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