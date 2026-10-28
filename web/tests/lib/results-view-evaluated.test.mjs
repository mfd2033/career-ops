// evaluatedNoFor 的 URL 维度回归（探索页「已评估」识别）：
// 浏览器板（BOSS/智联/猎聘）扫描记录的 company 常为空串，公司维度必然落空——
// 与 whats-new 路由（evaluatedUrls）和 /api/report-status（normalizeUrl 键）同源
// 的缺口：探索页富化此前只用「公司+岗位」文本匹配，已评估岗位被重新发现时大量
// 漏识别。URL 维度优先（同一职位 URL = 同一岗位，精确无歧义），文本维度兜底
// （tracker 行没写 URL 的场景）。
//
// Run:  node --test web/tests/lib/results-view-evaluated.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatedNoFor } from "../../src/lib/results-view.mjs";
import { normalizeTextKey } from "../../src/lib/core/normalize-text-key.mjs";

const norm = (s) => normalizeTextKey(s, " ");

// 追踪表行：#1164 形态——BOSS 职位 URL、真实公司名
const apps = [
  { n: "1164", company: "熙牛医疗", role: "大数据项目经理（郑州）", url: "https://www.zhipin.com/job_detail/52df484a60f195910nx62dS4FFBU.html" },
  // 无 URL 的 tracker 行（文本维度兜底样本）
  { n: "1144", company: "用友网络河南分公司", role: "项目经理", url: "" },
];

test("浏览器板空公司 + 同 URL tracker 行 → 识别为已评估（本次缺陷的最小复现）", () => {
  const offer = { url: "https://www.zhipin.com/job_detail/52df484a60f195910nx62dS4FFBU.html", company: "", title: "大数据项目经理（郑州）" };
  assert.equal(evaluatedNoFor(offer, apps, norm), "1164");
});

test("URL 归一差异（tracking 参数、scheme、尾斜杠）不影响 URL 维度命中", () => {
  const offer = { url: "http://www.zhipin.com/job_detail/52df484a60f195910nx62dS4FFBU.html?securityId=abc&ka=x/", company: "", title: "大数据项目经理" };
  assert.equal(evaluatedNoFor(offer, apps, norm), "1164");
});

test("URL 不命中时文本维度仍兜底（公司+岗位匹配，原路径回归保护）", () => {
  const offer = { url: "https://www.liepin.com/job/999.shtml", company: "用友网络河南分公司", title: "项目经理" };
  assert.equal(evaluatedNoFor(offer, apps, norm), "1144");
});

test("空公司 + URL 不在追踪表 → 不识别（空键不是通配符，#2666 守卫延续）", () => {
  const offer = { url: "https://www.zhipin.com/job_detail/other.html", company: "", title: "项目经理" };
  assert.equal(evaluatedNoFor(offer, apps, norm), undefined);
});

test("offer 无 URL / tracker 行无 URL 时不误配（空 URL 键永不互等）", () => {
  const offer = { url: "", company: "", title: "项目经理" };
  assert.equal(evaluatedNoFor(offer, apps, norm), undefined);
});
