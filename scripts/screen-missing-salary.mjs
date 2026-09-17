// screen-missing-salary.mjs — 只读筛选：在「已评估」页面薪资列显示「—」的行里，
// 找出「JD 其实披露了薪资数字、只是旧报告没写进 Machine Summary 的 advertised_comp」
// 的可回收候选，以及「真·未披露（薪资面议/极简JD无薪资）」的行。
//
// 不写任何报告、不改 tracker。仅产出分类统计 + 候选清单（附 D) 段摘录供人眼复核）。
// 用法：node scripts/screen-missing-salary.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const TRACKER = path.join(ROOT, "data", "applications.md");
const REPORTS_DIR = path.join(ROOT, "reports");

// —— 复刻 report-salary.mjs 的事实源抽取（避免引入整条 import 链） ——
const COMP_LINE_RE = /^[ \t]*advertised_comp:[ \t]*(.*)$/m;
const LEGACY_COMP_RES = [
  /^[ \t]*salary_advertised:[ \t]*(.*)$/m,
  /^[ \t]*comp_advertised:[ \t]*(.*)$/m,
];
const NO_TEXT_RE = /^(null|~|none|n\/a|-)$/i;
function extractAdvertisedComp(md) {
  const m = String(md).match(COMP_LINE_RE);
  if (!m) {
    for (const re of LEGACY_COMP_RES) {
      const lm = md.match(re);
      if (lm) {
        const lt = lm[1].trim().replace(/^["']|["']$/g, "").trim();
        if (lt && !NO_TEXT_RE.test(lt)) return lt;
      }
    }
    return "";
  }
  const text = m[1].trim().replace(/^["']|["']$/g, "").trim();
  return NO_TEXT_RE.test(text) ? "" : text;
}

// —— 强未披露标记（D) 段明确说没披露即判为"正确显示 —"，覆盖"JD未标注/未提及/未列明"等） ——
const STRONG_UNDISC_RE =
  /无 advertised salary|no advertised salary|salary not disclosed|no salary figure|未披露|薪资面议|面议|薪资未披露|薪资未公开|薪资未说明|未公布薪资|薪资未声明|无薪资|JD极简无薪资|无.*薪资披露|未标注薪资|未提及薪资|JD未提及薪资|JD未列明|JD\s*未标注|JD未标注薪资|未列明具体薪资|未标注具体薪资|无公开薪酬数据|无公开薪资|JD极薄.*无薪资/i;

// 强 JD/招聘方薪资归属：数字必须落在这类词附近，才视为"JD 披露"
const STRONG_ATTRIB_RE =
  /(advertised|职位薪资|招聘薪资|明面薪资|标称薪资|该岗位薪资|岗位薪资|JD\s*(薪资|薪酬|range|显示|列明|给出|明面)|薪资[:：]\s*\d|月薪[:：]\s*\d|年薪[:：]\s*\d|工资[:：]\s*\d|薪资范围[:：]\s*\d)/i;

// 负向上下文（市场/目标/注册资金，及"JD 未标明/第三方/推测"等伪归属）
const NEG_CTX_RE =
  /(市场|候选人|target|期望|目标|参考|注册资金|注册资本|融资|capital|面试|项目奖金|底薪\+绩效|奖金|补贴|年化换算|未标明|未声明|未公开|推测|第三方|类似岗位|同页面|非JD|非官方|JD无|JD未|无薪酬|无薪资|JD无薪酬)/i;

// 薪资数字（带单位或裸四位数以上）
const SALARY_NUM_RE =
  /\d{1,3}(?:[.,]\d+)?\s*(?:[kK]|万|w|W|千|元|块|¥|￥|\$|USD)|\b\d{4,7}\b/;

function extractDSection(md) {
  const i = md.indexOf("## D)");
  if (i < 0) return "";
  const j = md.indexOf("## E)", i);
  return j < 0 ? md.slice(i) : md.slice(i, j);
}

function classify(reportMd) {
  const d = extractDSection(reportMd);
  const hasUndisclosed = STRONG_UNDISC_RE.test(d);
  const nums = [...d.matchAll(new RegExp(SALARY_NUM_RE, "g"))];
  let attributed = false;
  if (nums.length) {
    for (const nm of nums) {
      const start = Math.max(0, nm.index - 50);
      const end = Math.min(d.length, nm.index + 50);
      const ctx = d.slice(start, end);
      if (STRONG_ATTRIB_RE.test(ctx) && !NEG_CTX_RE.test(ctx)) {
        attributed = true;
        break;
      }
    }
  }
  if (attributed && !hasUndisclosed) return "recoverable";
  if (hasUndisclosed) return "undisclosed";
  if (nums.length) return "figure-no-attrib"; // 有数字但无明确JD归属（市场/目标值嫌疑）
  return "empty";
}

// —— 解析 tracker 表格 ——
function parseRows(md) {
  const lines = md.split("\n");
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // 数据行：第 2 格是数字
    if (!/^\d+$/.test(cells[1] ?? "")) continue;
    rows.push({
      n: cells[1],
      status: cells[6],
      reportLink: cells[8] ?? "",
      notes: cells[9] ?? "",
    });
  }
  return rows;
}

function resolveReport(row) {
  const m = row.reportLink.match(/\]\(([^)]+)\)/);
  if (m) {
    // 链接相对 data/ 目录；如 ../reports/xxx.md → reports/xxx.md
    const rel = m[1].replace(/^\.\.\//, "");
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p) && p.endsWith(".md")) return p;
  }
  // 兜底：reports/ 下按前导数字匹配
  try {
    const files = fs.readdirSync(REPORTS_DIR);
    const hit = files.find((f) => f.endsWith(".md") && parseInt(f, 10) === parseInt(row.n, 10));
    if (hit) return path.join(REPORTS_DIR, hit);
  } catch {}
  return null;
}

