// tests/zh-salary-parse-parity.test.mjs
// Locks the couplings the review found documented-in-comments only.
//
// 中文招聘站的薪资提取在三个地方各有一份实现，且注释自承「三处同改 / 两处同改」：
//   • bsk-extract.mjs#extractSalaryFromText —— CLI 侧，函数体经 toString() 注入页面；
//   • extension/site-liepin.js#extractSalaryFromCardText —— 猎聘 content script 兜底；
//   • extension/site-boss.js#extractSalaryFromCardText —— BOSS content script 兜底；
// 另有 BOSS PUA 数字映射在 bsk-extract.mjs 与 extension/scan-pure.js 各一份。
//
// 三处分属不同运行时（注入脚本 / content script / Node），共享模块化不了；dup 本身
// 是可接受的取舍，**靠注释维持同步不可接受**——review 的结论是把它变成会挂门的断言：
//   1. 提取行为逐例对齐（bsk ↔ 猎聘兜底，两者可被 node 加载）；
//   2. 薪资正则字面量在三份实现里逐字相同（覆盖 node 加载不了的 site-boss.js）；
//   3. PUA 数字映射在位（E031=0 … E03A=9）且未映射码点整体不提取（bsk ↔ scan-pure）。
//
// Auto-discovered by test-all.mjs: a discovered suite is a guest, not a co-host —
// it reports through the pass/fail helpers and returns.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { pass, fail, ROOT } from './helpers.mjs';
import { extractSalaryFromText } from '../bsk-extract.mjs';

const require = createRequire(import.meta.url);
// content script 的 node 分支：window 不存在时走 module.exports（见各文件末尾守卫）。
const { extractSalaryFromCardText } = require(join(ROOT, 'extension', 'site-liepin.js'));
const { toDiscoveredOffer } = require(join(ROOT, 'extension', 'scan-pure.js'));

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── 1. 提取行为对齐（bsk 列表兜底 ↔ 猎聘卡片兜底）────────────────────────
// 不含 PUA 输入：两者的契约恰好在 PUA 处分叉——bsk 侧自带解码，卡片兜底把解码交给
// scan-pure 的 toDiscoveredOffer（第 3 节覆盖）。PUA 卡片的薪资数字经卡片 class
// 选择器命中后带进 cardMeta，不依赖本兜底。
const PARITY_CASES = [
  ['服务端开发（Java · 全栈） 【 郑州-郑东新区 】 8-13k 3-5年 本科', '8-13k'],
  ['电解铝厂设备安装项目经理 【 郑州 】 20-30k·13薪 5-10年 大专', '20-30k·13薪'],
  ['高级项目经理 20-35万 五年以上经验', '20-35万'],
  ['数据分析师 1.5-2.5万·13薪', '1.5-2.5万·13薪'],
  ['后端工程师 30K 3-5年', '30K'],
  ['项目经理 5-10年 大专', ''],
  ['项目经理', ''],
  ['', ''],
  [undefined, ''],
];
for (const [text, expected] of PARITY_CASES) {
  const bsk = extractSalaryFromText(text);
  const card = extractSalaryFromCardText(text);
  const label = `extractSalary(${JSON.stringify(text)})`;
  if (bsk !== expected) {
    fail(`${label} via bsk-extract -> ${JSON.stringify(bsk)}, expected ${JSON.stringify(expected)}`);
  } else if (card !== expected) {
    fail(`${label} via site-liepin -> ${JSON.stringify(card)}, expected ${JSON.stringify(expected)}`);
  } else {
    pass(`${label} -> both sides agree on ${JSON.stringify(expected)}`);
  }
}

