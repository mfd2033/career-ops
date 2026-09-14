// tests/checkup-ledger.test.mjs
// ADR-0025 的硬边界锁定：data/company-checkups.tsv 是体检数据的唯一机器消费通道，
// lib/log-checkup.mjs 是它的唯一写入方。锁四件事：
//   1. 星级枚举（1.0–5.0、0.5 步进）与日期格式；
//   2. tracker# 空键语义：纯数字或 `?`（invite-match 未命中），别的一律拒；
//   3. risks 闭集 + 去重排序；html 必须在 reports/checkups/ 下；
//   4. parseLedger/summarize 对表头注释、缺列截断行的容忍与聚合口径。
//
// Auto-discovered by test-all.mjs: a discovered suite is a guest, not a co-host —
// it reports through the pass/fail helpers and returns.

import { pass, fail } from './helpers.mjs';
import {
  parseStar,
  parseDate,
  parseTracker,
  buildRow,
  parseLedger,
  summarize,
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
  const got = buildRow(ROW);
  const want = '12\t2026-09-14\tacme\tAcme 科技\t2.5\tentity-confusion,tactics\treports/checkups/12-acme-2026-09-14.html\t主体混淆';
  if (got === want) pass('  合法行逐列正确（risks 去重排序、星级归一 1 位小数）');
  else fail(`  行不匹配：\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`);

  // risks 默认/无风险 → "-"
  if (buildRow({ ...ROW, risks: '' }).split('\t')[5] === '-') pass('  空 risks → "-"');
  else fail('  空 risks 应归 "-"');

  // 未知风险因子被拒
  if (throws(() => buildRow({ ...ROW, risks: 'fake-factor' }))) pass('  未知风险因子被拒');
  else fail('  未知风险因子应被拒');

  // html 越界被拒；`-` 与反斜杠归一
  if (throws(() => buildRow({ ...ROW, html: 'output/x.html' }))) pass('  reports/checkups/ 之外的 html 被拒');
  else fail('  越界 html 应被拒');
  if (throws(() => buildRow({ ...ROW, html: '../leak.html' }))) pass('  越目录 html 被拒');
  else fail('  越目录 html 应被拒');
  const norm = buildRow({ ...ROW, html: 'reports\\checkups\\12-acme.html' }).split('\t')[6];
  if (norm === 'reports/checkups/12-acme.html') pass('  反斜杠路径归一为 /');
  else fail(`  反斜杠归一失败: ${norm}`);

  // 字段禁止制表符/换行
  if (throws(() => buildRow({ ...ROW, note: 'a\tb' }))) pass('  note 含制表符被拒');
  else fail('  note 含制表符应被拒');
  if (throws(() => buildRow({ ...ROW, company: 'a\nb' }))) pass('  company 含换行被拒');
  else fail('  company 含换行应被拒');

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
// 不打印全局汇总：discovered suite 只用 pass/fail 报告（test-all.mjs 纪律），
// 单独 `node tests/checkup-ledger.test.mjs` 跑也同样安静结束。