const trackerMd = fs.readFileSync(TRACKER, "utf8");
const rows = parseRows(trackerMd).filter((r) => r.status === "Evaluated");

let hasSalary = 0;
let noReport = 0;
const buckets = { recoverable: [], undisclosed: [], "figure-no-attrib": [], empty: [] };

for (const row of rows) {
  const file = resolveReport(row);
  if (!file) {
    noReport++;
    continue;
  }
  const md = fs.readFileSync(file, "utf8");
  const comp = extractAdvertisedComp(md);
  if (comp) {
    hasSalary++;
    continue;
  }
  const cls = classify(md);
  buckets[cls].push({ n: row.n, file: path.basename(file), notes: row.notes });
}

const dashRows = buckets.recoverable.length + buckets.undisclosed.length + buckets["figure-no-attrib"].length + buckets.empty.length;

console.log("=== 筛选结果（仅 Evaluated 行）===");
console.log(`Evaluated 总行数:           ${rows.length}`);
console.log(`  已有 advertised_comp:     ${hasSalary}  (薪资列正常显示，跳过)`);
console.log(`  无报告文件:               ${noReport}`);
console.log(`  薪资列「—」总数:          ${dashRows}`);
console.log("");
console.log(`  ├ 真·未披露(面议/无薪资):  ${buckets.undisclosed.length}  → 正确显示「—」`);
console.log(`  ├ 可回收(JD有数字未入字段): ${buckets.recoverable.length}  → 候选补评估`);
console.log(`  ├ 有数字但无JD归属:        ${buckets["figure-no-attrib"].length}  → 疑似市场/目标值，需复核`);
console.log(`  └ 全段无数字:              ${buckets.empty.length}`);
console.log("");

if (buckets.recoverable.length) {
  console.log("--- 可回收候选（附 D) 段摘录，请人眼确认是 JD 薪资而非市场/目标）---");
  for (const r of buckets.recoverable) {
    const md = fs.readFileSync(path.join(REPORTS_DIR, r.file), "utf8");
    const d = extractDSection(md).replace(/\n+/g, " ").slice(0, 320);
    console.log(`\n#${r.n}  ${r.file}`);
    console.log(`  notes: ${r.notes.slice(0, 80)}`);
    console.log(`  D): ${d}`);
  }
}
if (buckets["figure-no-attrib"].length) {
  console.log("\n--- 有数字但无明确JD归属（疑似市场/目标值，列出备查）---");
  for (const r of buckets["figure-no-attrib"]) {
    console.log(`  #${r.n}  ${r.file}  | notes: ${r.notes.slice(0, 60)}`);
  }
}
