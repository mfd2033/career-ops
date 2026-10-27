// findTailorTarget 纯内核（tailor-target.mjs）的契约测试（工单 generate-tailored-cv/01）。
//
// 要锁住的四件事：① 正常解析返回 {ok:true, company, role, jdText, reportPath}；
// ② 行不存在 → row-not-found；③ 报告缺失 / JD 与报告正文都不可用 → missing-jd；
// ④ jdText 取值顺序：jds 归档正文优先，够长才算数，否则回退报告正文。
// 编号非数字（findApplication 匹配不到行）落进 ② 的 row-not-found 分支。
//
// Run:  node --test web/tests/lib/tailor-target.test.mjs
//
// 纯函数，全部读取用注入的 fake deps，不碰真实文件系统。

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTailorTarget } from "../../src/lib/tailor-target.mjs";

const LONG_JD = "岗位职责：负责数据治理项目交付，协调跨职能团队，推动落地。".repeat(3);
const LONG_REPORT = "## A) 岗位概览\n\n某数据治理项目经理岗位，郑州，15-25K，要求 5 年以上经验。".repeat(2);

// 便捷构造：一份可控的读取环境。captures / reports 用绝对路径键，files 存正文。
function makeDeps({ app, reportPath, files = {}, capturePath = null, checkupCompany }) {
  return {
    findApplication: () => app,
    findReportFilePath: () => reportPath,
    readTextFile: (abs) => (abs in files ? files[abs] : null),
    findJdCapturePath: () => capturePath,
    findCheckupTarget: () =>
      checkupCompany ? { ok: true, company: checkupCompany } : { ok: false, reason: "row-not-found" },
  };
}

test("正常解析：报告在、jds 归档命中 → ok:true，jdText 取归档正文（剥 frontmatter）", () => {
  const deps = makeDeps({
    app: { company: "熙牛医疗", role: "大数据项目经理" },
    reportPath: "/abs/reports/161-xiniu-2026-10-26.md",
    capturePath: "/abs/jds/161-xiniu-jd.md",
    files: {
      "/abs/jds/161-xiniu-jd.md": `---\nurl: https://x/c\n---\n${LONG_JD}`,
      "/abs/reports/161-xiniu-2026-10-26.md": LONG_REPORT,
    },
  });
  const r = resolveTailorTarget("161", deps);
  assert.equal(r.ok, true);
  assert.equal(r.company, "熙牛医疗");
  assert.equal(r.role, "大数据项目经理");
  assert.equal(r.reportPath, "/abs/reports/161-xiniu-2026-10-26.md");
  // 归档正文剥掉 frontmatter 后作为 jdText
  assert.equal(r.jdText, LONG_JD.trim());
});

test("company 复用 findCheckupTarget 的 ?→Via 回退（招聘主体名进产物目录键）", () => {
  const deps = makeDeps({
    app: { company: "?", role: "PM" },
    reportPath: "/abs/reports/7-x.md",
    files: { "/abs/reports/7-x.md": LONG_REPORT },
    checkupCompany: "蓝辉人力资源",
  });
  const r = resolveTailorTarget("7", deps);
  assert.equal(r.ok, true);
  assert.equal(r.company, "蓝辉人力资源");
});

test("jds 归档正文太短（空壳）→ 回退报告正文", () => {
  const deps = makeDeps({
    app: { company: "Acme", role: "Eng" },
    reportPath: "/abs/reports/8-x.md",
    capturePath: "/abs/jds/8-x.md",
    files: {
      "/abs/jds/8-x.md": "短",
      "/abs/reports/8-x.md": LONG_REPORT,
    },
  });
  const r = resolveTailorTarget("8", deps);
  assert.equal(r.ok, true);
  assert.equal(r.jdText, LONG_REPORT.trim());
});

test("行不存在 → row-not-found", () => {
  const deps = makeDeps({ app: null, reportPath: null });
  const r = resolveTailorTarget("999", deps);
  assert.deepEqual(r, { ok: false, reason: "row-not-found" });
});

test("编号非数字（findApplication 匹配不到）→ row-not-found，不抛错", () => {
  const deps = makeDeps({ app: null, reportPath: null });
  const r = resolveTailorTarget("abc", deps);
  assert.deepEqual(r, { ok: false, reason: "row-not-found" });
});

test("报告文件缺失 → missing-jd（openai-tailor 硬性要求 --report）", () => {
  const deps = makeDeps({ app: { company: "Acme", role: "Eng" }, reportPath: null });
  const r = resolveTailorTarget("10", deps);
  assert.deepEqual(r, { ok: false, reason: "missing-jd" });
});

test("报告在但正文不可读、归档也没有 → missing-jd", () => {
  const deps = makeDeps({
    app: { company: "Acme", role: "Eng" },
    reportPath: "/abs/reports/11-x.md",
    files: { "/abs/reports/11-x.md": "" },
  });
  const r = resolveTailorTarget("11", deps);
  assert.deepEqual(r, { ok: false, reason: "missing-jd" });
});
