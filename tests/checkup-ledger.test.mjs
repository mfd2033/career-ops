// tests/checkup-ledger.test.mjs
// ADR-0025 的硬边界锁定：data/company-checkups.tsv 是体检数据的唯一机器消费通道，
// lib/log-checkup.mjs 是它的唯一写入方。锁六件事：
//   1. 星级枚举（1.0–5.0、0.5 步进）与日期格式；
//   2. tracker# 空键语义：纯数字或 `?`（invite-match 未命中），别的一律拒；
//   3. risks 闭集 + 去重排序；html 必须在 reports/checkups/ 下**且文件存在**；
//   4. parseLedger/summarize 对表头注释、缺列截断行的容忍与聚合口径；
//   5. 写入幂等（整行完全相同不追加）与 --help 用法探测；
//   6. 审计（重复行 / 孤儿 tracker# / 缺 HTML）。
//
// Auto-discovered by test-all.mjs: a discovered suite is a guest, not a co-host —
// it reports through the pass/fail helpers and returns.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pass, fail } from './helpers.mjs';
import {
  parseStar,
  parseDate,
  parseTracker,
  buildRow,
  parseLedger,
  summarize,
  findExactDuplicate,
  auditLedger,
  RISK_FACTORS,
} from '../lib/log-checkup.mjs';

const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. 星级 ────────────────────────────────────────────────────────────────
console.log('parseStar 星级枚举');
{
  const ok = ['1', '2.5', '5', 3, 4.0];
  for (const s of ok) {
    try {
      const got = parseStar(s);
      if (got >= 1 && got <= 5) pass(`  ${String(s)} → ${got}`);
      else fail(`  ${String(s)} → ${got}（越界）`);
    } catch (e) {
      fail(`  ${String(s)} 意外被拒: ${e.message}`);
    }
  }
  const bad = ['0', '5.5', '2.3', '-1', 'abc', '', null, undefined, NaN];
  for (const s of bad) {
    if (throws(() => parseStar(s))) pass(`  ${String(s)} 被拒`);
    else fail(`  ${String(s)} 应被拒`);
  }
}

// ── 2. 日期 ────────────────────────────────────────────────────────────────
console.log('parseDate 日期格式');
{
  for (const d of ['2026-09-14', '2024-02-29']) {
    if (!throws(() => parseDate(d))) pass(`  ${d} 通过`);
    else fail(`  ${d} 意外被拒`);
  }
  for (const d of ['2026-9-14', '2026/09/14', '2026-02-30', '2026-13-01', '', '20260914']) {
    if (throws(() => parseDate(d))) pass(`  ${d} 被拒`);
    else fail(`  ${d} 应被拒`);
  }
}

// ── 3. tracker# 空键语义 ───────────────────────────────────────────────────
console.log('parseTracker 关联键');
{
  for (const t of ['12', '007', '?']) {
    try {
      parseTracker(t);
      pass(`  "${t}" 通过`);
    } catch (e) {
      fail(`  "${t}" 意外被拒: ${e.message}`);
    }
  }
  for (const t of ['', 'acme', '12a', '-1', '1 2', null, undefined]) {
    if (throws(() => parseTracker(t))) pass(`  "${t}" 被拒`);
    else fail(`  "${t}" 应被拒`);
  }
}

