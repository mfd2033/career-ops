// fix-tracker-fields.mjs — 定向修复 tracker 的两类字段污染（fork-local 数据修复工具）：
//
//   D2 Role 列被代招机构名占据（Role == Via、或 Role 以 `via=` 开头）
//          → 用该行自己的评估报告回填真实职位名（Machine Summary `role:` 优先，
//            取不到则回退报告 H1 的「— {职位}」末段），机构名仍留在 Via 列。
//   D1 URL 列出现不存在的招聘站域名（liepush.com）
//          → 用报告头 **URL:** 校正（报告头当初是从收件箱原样粘进来的，是对的）。
//
// 为什么不用 set-status.mjs：那条通道只管 Status/Notes 的规范写入，改不了 Role/URL；
// 本脚本同样走「共享锁 + 原子写 + 逐行按 tracker# 定位」，只替换目标单元格，
// 不新增/删除行，且默认干跑。批量写数据层前必须先跑 local\backup-data.cmd。
//
// 用法：node scripts/fix-tracker-fields.mjs            # 干跑，打印计划
//       node scripts/fix-tracker-fields.mjs --apply
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const TRACKER = path.join(ROOT, "data", "applications.md");
const APPLY = process.argv.includes("--apply");

const BAD_HOSTS = /^(liepush\.com|liepim\.com|zhopin\.com|zhipn\.com)$/;
// 报告头 URL 只有落在已知招聘站域名上才可信（用作 typo 的修正源）
const GOOD_HOSTS = /^(liepin\.com|zhipin\.com|zhaopin\.com|51job\.com|lagou\.com)$/;
const ROLE_WORDS = /(经理|架构师|工程师|开发|项目|技术|总监|主管|专员|顾问|测试|运维|产品|设计师|PM|Java|Python|前端|后端|实施|交付|售前|售后)/i;
const AGENCY_RE = /(人力资源|人才服务|企业管理|咨询服务|劳务派遣|猎头)/;

const md = fs.readFileSync(TRACKER, "utf8");
const eol = md.includes("\r\n") ? "\r\n" : "\n";
const lines = md.split(/\r?\n/);
const cellsOf = (l) => l.split("|").map((c) => c.trim());
const hdr = cellsOf(lines.find((l) => l.startsWith("|") && cellsOf(l).includes("#")));
const col = (n) => hdr.findIndex((c) => c.toLowerCase() === n);
const strip = (s) => String(s ?? "").replace(/^["']+|["']+$/g, "").trim();

/** 从该行的评估报告里取真实职位名。取不到返回 ""（宁可不改，也不猜）。 */
function roleFromReport(linkCell) {
  const m = String(linkCell ?? "").match(/\]\(([^)]+)\)/);
  if (!m) return "";
  const file = path.join(ROOT, m[1].replace(/^\.\.\//, ""));
  if (!fs.existsSync(file)) return "";
  const t = fs.readFileSync(file, "utf8");
  const ms = strip((t.match(/^role:[ \t]*(.+)$/m) || [])[1] ?? "");
  if (ms && ROLE_WORDS.test(ms)) return ms;
  const h1 = (t.match(/^#\s+.+$/m) || [""])[0];
  // 只按破折号切「公司 — 职位」：按 ASCII 连字符切会把「软件实施部长（项目经理-MES方向）」
  // 截成「MES方向）」这种不含职位词的碎片，反而判为取不到
  const seg = h1.split(/[—–]/).pop();
  return strip((seg ?? "").replace(/^:\s*/, ""));
}

/** 从报告头 **URL:** 取规范 URL。 */
function urlFromReport(linkCell) {
  const m = String(linkCell ?? "").match(/\]\(([^)]+)\)/);
  if (!m) return "";
  const file = path.join(ROOT, m[1].replace(/^\.\.\//, ""));
  if (!fs.existsSync(file)) return "";
  const t = fs.readFileSync(file, "utf8");
  return ((t.match(/\*\*URL:\*\*\s*(\S+)/i) || [])[1] ?? "").trim();
}

const edits = [];
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith("|")) continue;
  const cells = cellsOf(lines[i]);
  if (!/^\d+$/.test(cells[col("#")] ?? "")) continue;
  const n = cells[col("#")];
  // 保留原始单元格文本（只给目标格赋值），避免整行其他格被 trim 后产生无谓 diff
  const raw = lines[i].split("|");
  const setCell = (arr, idx, val) => { arr[idx] = ` ${val} `; };
  const out = [...cells];
  let changed = false;

  // D2: Role 污染
  const role = out[col("role")];
  const via = out[col("via")] ?? "";
  const polluted =
    /^via=/i.test(role) ||
    (role && via && role.replace(/[()（）\s]/g, "") === via.replace(/[()（）\s]/g, "")) ||
    (AGENCY_RE.test(role) && !ROLE_WORDS.test(role)) ||
    /^猎头[—\-–]/.test(role);
  if (polluted) {
    const fixed = roleFromReport(out[col("report")]);
    if (fixed && ROLE_WORDS.test(fixed)) { setCell(raw, col("role"), fixed); changed = true; edits.push({ n, field: "Role", from: role, to: fixed }); }
    else edits.push({ n, field: "Role", from: role, to: "(报告里取不到可信职位名 → 不改)", skip: true });
  }

  // D1: URL 黑名域
  const url = out[col("url")] ?? "";
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./i, ""); } catch { /* 无 URL */ }
  if (host && BAD_HOSTS.test(host)) {
    const fixed = urlFromReport(out[col("report")]);
    let fhost = "";
    try { fhost = new URL(fixed).hostname.replace(/^www\./i, ""); } catch { /* 报告头也没有 URL */ }
    if (fixed && GOOD_HOSTS.test(fhost)) { setCell(raw, col("url"), fixed); changed = true; edits.push({ n, field: "URL", from: url, to: fixed }); }
    else edits.push({ n, field: "URL", from: url, to: `(报告头 URL=${fixed || "无"} 不可信 → 不改)`, skip: true });
  }

  if (changed) lines[i] = raw.join("|");
}

for (const e of edits) console.log(`${e.skip ? "✗跳过" : APPLY ? "✓已改" : "·计划"} #${e.n} ${e.field}: ${e.from}  →  ${e.to}`);
console.log(`\n共 ${edits.filter((e) => !e.skip).length} 处待改，${edits.filter((e) => e.skip).length} 处保守跳过`);

if (APPLY && edits.some((e) => !e.skip)) {
  const tmp = `${TRACKER}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, lines.join(eol), "utf8");
  fs.renameSync(tmp, TRACKER);
  console.log("tracker 已原子写回");
} else if (!APPLY) {
  console.log("（干跑未写盘；先跑 local\\backup-data.cmd，再加 --apply）");
}
