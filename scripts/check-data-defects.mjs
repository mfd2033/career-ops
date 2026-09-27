// check-data-defects.mjs — 四项数据缺陷的判定环（红=缺陷仍在，绿=已修）。
//
// 为什么放 scripts/ 而不是改 verify-pipeline.mjs：这四条是本轮实测出来的 fork-local
// 数据形态问题，先以独立守卫脚本锁住；要并流进主健康检查再由用户决定。
// 用法：node scripts/check-data-defects.mjs          （干跑，输出报告 + 退出码）
//       node scripts/check-data-defects.mjs --json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const JSON_OUT = process.argv.includes("--json");

// ── tracker 解析（列位按表头动态定位）───────────────────────────────────────
const trackerMd = fs.readFileSync(path.join(ROOT, "data", "applications.md"), "utf8");
const cellsOf = (l) => l.split("|").map((c) => c.trim());
const hdr = cellsOf(trackerMd.split("\n").find((l) => l.startsWith("|") && cellsOf(l).includes("#")));
const col = (n) => hdr.findIndex((c) => c.toLowerCase() === n);
const rows = trackerMd.split("\n")
  .filter((l) => l.startsWith("|"))
  .map(cellsOf)
  .filter((c) => /^\d+$/.test(c[col("#")] ?? ""))
  .map((c) => ({
    n: c[col("#")], company: c[col("company")], via: c[col("via")] ?? "",
    role: c[col("role")], report: c[col("report")], url: c[col("url")] ?? "",
    status: c[col("status")] ?? "",
  }));