// ── 2. 薪资正则字面量三份逐字相同 ──────────────────────────────────────
// site-boss.js 在 node 里加载不了（顶层直接读 window.__careerExtCore），所以它那
// 一份只能靠源码比对钉住。取「区间优先」那条正则的字面量原文做全等。
const SALARY_REGEX_ANCHOR = '\\d+(?:\\.\\d+)?\\s*[-–~]';
function salaryRegexLiteral(src) {
  const i = src.indexOf(SALARY_REGEX_ANCHOR);
  if (i < 0) return null;
  const start = src.lastIndexOf('/', i);
  const end = src.indexOf('/', i);
  return start >= 0 && end > start ? src.slice(start, end + 1) : null;
}
const COPIES = [
  'bsk-extract.mjs',
  'extension/site-liepin.js',
  'extension/site-boss.js',
];
const literals = COPIES.map((rel) => [rel, salaryRegexLiteral(read(rel))]);
const [firstRel, firstLit] = literals[0];
if (literals.some(([, lit]) => lit === null)) {
  fail(`salary regex literal not found in: ${literals.filter(([, l]) => l === null).map(([r]) => r).join(', ')}`);
} else {
  const drifted = literals.filter(([, lit]) => lit !== firstLit);
  if (drifted.length === 0) {
    pass(`salary regex is byte-identical across ${COPIES.length} copies (${firstRel} is the reference)`);
  } else {
    fail(`salary regex drifted from ${firstRel} in: ${drifted.map(([r, l]) => `${r} (${l})`).join(' | ')}`);
  }
}

// ── 3. PUA 数字映射在位（bsk ↔ scan-pure）──────────────────────────────
// E03A=9 是 2026-09-14 补的（此前落在映射范围外，含 9 的薪资一律被丢成「薪资未知」）；
// E030 至今零观测，混有未映射码点时必须整体不提取，不做部分解码。
const PUA_RANGE = '[\\uE031-\\uE03A]';
for (const rel of ['bsk-extract.mjs', 'extension/scan-pure.js']) {
  if (read(rel).includes(PUA_RANGE)) {
    pass(`${rel} maps the PUA digit range E031–E03A`);
  } else {
    fail(`${rel} no longer maps ${PUA_RANGE} — E03A=9 (the 2026-09-14 fix) is the one that regresses`);
  }
}

// 映射是 E031+n → n（E031=0 … E039=8、E03A=9），故 E032→1、E036→5、E034→3、E031→0。
const PUA_SALARY = '\uE032\uE036-\uE034\uE031K'; // → 15-30K
// 取证样本：卡片 {E039}-{E03A}K ↔ 详情页明文 8-9K。含 E03A，正是补映射前会整条被
// 丢成「薪资未知」的形态（未映射 PUA 残留 → 不提取）。
const PUA_EVIDENCE = '\uE039-\uE03AK'; // → 8-9K

for (const [raw, expected] of [
  [PUA_SALARY, '15-30K'],
  [PUA_EVIDENCE, '8-9K'],
]) {
  const bskDecoded = extractSalaryFromText(raw);
  const scanDecoded = toDiscoveredOffer({ url: 'https://www.zhipin.com/job_detail/1.html', salary: raw }, 'zhipin').salaryText;
  if (bskDecoded === expected && scanDecoded === expected) {
    pass(`both PUA maps decode ${JSON.stringify(raw)} -> ${expected}`);
  } else {
    fail(`PUA decode differs on ${JSON.stringify(raw)}: bsk=${JSON.stringify(bskDecoded)}, scan-pure=${JSON.stringify(scanDecoded)}, expected ${JSON.stringify(expected)}`);
  }
}

// 未映射码点（E030 零观测）→ 两侧都不得部分解码后透传。
const UNMAPPED = '\uE0305K';
const bskUnmapped = extractSalaryFromText(UNMAPPED);
const scanUnmapped = toDiscoveredOffer({ url: 'https://www.zhipin.com/job_detail/1.html', salary: UNMAPPED }, 'zhipin').salaryText;
if (bskUnmapped === '' && scanUnmapped === undefined) {
  pass(`unmapped PUA (${JSON.stringify(UNMAPPED)}) yields no salary on both sides (薪资未知, no partial decode)`);
} else {
  fail(`unmapped PUA leaked: bsk=${JSON.stringify(bskUnmapped)}, scan-pure=${JSON.stringify(scanUnmapped)}`);
}