// ── 4. risks 闭集 + buildRow 行契约 ────────────────────────────────────────
console.log('buildRow 行构造');
{
  const ROW = {
    tracker: '12',
    date: '2026-09-14',
    slug: 'acme',
    company: 'Acme 科技',
    star: 2.5,
    risks: 'tactics,entity-confusion,entity-confusion',
    html: 'reports/checkups/12-acme-2026-09-14.html',
    note: '主体混淆',
  };
  // 形状断言注入「文件存在」缝：本组的对象是行契约，实体校验（HTML 必须真存在）
  // 由下面两组独立用例锁定——默认路径用真文件系统，不能拿它来测形状。
  const YES = { exists: () => true };
  const got = buildRow(ROW, YES);
  const want = '12\t2026-09-14\tacme\tAcme 科技\t2.5\tentity-confusion,tactics\treports/checkups/12-acme-2026-09-14.html\t主体混淆';
  if (got === want) pass('  合法行逐列正确（risks 去重排序、星级归一 1 位小数）');
  else fail(`  行不匹配：\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);

  // risks 默认/无风险 → "-"
  if (buildRow({ ...ROW, risks: '' }, YES).split('\t')[5] === '-') pass('  空 risks → "-"');
  else fail('  空 risks 应归 "-"');

  // 未知风险因子被拒
  if (throws(() => buildRow({ ...ROW, risks: 'fake-factor' }, YES))) pass('  未知风险因子被拒');
  else fail('  未知风险因子应被拒');

  // html 越界被拒；`-` 与反斜杠归一
  if (throws(() => buildRow({ ...ROW, html: 'output/x.html' }, YES))) pass('  reports/checkups/ 之外的 html 被拒');
  else fail('  越界 html 应被拒');
  if (throws(() => buildRow({ ...ROW, html: '../leak.html' }, YES))) pass('  越目录 html 被拒');
  else fail('  越目录 html 应被拒');
  const norm = buildRow({ ...ROW, html: 'reports\\checkups\\12-acme.html' }, YES).split('\t')[6];
  if (norm === 'reports/checkups/12-acme.html') pass('  反斜杠路径归一为 /');
  else fail(`  反斜杠归一失败: ${norm}`);

  // 字段禁止制表符/换行
  if (throws(() => buildRow({ ...ROW, note: 'a\tb' }, YES))) pass('  note 含制表符被拒');
  else fail('  note 含制表符应被拒');
  if (throws(() => buildRow({ ...ROW, company: 'a\nb' }, YES))) pass('  company 含换行被拒');
  else fail('  company 含换行应被拒');

  // 存在性校验（ADR-0030 跟进决议，2026-09-17 #1022）：路径合规 ≠ 报告存在。
  // 默认路径走真文件系统——用一个绝不会存在的文件名即可断言「生产路径确实在校验」。
  if (throws(() => buildRow({ ...ROW, html: 'reports/checkups/__no-such-report__.html' }))) {
    pass('  默认（真文件系统）下，不存在的 HTML 被拒');
  } else {
    fail('  不存在的 HTML 竟通过——#1022 的幽灵行会复活');
  }
  let msg = '';
  try {
    buildRow({ ...ROW, html: 'reports/checkups/__no-such-report__.html' }, { exists: () => false });
  } catch (e) {
    msg = e.message;
  }
  if (/不存在/.test(msg)) pass('  注入 exists=false 时报「报告文件不存在」');
  else fail(`  缺文件的报错文案不符: ${JSON.stringify(msg)}`);
  if (buildRow({ ...ROW, html: '-' }, { exists: () => false }).split('\t')[6] === '-') {
    pass('  `-`（无 HTML 附件）不受存在性影响（ADR-0030 决议 1 仍然成立）');
  } else {
    fail('  `-` 被存在性校验误伤');
  }

  if (Object.keys(RISK_FACTORS).length === 8) pass('  risks 闭集 8 项');
  else fail(`  risks 闭集数量异常: ${Object.keys(RISK_FACTORS).length}`);
}

// ── 5. parseLedger / summarize ─────────────────────────────────────────────
console.log('parseLedger 解析与 summarize 聚合');
{
  const TEXT = [
    '# tracker#\tdate\tcompany-slug\tcompany\tstar\trisks\thtml\tnote',
    '12\t2026-09-14\tacme\tAcme\t2.5\tentity-confusion,review-negative\treports/checkups/12-acme-2026-09-14.html\t主体混淆',
    '12\t2026-09-20\tacme\tAcme\t4.5\t-\treports/checkups/12-acme-2026-09-20.html\t复检转好',
    '?\t2026-09-15\tghost\t幽灵公司\t1.5\tsocial-zero,scale-mismatch,entity-confusion\t-\t参保 0 人',
    '',
    'truncated\t2026-09-16',
  ].join('\n');
  const rows = parseLedger(TEXT);
  if (rows.length === 3) pass('  跳过表头/空行/截断行，得 3 行');
  else fail(`  应得 3 行，实得 ${rows.length}`);

  const ghostRow = rows[2];
  // parseLedger 是宽容读取方：按文件原序返回；排序归一是写入方 buildRow 的职责
  if (eq(ghostRow.risks, ['social-zero', 'scale-mismatch', 'entity-confusion'])) pass('  risks 解析回数组（保留文件原序）');
  else fail(`  risks 解析不符: ${JSON.stringify(ghostRow.risks)}`);

  const s = summarize(rows);
  if (s.total_checkups === 3) pass('  total_checkups = 3');
  else fail(`  total_checkups 应为 3，实得 ${s.total_checkups}`);

  const acme = s.companies.find((c) => c.slug === 'acme');
  if (acme && acme.latest_star === 4.5 && acme.min_star === 2.5 && acme.checkups.length === 2) {
    pass('  acme 聚合：最新 4.5、最低 2.5、两次体检');
  } else {
    fail(`  acme 聚合不符: ${JSON.stringify(acme)}`);
  }
  if (acme && acme.trackers[0] === '12') pass('  acme 关联 tracker# 12');
  else fail(`  acme trackers 不符: ${JSON.stringify(acme?.trackers)}`);

  const ghostAgg = s.companies.find((c) => c.slug === 'ghost');
  if (ghostAgg && ghostAgg.trackers[0] === '?') pass('  ghost 以 `?` 空键聚合（company-slug 仍可关联）');
  else fail(`  ghost trackers 不符: ${JSON.stringify(ghostAgg?.trackers)}`);

  const counts = s.risk_factor_counts;
  if (counts['entity-confusion'] === 2 && counts['social-zero'] === 1 && !('-' in counts)) {
    pass('  risk_factor_counts 频次正确且无 "-" 假因子');
  } else {
    fail(`  risk_factor_counts 不符: ${JSON.stringify(counts)}`);
  }

  // 最新日期排序：acme(09-20) 应排在 ghost(09-15) 前
  if (s.companies[0].slug === 'acme') pass('  companies 按最近体检日期降序');
  else fail(`  排序不符: ${JSON.stringify(s.companies.map((c) => c.slug))}`);

  // 空台账
  const empty = summarize(parseLedger(''));
  if (empty.total_checkups === 0 && empty.companies.length === 0) pass('  空台账 → 零值汇总（优雅降级）');
  else fail('  空台账应得零值汇总');
}

// ── 6. 写入幂等 + 台账审计（2026-09-17 #103 / #1022）───────────────────────
console.log('findExactDuplicate 幂等判据');
{
  const row = '103\t2026-09-17\tmuyuan\t牧原食品集团股份有限公司\t3.0\tarbitration\treports/checkups/103-muyuan-2026-09-17.html\t参保不匹配';
  const one = `# tracker#\tdate\n${row}\n`;
  if (findExactDuplicate(one, row)) pass('  整行完全相同 → 判重（重跑 add 不再追加）');
  else fail('  完全相同的行未被判重——#103 的重复行会复活');
  if (findExactDuplicate(`${one.replace('3.0', '3.5')}`, row) === false) pass('  star 差一位 → 不算重复');
  else fail('  star 不同竟被判重');
  if (findExactDuplicate(one.replace('参保不匹配', '复检转好'), row) === false) pass('  note 不同 → 不算重复（复检照常追加）');
  else fail('  note 不同竟被判重');
  if (findExactDuplicate('', row) === false) pass('  空台账 → 不判重');
  else fail('  空台账不应判重');
  if (findExactDuplicate(`  ${row}\r\n`, row)) pass('  行首缩进 / CRLF 容忍');
  else fail('  缩进或 CRLF 的行未被判重');
}

console.log('auditLedger 三类发现');
{
  const TEXT = [
    '# tracker#\tdate\tcompany-slug\tcompany\tstar\trisks\thtml\tnote',
    '12\t2026-09-14\tacme\tAcme\t2.5\ttactics\treports/checkups/have.html\t主体混淆',
    '12\t2026-09-14\tacme\tAcme\t2.5\ttactics\treports/checkups/have.html\t主体混淆',
    '999\t2026-09-17\tghost\t幽灵公司\t1.5\t-\treports/checkups/gone.html\t孤儿键',
    '?\t2026-09-15\tnokey\t无键公司\t3.0\t-\t-\t公司名模式',
  ].join('\n');
  const rows = parseLedger(TEXT);
  const trackerText = '| 12 | 2026-09-14 | Acme | PM | 3.0/5 | Evaluated | ❌ | [12](x.md) | n | u |\n| 13 | ... |\n';
  const got = auditLedger(rows, trackerText, (rel) => rel === 'reports/checkups/have.html');
  if (got.duplicates.length === 1 && got.duplicates[0].tracker === '12') pass('  重复行只报第二次出现的（1 组）');
  else fail(`  重复行判定不符: ${JSON.stringify(got.duplicates)}`);
  if (got.orphans.length === 1 && got.orphans[0].tracker === '999') pass('  孤儿 tracker# 报出（不在 tracker 里）');
  else fail(`  孤儿判定不符: ${JSON.stringify(got.orphans)}`);
  if (!got.orphans.some((o) => o.tracker === '?')) pass('  `?` 空键不算孤儿（ADR-0025 决议 8）');
  else fail('  `?` 空键被误判为孤儿');
  if (got.missing_html.length === 1 && got.missing_html[0].tracker === '999') pass('  缺 HTML 报出（文件不存在才报）');
  else fail(`  缺 HTML 判定不符: ${JSON.stringify(got.missing_html)}`);
  const noTracker = auditLedger(rows, '', () => true);
  if (noTracker.orphans.length === 0) pass('  读不到 tracker → 跳过孤儿判定（不误报）');
  else fail('  tracker 缺失时不应报孤儿');
}

// ── 7. 用法探测（--help）不抛异常 ──────────────────────────────────────────
// 2026-09-17 实测：agent 拿 `add --help` 探命令用法（常规动作），旧行为把 --help 当成吃值
// 的开关 → 抛「缺少 --help 的值」；那天的 #119 worker 因此误诊并改了本脚本。用法探测现在
// 一律打印 usage 并退 0（内容走 stderr，格式不变）。#27 复盘记的是同一个坑。
console.log('log-checkup CLI --help');
{
  const script = fileURLToPath(new URL('../lib/log-checkup.mjs', import.meta.url));
  for (const argv of [['--help'], ['-h'], ['add', '--help'], ['summary', '-h']]) {
    const r = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status === 0 && /用法:/.test(out)) pass(`  ${argv.join(' ')} → 用法 + 退 0`);
    else fail(`  ${argv.join(' ')} → exit=${r.status}，输出: ${out.slice(0, 120)}`);
  }
  // 对照：未知子命令仍应报用法并退非 0（用法探测的放宽不改变「用错了要报错」）
  const bad = spawnSync(process.execPath, [script, 'nope'], { encoding: 'utf8' });
  if (bad.status !== 0 && /用法:/.test(`${bad.stdout ?? ''}${bad.stderr ?? ''}`)) pass('  未知子命令 → 用法 + 非 0 退出');
  else fail(`  未知子命令应报用法并退非 0，实得 exit=${bad.status}`);
}

// 不打印全局汇总：discovered suite 只用 pass/fail 报告（test-all.mjs 纪律），
// 单独 `node tests/checkup-ledger.test.mjs` 跑也同样安静结束。