const reportFileOf = (r) => {
  const m = (r.report ?? "").match(/\]\(([^)]+)\)/);
  if (!m) return null;
  const p = path.join(ROOT, m[1].replace(/^\.\.\//, ""));
  return fs.existsSync(p) ? p : null;
};

const findings = { d1_url_host: [], d2_role_polluted: [], d3_report_unparseable: [], d4_unverifiable: [] };

/** 归一化到裸域：tracker 里 www. 前缀写得不统一，不归一会漏判。 */
function hostOf(u) {
  try {
    return new URL(String(u)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

// ── D1: 不存在的招聘站域名（liepush.com 是 liepin.com 的串字符 typo）──────────
// 判据：tracker URL 列、报告头 **URL:**、Machine Summary `url:` 三处不得出现已知
// 不存在的域。注意同岗多渠道发布（猎聘 vs 官网 lptjob.com）是合法的，所以不能拿
// 「三处域名不一致」当缺陷，只抓黑名域。
const BAD_HOSTS = /^(liepush\.com|liepim\.com|zhopin\.com|zhipn\.com)$/;
for (const r of rows) {
  const host = hostOf(r.url);
  if (!host) continue;
  if (BAD_HOSTS.test(host)) findings.d1_url_host.push({ n: r.n, where: "tracker URL 列", url: r.url });
  const f = reportFileOf(r);
  if (f) {
    const md = fs.readFileSync(f, "utf8");
    const head = (md.match(/\*\*URL:\*\*\s*(\S+)/i) || [])[1] ?? "";
    const ms = (md.match(/^url:[ \t]*["']?(https?:\/\/\S+?)["']?\s*$/m) || [])[1] ?? "";
    for (const [label, u] of [["报告头 **URL:**", head], ["Machine Summary url:", ms]]) {
      if (BAD_HOSTS.test(hostOf(u))) findings.d1_url_host.push({ n: r.n, where: label, url: u, file: path.basename(f) });
    }
  }
}

// ── D2: Role 列被代招机构名污染 ────────────────────────────────────────────
// 判据：Role 不得以 `via=` 开头（via 标签按约定挂在行尾），不得与 Via 列等值，
// 且不得「只有机构名、没有任何职位词」。
const ROLE_WORDS = /(经理|架构师|工程师|开发|项目|技术|总监|主管|专员|顾问|测试|运维|产品|设计师|PM|Java|Python|前端|后端|实施|交付|售前|售后)/i;
const AGENCY_RE = /(人力资源|人才服务|企业管理|咨询服务|劳务派遣|猎头|人力包|外包)/;
for (const r of rows) {
  const role = r.role ?? "";
  if (/^via=/i.test(role)) { findings.d2_role_polluted.push({ n: r.n, reason: "Role 以 via= 开头", role }); continue; }
  if (role && r.via && role.replace(/[()（）\s]/g, "") === r.via.replace(/[()（）\s]/g, "")) {
    findings.d2_role_polluted.push({ n: r.n, reason: "Role 与 Via 等值", role }); continue;
  }
  if (role && AGENCY_RE.test(role) && !ROLE_WORDS.test(role)) {
    findings.d2_role_polluted.push({ n: r.n, reason: "Role 只有机构名、无职位词", role }); continue;
  }
  if (role && /^猎头[—\-–]/.test(role)) findings.d2_role_polluted.push({ n: r.n, reason: "Role 以「猎头—」前缀开头", role });
}

// ── D3: 报告 Machine Summary 必须可严格解析；且不得带 GBK 双重编码乱码 ────────
// 乱码特征：UTF-8 被当 GBK 解出来的高频怪字集（正常中文里几乎不共现）。
const MOJIBAKE_RE = /[锛鐨鍐銆閮鈥鐢涓氳€€椤圭洰]/;
for (const f of fs.readdirSync(path.join(ROOT, "reports"))) {
  if (!f.endsWith(".md") || /RESERVED/.test(f)) continue;
  const md = fs.readFileSync(path.join(ROOT, "reports", f), "utf8");
  const fence = md.slice(md.search(/^##+\s*Machine Summary/im)).match(/```yaml\n([\s\S]*?)```/);
  if (!fence) continue; // 没有该结构的文件不由本环负责（不是本轮缺陷面）
  try {
    yamlLoad(fence[1]);
  } catch (e) {
    findings.d3_report_unparseable.push({ file: f, kind: "yaml", why: String(e.message).split("\n")[0].slice(0, 90) });
  }
  const hits = (md.match(new RegExp(MOJIBAKE_RE.source, "g")) || []).length;
  if (hits > 3) findings.d3_report_unparseable.push({ file: f, kind: "mojibake", why: `疑似 GBK 双重编码，命中 ${hits} 处` });
}

// ── D4: 无法核验的行（BOSS 直聘验证墙 / 职位已关闭 / 无报告）─────────────────
// 这条不是代码缺陷，是「薪资列还能不能救」的台账；红=仍有未处理项。
for (const r of rows.filter((x) => x.status === "Evaluated")) {
  if (r.url && /zhipin\.com/.test(r.url) && !hasRange(r)) findings.d4_unverifiable.push({ n: r.n, why: "BOSS直聘（需人工过验证）" });
}

function hasRange(r) {
  const f = reportFileOf(r);
  if (!f) return false;
  const md = fs.readFileSync(f, "utf8");
  const m = md.match(/^[ \t]*advertised_comp:[ \t]*(.*)$/m);
  if (!m) return false;
  const t = m[1].trim().replace(/^["']|["']$/g, "");
  return /\d+\s*(?:[.,]\d+)?\s*(?:[kK万])?\s*[-–~]\s*\d+/.test(t);
}

const total = Object.values(findings).reduce((a, list) => a + list.length, 0);
if (JSON_OUT) {
  process.stdout.write(`${JSON.stringify({ status: total ? "red" : "green", total, findings }, null, 2)}\n`);
} else {
  for (const [k, list] of Object.entries(findings)) {
    console.log(`${list.length ? "✗" : "✓"} ${k}: ${list.length}`);
    for (const it of list.slice(0, 20)) console.log(`    ${JSON.stringify(it)}`);
    if (list.length > 20) console.log(`    … 其余 ${list.length - 20}`);
  }
  console.log(`\n判定: ${total ? `RED (${total} 项)` : "GREEN"}`);
}
process.exitCode = total ? 1 : 0;
