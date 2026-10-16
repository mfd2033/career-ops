// ext-nav-paths 纯逻辑单测（ADR-0055 修订 / ADR-0078）：扩展 → web 前端路由跳转
// 的路径白名单。白名单是安全边界（窗口消息对页面内任何脚本可见），放行与拒绝两侧
// 都要钉住。
//
// Run:  node --test web/tests/lib/ext-nav-paths.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "web", "src", "lib", "ext-nav-paths.mjs")).href);
const { isExtNavPath, REPORT_PATH_RE, PIPELINE_PATH_RE } = mod.default ?? mod;

test("放行：评估报告页 /report/{1-6位数字}（ADR-0055 既有口径不变）", () => {
  assert.equal(isExtNavPath("/report/1"), true);
  assert.equal(isExtNavPath("/report/1078"), true);
  assert.equal(isExtNavPath("/report/999999"), true);
});

test("放行：收件箱 /pipeline（浮窗 🌐 的固定落点，ADR-0078）", () => {
  assert.equal(isExtNavPath("/pipeline"), true);
  assert.equal(PIPELINE_PATH_RE.test("/pipeline"), true);
});

test("拒绝：报告 path 的形近变体", () => {
  assert.equal(isExtNavPath("/report/"), false, "缺报告号");
  assert.equal(isExtNavPath("/report/abc"), false, "非数字报告号");
  assert.equal(isExtNavPath("/report/1234567"), false, "超 6 位");
  assert.equal(isExtNavPath("/report/12?n=3"), false, "query 不放行");
  assert.equal(isExtNavPath("/report/12/extra"), false, "尾巴不放行");
});

test("拒绝：/pipeline 的形近变体与任意其它路径", () => {
  assert.equal(isExtNavPath("/pipeline/extra"), false);
  assert.equal(isExtNavPath("/pipelines"), false);
  assert.equal(isExtNavPath("/PIPELINE"), false);
  assert.equal(isExtNavPath("/settings"), false);
  assert.equal(isExtNavPath(""), false);
});

test("拒绝：危险 scheme 与协议相对路径", () => {
  assert.equal(isExtNavPath("javascript:alert(1)"), false);
  assert.equal(isExtNavPath("//evil.com/pipeline"), false);
  assert.equal(isExtNavPath("https://localhost:3000/pipeline"), false, "只收 path，不收完整 URL");
});

test("两条正则导出保持各自独立（TSX 与单测消费同一真值）", () => {
  assert.equal(REPORT_PATH_RE instanceof RegExp, true);
  assert.equal(PIPELINE_PATH_RE instanceof RegExp, true);
});
