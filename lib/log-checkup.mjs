#!/usr/bin/env node
// 公司体检台账守护脚本（ADR-0025）。
//
// data/company-checkups.tsv 是体检数据的唯一机器消费通道（append-only）：
//   # tracker#	date	company-slug	company	star	risks	html	note
//   12	2026-09-14	acme	Acme 科技	2.5	entity-confusion,social-zero	reports/checkups/12-acme-2026-09-14.html	简介主体与工商不一致
//
// 纪律（与 salary-observations / status-log 同一套）：
//   - 只追加，从不覆盖、从不改写既有行（更正 = 新行）；
//   - 写入前校验：星级枚举（1.0–5.0，0.5 步进）、日期格式、tracker# 允许 `?` 空键、
//     risks 闭集、html 必须在 reports/checkups/ 下；
//   - 文件缺失时自建并带表头。
//
// 用法：
//   node lib/log-checkup.mjs add --tracker 12 --date 2026-09-14 --slug acme \
//        --company "Acme 科技" --star 2.5 --risks entity-confusion,social-zero \
//        --html reports/checkups/12-acme-2026-09-14.html --note "主体混淆"
//   node lib/log-checkup.mjs summary            # JSON（供 dashboard / analyze-patterns）
//   node lib/log-checkup.mjs summary --pretty   # 缩进 JSON
//
// --risks 取值（闭集，逗号分隔，`-` 表示无）：
//   social-zero       参保 0 人 / 明确不缴
//   social-mismatch   参保人数远低于宣称规模
//   scale-mismatch    规模虚报
//   entity-confusion  主体混淆 / 壳公司
//   arbitration       劳动仲裁 / 大量投诉
//   review-negative   网络口碑负面（≤3.0/5 或多条一致负面）
//   tactics           招聘套路（title 虚高 / 薪资虚标 / 地址混乱等）
//   media-negative    抖音 / 高德集中负面
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSV = join(ROOT, 'data', 'company-checkups.tsv');

export const LEDGER_HEADER = '# tracker#\tdate\tcompany-slug\tcompany\tstar\trisks\thtml\tnote';

// risks 闭集：声明处即权威（与 status-log 的 VALID_SOURCES 同模式）。
export const RISK_FACTORS = {
  'social-zero': '参保 0 人 / 明确不缴',
  'social-mismatch': '参保人数远低于宣称规模',
  'scale-mismatch': '规模虚报',
  'entity-confusion': '主体混淆 / 壳公司',
  arbitration: '劳动仲裁 / 大量投诉',
  'review-negative': '网络口碑负面',
  tactics: '招聘套路',
  'media-negative': '抖音 / 高德集中负面',
};

const NO_RISKS = '-';

// ── 校验（纯函数，非法输入 throw，消息中文）────────────────────────────────

export function parseStar(input) {
  const n = typeof input === 'number' ? input : parseFloat(String(input).trim());
  if (!Number.isFinite(n) || n * 2 !== Math.round(n * 2) || n < 1 || n > 5) {
    throw new Error(`非法星级 "${input}"：须为 1.0–5.0、0.5 步进`);
  }
  return n;
}

export function parseDate(input) {
  const s = String(input ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`非法日期 "${input}"：须为 YYYY-MM-DD`);
  }
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`非法日期 "${input}"：不是真实存在的日期`);
  }
  return s;
}

// 关联键：纯数字 tracker# 或 `?`（公司名模式 invite-match 未命中，ADR-0025 决议 8）。
export function parseTracker(input) {
  const s = String(input ?? '').trim();
  if (s === '?') return '?';
  if (!/^\d+$/.test(s)) {
    throw new Error(`非法 tracker# "${input}"：须为纯数字或 "?"`);
  }
  return s;
}

function parseRisks(input) {
  const s = String(input ?? '').trim();
  if (s === '' || s === NO_RISKS) return NO_RISKS;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return NO_RISKS;
  const unknown = parts.filter((p) => !(p in RISK_FACTORS));
  if (unknown.length > 0) {
    throw new Error(`非法风险因子 "${unknown.join(',')}"：合法取值为 ${Object.keys(RISK_FACTORS).join(' / ')}（或 "-"）`);
  }
  return [...new Set(parts)].sort().join(',');
}

function parseSlug(input) {
  const s = String(input ?? '').trim();
  if (!s || /\s/.test(s)) throw new Error(`非法 company-slug "${input}"：非空且不含空白`);
  return s;
}

function parseCompany(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new Error('非法 company：非空');
  return forbidControl(s, 'company');
}

function parseHtml(input) {
  const s = String(input ?? '').trim();
  if (s === '' || s === '-') return '-';
  forbidControl(s, 'html');
  // ADR-0025 决议 6：体检报告固定存 reports/checkups/ 下（相对仓库根）。
  const rel = (isAbsolute(s) ? relative(ROOT, resolve(s)) : s).replaceAll('\\', '/');
  if (rel.startsWith('..') || isAbsolute(rel) || !rel.startsWith('reports/checkups/')) {
    throw new Error(`非法 html 路径 "${input}"：体检报告必须位于 reports/checkups/ 下（或 "-" 表示无）`);
  }
  return rel;
}

