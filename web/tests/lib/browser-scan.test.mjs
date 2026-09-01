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