// tests/inbox-salary-tail.test.mjs
// ADR-0023 的硬边界锁定：收件箱薪资只认 pipeline.md note 尾段（「 · 」分隔的
// 末段）里确认入管写入的形态——salaryText 原文或「薪资未知」标记。用户手写的
// note 内容永不被解析成薪资。同时锁分隔符契约：join 用的是「 · 」（空格-点-
// 空格），裸「·」会把薪资文本自带的「·14薪」系数误切。
//
// Auto-discovered by test-all.mjs: a discovered suite is a guest, not a co-host —
// it reports through the pass/fail helpers and returns.

import { pass, fail, finish } from './helpers.mjs';
import {
  noteSalaryTail,
  inboxSalaryFromNote,
  inboxSalaryRange,
  inboxSalaryMedian,
  passesInboxSalaryFloor,
  salaryBoardFromUrl,
  SALARY_NOTE_UNKNOWN,
} from '../web/src/lib/inbox-salary.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. noteSalaryTail：尾段提取 ────────────────────────────────────────────
const TAIL_CASES = [
  // [note, expected]
  ['20-35K·14薪', { text: '20-35K·14薪' }],              // 整条 note 就是薪资（原 note 为空）
  ['已经投过 · 20-35K·14薪', { text: '20-35K·14薪' }],     // 「原note · salaryText」
  ['已跟进 · 薪资未知', { unknown: true }],                // 「原note · 薪资未知」标记
  [SALARY_NOTE_UNKNOWN, { unknown: true }],               // 整条就是标记
  ['1.5-2.5万', { text: '1.5-2.5万' }],                    // 智联月薪口径原文
  ['7000-8000元', { text: '7000-8000元' }],                // 智联元/月形态
  ['200-300元/天', { text: '200-300元/天' }],              // 非月薪口径仍认作薪资尾段（解析层判未知）
  ['面议', { text: '面议' }],                              // 面议是卡片可携带的薪资文本
  ['周三面试 35K 岗', null],                               // 手写句子不匹配锚定形态
  ['已跟进', null],                                        // 手写 note 无薪资
  ['', null],
  [undefined, null],
  [' -', null],                                            // 清洗后为空
];
console.log('noteSalaryTail 尾段提取');
for (const [note, expected] of TAIL_CASES) {
  const got = noteSalaryTail(note);
  if (eq(got, expected)) pass(`  ${JSON.stringify(note)} → ${JSON.stringify(expected)}`);
  else fail(`  ${JSON.stringify(note)} → ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
}

// 「 · 」分隔符契约：裸「·」不切分（·14薪 是薪资文本自身的年度系数）。
{
  const got = noteSalaryTail('20-35K·14薪');
  if (got && got.text === '20-35K·14薪') pass('  裸「·」不触发切分（·14薪系数保留在尾段）');
  else fail(`  裸「·」被误切：${JSON.stringify(got)}`);
}

// ── 2. inboxSalaryFromNote：尾段 → 展示 + 未知判定 ─────────────────────────
console.log('inboxSalaryFromNote 解析与未知判定');
const PARSE_CASES = [
  // [note, url, expected]
  // 可解析 → 原文直出、不算未知
  [' · 20-35K·14薪', 'https://www.zhipin.com/job/x?ka=x', { salaryText: '20-35K·14薪', salaryUnknown: false, range: { minK: 20, maxK: 35 } }],
  // 猎聘裸「万」= 年薪口径 ÷12（20-35万/年 → 16.7-29.2K/月）
  [' · 20-35万', 'https://www.liepin.com/zhaopin/?key=x', { salaryText: '20-35万', salaryUnknown: false, range: { minK: 16.7, maxK: 29.2 } }],
  // 智联裸「万」= 月薪 ×10
  [' · 1.5-2.5万', 'https://www.zhaopin.com/jobs/1', { salaryText: '1.5-2.5万', salaryUnknown: false, range: { minK: 15, maxK: 25 } }],
  // 元/天口径解析不出月薪 → 原文保留 + 未知打标（展示双出，与探索页卡片一致）
  [' · 200-300元/天', 'https://www.zhipin.com/job/y', { salaryText: '200-300元/天', salaryUnknown: true }],
  // 面议 → 原文 + 未知
  [' · 面议', 'https://www.zhipin.com/job/z', { salaryText: '面议', salaryUnknown: true }],
  // 标记 → 仅未知
  [' · 薪资未知', 'https://www.zhipin.com/job/w', { salaryUnknown: true }],
  // 无尾段/手写 → 仅未知（不误删取向：过滤放行、排序沉底）
  [undefined, 'https://www.zhipin.com/job/v', { salaryUnknown: true }],
  ['周三面试 35K 岗', 'https://www.zhipin.com/job/u', { salaryUnknown: true }],
  // 未知站点缺省口径：裸「万」按月薪（智联缺省）
  [' · 1.5-2.5万', 'https://example.com/job/1', { salaryText: '1.5-2.5万', salaryUnknown: false, range: { minK: 15, maxK: 25 } }],
];
for (const [note, url, expected] of PARSE_CASES) {
  const got = inboxSalaryFromNote(note, url);
  if (eq(got, expected)) pass(`  ${JSON.stringify(note)} @ ${new URL(url).host} → ${JSON.stringify(expected)}`);
  else fail(`  ${JSON.stringify(note)} @ ${new URL(url).host} → ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
}

// ── 3. salaryBoardFromUrl：站点口径 ────────────────────────────────────────
console.log('salaryBoardFromUrl 站点识别');
const BOARD_CASES = [
  ['https://www.zhipin.com/job/x', 'zhipin'],
  ['https://www.liepin.com/a/x', 'liepin'],
  ['https://www.zhaopin.com/jobs/1', 'zhaopin'],
  ['https://jobs.zhipin.com/x', 'zhipin'],
  ['https://boards.greenhouse.io/x', ''],
  ['not a url', ''],
  [undefined, ''],
];
for (const [url, expected] of BOARD_CASES) {
  const got = salaryBoardFromUrl(url);
  if (got === expected) pass(`  ${JSON.stringify(url)} → ${JSON.stringify(expected)}`);
  else fail(`  ${JSON.stringify(url)} → ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
}

// ── 4. inboxSalaryRange + passesInboxSalaryFloor：过滤语义（ADR-0023 决定 3）──
console.log('薪资下限过滤（区间重叠、未知放行）');
const RANGE_CASES = [
  // [salaryText, url, expected range]
  ['20-35K·14薪', 'https://www.zhipin.com/x', { minK: 20, maxK: 35 }],
  ['1.5-2.5万', 'https://www.zhaopin.com/x', { minK: 15, maxK: 25 }],
  ['7000-8000元', 'https://www.zhaopin.com/x', { minK: 7, maxK: 8 }],
  [undefined, 'https://www.zhipin.com/x', null],
  ['面议', 'https://www.zhipin.com/x', null],
  ['200-300元/天', 'https://www.zhipin.com/x', null],
];
for (const [text, url, expected] of RANGE_CASES) {
  const got = inboxSalaryRange(text, url);
  if (eq(got, expected)) pass(`  inboxSalaryRange(${JSON.stringify(text)}) → ${JSON.stringify(expected)}`);
  else fail(`  inboxSalaryRange(${JSON.stringify(text)}) → ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`);
}
const FLOOR_CASES = [
  // [range, floor, passes]
  [{ minK: 20, maxK: 35 }, 20, true],   // 上限 ≥ 下限 → 保留（区间重叠）
  [{ minK: 15, maxK: 25 }, 30, false],  // 上限 < 下限 → 滤掉
  [{ minK: 30, maxK: 40 }, 30, true],   // 贴线保留
  [null, 30, true],                      // 薪资未知 → 放行（不误删）
  [{ minK: 20, maxK: 35 }, 0, true],    // 门关
  [null, 0, true],
];
for (const [range, floor, expected] of FLOOR_CASES) {
  const got = passesInboxSalaryFloor(range, floor);
  if (got === expected) pass(`  passes(${JSON.stringify(range)}, ${floor}) → ${expected}`);
  else fail(`  passes(${JSON.stringify(range)}, ${floor}) → ${got}，期望 ${expected}`);
}

// ── 5. inboxSalaryMedian：排序键（ADR-0023 决定 4，未知沉底）─────────────────
console.log('薪资排序键（区间中位值）');
const MEDIAN_CASES = [
  [{ minK: 20, maxK: 35 }, 27.5],
  [{ minK: 15, maxK: 25 }, 20],
  [{ minK: 16.7, maxK: 29.2 }, 23],  // 四舍五入到 0.1K
  [null, null],                       // 薪资未知 → 沉底
  [undefined, null],
];
for (const [range, expected] of MEDIAN_CASES) {
  const got = inboxSalaryMedian(range);
  if (eq(got, expected)) pass(`  median(${JSON.stringify(range)}) → ${expected}`);
  else fail(`  median(${JSON.stringify(range)}) → ${got}，期望 ${expected}`);
}
// discovered suite 只 pass/fail、不打印全局汇总（test-all.mjs 纪律），单独运行也安静结束。
