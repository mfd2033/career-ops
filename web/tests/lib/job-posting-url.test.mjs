// Tests for jobPostingUrl — 工作器卡片上「打开职位原帖」按钮的显示口径。
//
// Run:  node --test tests/lib/job-posting-url.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { jobPostingUrl } from "../../src/lib/job-posting-url.mjs";

test("单条 evaluate URL → 原样可打开", () => {
  const url = "https://www.zhipin.com/job_detail/8c1f0d7e9a2b4c6d.html?securityId=x&ka=sel";
  assert.equal(jobPostingUrl(url), url);
});

test("http 不升级 https — 导航不是去重键", () => {
  assert.equal(jobPostingUrl("http://www.zhaopin.com/jobdetail/CC468463280J40863197215.htm"), "http://www.zhaopin.com/jobdetail/CC468463280J40863197215.htm");
});

test("首尾空白被裁掉，其余逐字保留", () => {
  assert.equal(jobPostingUrl("  https://boards.greenhouse.io/acme/jobs/123  "), "https://boards.greenhouse.io/acme/jobs/123");
});

test("批量 input（urls.join 换行清单）→ null，避免拼出畸形链接", () => {
  // WHATWG URL 会剔除换行，若不先挡空白就会解析出一条假 URL 且通过校验。
  assert.equal(jobPostingUrl("https://a.example/job/1\nhttps://b.example/job/2"), null);
  assert.equal(jobPostingUrl("https://a.example/job/1 https://b.example/job/2"), null);
});

test("非 URL 的 input（报告号 / 公司名）→ null", () => {
  assert.equal(jobPostingUrl("241"), null);
  assert.equal(jobPostingUrl("澜舟科技"), null);
});

test("空值与非法协议 → null", () => {
  assert.equal(jobPostingUrl(""), null);
  assert.equal(jobPostingUrl("   "), null);
  assert.equal(jobPostingUrl(undefined), null);
  assert.equal(jobPostingUrl("javascript:alert(1)"), null);
  assert.equal(jobPostingUrl("file:///C:/job.html"), null);
});
