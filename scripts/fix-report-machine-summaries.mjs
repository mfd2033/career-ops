// fix-report-machine-summaries.mjs — 修评估报告 Machine Summary 的两类写入缺陷：
//
//   D3  YAML 值未加引号：LLM 把含「: 」或裸引号的中文原文直写进值里
//       （`archetype: PM (hybrid: PM + 技术)` / `culture_screen: "…提及"团队管理"…"`），
//       导致 js-yaml 严格解析报 bad indentation。salary-gap.mjs 这类消费方会静默丢数据。
//       修法：按解析器报错的那一行**逐行**把值重新引号化（JSON 字符串是合法的 YAML
//       双引号标量），只动出错行，不动其它行，不改任何数字文本。
//   D1  报告 Machine Summary `url:` 里的域名 typo → 用同文件报告头 **URL:** 校正
//       （报告头是收件箱原样粘贴的，是这条事实里更可信的一份）。
//
// 用法：node scripts/fix-report-machine-summaries.mjs            # 干跑
//       node scripts/fix-report-machine-summaries.mjs --apply
// 幂等：已能严格解析的围栏直接跳过；重跑不会二次加引号。
// 修复函数导出给 tests/local-report-machine-summary-yaml.test.mjs 直接打靶，
// 因此扫描/写盘的主流程包在 isMain 守卫里（被 import 时不副作用跑盘）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { load as yamlLoad } from "js-yaml";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const APPLY = process.argv.includes("--apply");
const BAD_HOSTS = /^(liepush\.com|liepim\.com|zhopin\.com|zhipn\.com)$/;
const GOOD_HOSTS = /^(liepin\.com|zhipin\.com|zhaopin\.com|51job\.com|lagou\.com)$/;
const NO_VALUE = /^(null|~|true|false|\[\]|\{.*\}|-?\d+(\.\d+)?|["'].+["'])$/;

/** 只把「解析器点名的那一行」的值重新引号化。返回 null 表示这行没法安全修。 */
export function repairLine(rawLine) {
  const m = /^(\s*)([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(rawLine);
  if (!m) return null;
  const [, indent, key, rest] = m;
  let v = rest.replace(/^\s+/, "");
  if (!v) return null;                       // 键本身无值（列表父键）：不是本类缺陷
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1); // 剥外层引号，内部原文保留
  if (NO_VALUE.test(v.trim())) return null;  // 数字/布尔/流式集合：加引号会改类型
  return `${indent}${key}: ${JSON.stringify(v)}`;
}

/** 对一个 YAML 围栏做「报错→改行→重试」的最小修复循环。 */
export function repairFence(yamlText, maxRounds = 30) {
  let cur = yamlText;
  const log = [];
  for (let i = 0; i < maxRounds; i++) {
    try { yamlLoad(cur); return { text: cur, log, ok: true }; } catch (e) {
      const m = String(e.message).match(/\((\d+):(\d+)\)/);
      if (!m) return { text: cur, log, ok: false, why: String(e.message).split("\n")[0].slice(0, 70) };
      const lines = cur.split("\n");
      const idx = Number(m[1]) - 1;
      const fixed = repairLine(lines[idx] ?? "");
      if (!fixed || fixed === lines[idx]) {
        return { text: cur, log, ok: false, why: `第 ${idx + 1} 行无法安全改写：${String(lines[idx] ?? "").trim().slice(0, 60)}` };
      }
      log.push({ line: idx + 1, from: String(lines[idx]).trim().slice(0, 80), to: fixed.trim().slice(0, 80) });
      lines[idx] = fixed;
      cur = lines.join("\n");
    }
  }
  return { text: cur, log, ok: false, why: "超过重试上限" };
}

const changes = [];
function runScanAndMaybeApply() {
for (const f of fs.readdirSync(path.join(ROOT, "reports"))) {
  if (!f.endsWith(".md") || /RESERVED/.test(f)) continue;
  const file = path.join(ROOT, "reports", f);
  const md = fs.readFileSync(file, "utf8");
  let next = md;

  // D1: Machine Summary 的 url 域名 typo → 用报告头校正
  const headUrl = (md.match(/\*\*URL:\*\*\s*(\S+)/i) || [])[1] ?? "";
  const msUrl = (md.match(/^url:[ \t]*["']?(https?:\/\/\S+?)["']?[ \t]*$/m) || [])[1] ?? "";
  let badMs = false;
  try { badMs = msUrl && BAD_HOSTS.test(new URL(msUrl).hostname.replace(/^www\./i, "")); } catch { /* 忽略 */ }
  let goodHead = false;
  try { goodHead = headUrl && GOOD_HOSTS.test(new URL(headUrl).hostname.replace(/^www\./i, "")); } catch { /* 忽略 */ }
  if (badMs && goodHead) {
    next = next.replace(/^url:[ \t]*["']?https?:\/\/\S+?["']?[ \t]*$/m, `url: ${JSON.stringify(headUrl)}`);
    changes.push({ file: f, kind: "url", from: msUrl, to: headUrl });
  }

  // D3: YAML 逐行修复
  const at = next.search(/^##+\s*Machine Summary/im);
  if (at >= 0) {
    const fence = next.slice(at).match(/(```yaml\n)([\s\S]*?)(```)/);
    if (fence) {
      const res = repairFence(fence[2]);
      if (res.log.length) {
        const start = at + fence.index + fence[1].length;
        next = `${next.slice(0, start)}${res.text}${next.slice(start + fence[2].length)}`;
        changes.push({ file: f, kind: "yaml", rounds: res.log.length, ok: res.ok, why: res.why, log: res.log });
      }
    }
  }

  if (APPLY && next !== md) fs.writeFileSync(file, next, "utf8");
}
reportChanges(changes);
}

function reportChanges(changes) {
const yamlFixes = changes.filter((c) => c.kind === "yaml");
console.log(`受影响报告 ${changes.length} 份（yaml ${yamlFixes.length} / url ${changes.filter((c) => c.kind === "url").length}）`);
for (const c of yamlFixes) {
  console.log(`\n${APPLY ? "已改" : "计划"} ${c.file} —— ${c.rounds} 行${c.ok ? "" : ` [仍不可解析: ${c.why}]`}`);
  for (const l of c.log.slice(0, 3)) console.log(`    L${l.line}: ${l.from}\n      → ${l.to}`);
}
for (const c of changes.filter((x) => x.kind === "url")) console.log(`\n${APPLY ? "已改" : "计划"} ${c.file} —— url: ${c.from} → ${c.to}`);
const stillBad = yamlFixes.filter((c) => !c.ok);
if (stillBad.length) console.log(`\n⚠️ ${stillBad.length} 份修完仍不可解析，需人工看`);
if (!APPLY) console.log("\n（干跑未写盘；先 local\\backup-data.cmd，再 --apply）");
}

// 直接被运行时才扫描写盘；被 import（测试）时只暴露上面的纯函数。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runScanAndMaybeApply();