function parseNote(input) {
  return input == null ? '' : forbidControl(String(input).trim(), 'note');
}

function forbidControl(s, field) {
  if (/[\t\r\n]/.test(s)) throw new Error(`非法 ${field}：不得含制表符/换行（TSV 单行字段）`);
  return s;
}

export function buildRow(input) {
  const row = [
    parseTracker(input.tracker),
    parseDate(input.date),
    parseSlug(input.slug),
    parseCompany(input.company),
    parseStar(input.star).toFixed(1),
    parseRisks(input.risks),
    parseHtml(input.html),
    parseNote(input.note),
  ];
  return row.join('\t');
}

// ── 读取与汇总（纯函数）────────────────────────────────────────────────────

export function parseLedger(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const t = line.replace(/\r$/, '');
    if (!t || t.startsWith('#')) continue; // 表头/注释
    const cols = t.split('\t');
    if (cols.length < 8) continue; // 容忍截断行（append-only 语义下不该有，防御式跳过）
    rows.push({
      tracker: cols[0],
      date: cols[1],
      slug: cols[2],
      company: cols[3],
      star: parseFloat(cols[4]),
      risks: cols[5] === NO_RISKS ? [] : cols[5].split(','),
      html: cols[6],
      note: cols[7] ?? '',
    });
  }
  return rows;
}

export function summarize(rows) {
  const bySlug = new Map();
  for (const row of rows) {
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, []);
    bySlug.get(row.slug).push(row);
  }
  const companies = [...bySlug.values()].map((checkups) => {
    const sorted = [...checkups].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const stars = sorted.map((r) => r.star);
    const latest = sorted[sorted.length - 1];
    return {
      slug: latest.slug,
      company: latest.company,
      trackers: [...new Set(sorted.map((r) => r.tracker))],
      checkups: sorted.map(({ tracker, date, star, risks, html, note }) => ({ tracker, date, star, risks, html, note })),
      latest_star: latest.star,
      latest_date: latest.date,
      min_star: Math.min(...stars),
      max_star: Math.max(...stars),
    };
  });
  companies.sort((a, b) => (a.latest_date < b.latest_date ? 1 : a.latest_date > b.latest_date ? -1 : 0));
  const riskFactorCounts = {};
  for (const row of rows) for (const r of row.risks) riskFactorCounts[r] = (riskFactorCounts[r] ?? 0) + 1;
  return { total_checkups: rows.length, companies, risk_factor_counts: riskFactorCounts };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function usage() {
  console.error('用法: node lib/log-checkup.mjs add --tracker <n|?> --date <YYYY-MM-DD> --slug <slug> --company <名称> --star <1.0-5.0> [--risks <a,b|->] [--html <reports/checkups/…|->] [--note <…>]');
  console.error('      node lib/log-checkup.mjs summary [--pretty]');
}

function flagArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`多余参数 "${a}"`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) throw new Error(`缺少 --${key} 的值`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function cmdAdd(argv) {
  const f = flagArgs(argv);
  for (const required of ['tracker', 'date', 'slug', 'company', 'star']) {
    if (f[required] == null) throw new Error(`缺少必填 --${required}`);
  }
  const row = buildRow({
    tracker: f.tracker,
    date: f.date,
    slug: f.slug,
    company: f.company,
    star: f.star,
    risks: f.risks ?? NO_RISKS,
    html: f.html ?? '-',
    note: f.note ?? '',
  });
  mkdirSync(dirname(TSV), { recursive: true });
  if (!existsSync(TSV)) appendFileSync(TSV, `${LEDGER_HEADER}\n`);
  appendFileSync(TSV, `${row}\n`);
  console.log(`appended: ${row}`);
}

function cmdSummary(argv) {
  const rows = existsSync(TSV) ? parseLedger(readFileSync(TSV, 'utf8')) : [];
  const json = JSON.stringify(summarize(rows), null, argv.includes('--pretty') ? 2 : 0);
  console.log(json);
}

export function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  // 用法探测不抛异常（2026-09-17 实测）：agent 拿 `add --help` 探命令用法是常规动作，
  // 而旧行为把 --help 当成吃值的开关 → 抛「缺少 --help 的值」；那天的 #119 worker 因此
  // 误诊成入口判据问题，直接改了本脚本（错改，已撤销）。--help/-h 一律打印用法并退 0
  // （内容与格式不变，仍走 stderr）。#27 复盘里记的是同一个坑。
  if (cmd === '--help' || cmd === '-h' || rest.includes('--help') || rest.includes('-h')) {
    usage();
    return;
  }
  if (cmd === 'add') cmdAdd(rest);
  else if (cmd === 'summary') cmdSummary(rest);
  else {
    usage();
    process.exitCode = 1;
  }
}

// 仅作为 CLI 直接执行时运行；被测试 import 时不动。
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
