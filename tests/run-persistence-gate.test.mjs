// tests/run-persistence-gate.test.mjs — /api/run 的 evaluate/checkup 诚实门禁。
//
// 2026-09-16 实测（ADR-0030）：两个 kind=checkup worker 被上游中止，退出 0、
// 有文本输出、零产物，却被记成 done——因为门禁的产物校验内联在 route.ts 里且
// 只覆盖 evaluate（`const persists = kind === "evaluate"`）。内联没有可断言的
// 测试缝，这正是 checkup 长期漏网的原因；门禁整体抽成 run-cli-support.mjs 的
// 纯函数后，这里的每条断言都直接钉在缝上。
//
// #73/#131 回归：checkup + cleanExit + 有文本输出 + 台账零增量 → 必须 error。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pass, fail } from './helpers.mjs';
import {
  persistRunOutcome,
  checkupLedgerRowCount,
  checkupArtifactRowCount,
  checkupArtifactTodayForTracker,
  makeCheckupHtmlProbe,
  PERSISTENCE_GATED_KINDS,
} from '../web/src/lib/run-cli-support.mjs';

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const okMsg = (got, want) => `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;

// ── 1. 门禁覆盖种类单点声明（ADR-0030 决议 3）──────────────────────────────
console.log('PERSISTENCE_GATED_KINDS 覆盖');
{
  if (eq([...PERSISTENCE_GATED_KINDS].sort(), ['checkup', 'evaluate'])) {
    pass('  门禁种类 = evaluate + checkup（fix-portal 缺口由 ADR-0030 记录）');
  } else {
    fail(`  门禁种类不符: ${okMsg([...PERSISTENCE_GATED_KINDS].sort(), ['checkup', 'evaluate'])}`);
  }
}

// ── 2. 假 done 回归（2026-09-16 #73/#131）─────────────────────────────────
console.log('checkup 零产物不得记 done');
{
  const got = persistRunOutcome({ kind: 'checkup', cleanExit: true, sawError: false, emittedText: true, persisted: false });
  if (!got.ok) pass('  道歉式中止 + 零产物 → error（假 done 被拦下）');
  else fail('  checkup 零产物竟通过门禁——#73/#131 的假 done 复活');
  if (!got.ok && /company-checkups\.tsv/.test(got.message)) pass('  失败文案点名台账通道');
  else fail(`  失败文案未点名台账通道: ${JSON.stringify(got.message)}`);
}
{
  const got = persistRunOutcome({ kind: 'checkup', cleanExit: true, sawError: false, emittedText: true, persisted: true });
  if (got.ok) pass('  台账有新增行 → done');
  else fail(`  正常落盘的 checkup 被误拒: ${JSON.stringify(got.message)}`);
}
{
  // 被上游掐断但已落盘：仍是「未正常结束」，与 evaluate 的既有语义一致
  const got = persistRunOutcome({ kind: 'checkup', cleanExit: false, sawError: false, emittedText: true, persisted: true });
  if (!got.ok && /hit an error before finishing/.test(got.message)) pass('  落盘但非正常退出 → 仍标 error');
  else fail(`  非正常退出语义被破坏: ${JSON.stringify(got)}`);
}

// ── 3. evaluate 分支逐支等价（迁移不改变现状）──────────────────────────────
console.log('evaluate 门禁保持原语义');
{
  const got = persistRunOutcome({ kind: 'evaluate', cleanExit: true, sawError: false, emittedText: true, persisted: false });
  if (!got.ok && /didn't save a report/.test(got.message)) pass('  未落盘 → 点名报告通道（原文案逐字保留）');
  else fail(`  evaluate 未落盘文案被改动: ${JSON.stringify(got.message)}`);
}
{
  const got = persistRunOutcome({ kind: 'evaluate', cleanExit: true, sawError: false, emittedText: true, persisted: true });
  if (got.ok) pass('  落盘 + 正常退出 → done');
  else fail(`  正常 evaluate 被误拒: ${JSON.stringify(got.message)}`);
}
{
  const got = persistRunOutcome({ kind: 'evaluate', cleanExit: true, sawError: true, emittedText: true, persisted: true });
  if (!got.ok && /hit an error before finishing/.test(got.message)) pass('  sawError 优先于 done');
  else fail(`  sawError 分支被破坏: ${JSON.stringify(got)}`);
}

// ── 3b. 超时终态（2026-09-17 #682：撞 30 分钟上限被读成装/登录问题）───────
console.log('超时（本地定时器杀）不得被误读');
{
  const zero = persistRunOutcome({
    kind: 'checkup',
    cleanExit: false,
    sawError: false,
    emittedText: false,
    persisted: false,
    timedOut: true,
  });
  if (!zero.ok && /30-minute checkup limit/.test(zero.message)) pass('  超时 + 零产物 → 点名 30 分钟上限');
  else fail(`  超时文案不符: ${JSON.stringify(zero.message)}`);
  if (!zero.ok && /company-checkups\.tsv/.test(zero.message)) pass('  仍点名台账通道');
  else fail(`  超时文案未点名台账通道: ${JSON.stringify(zero.message)}`);
  if (!zero.ok && !/installed and authenticated/.test(zero.message)) pass('  不再误报「装没装 / 登没登录」');
  else fail('  超时仍被读成安装/登录问题');
  if (!zero.ok && /smaller research budget/.test(zero.message)) pass('  给出的是可执行的下一步（缩小预算）');
  else fail(`  超时文案缺少下一步: ${JSON.stringify(zero.message)}`);

  const landed = persistRunOutcome({
    kind: 'checkup',
    cleanExit: false,
    sawError: false,
    emittedText: false,
    persisted: true,
    timedOut: true,
  });
  if (!landed.ok && /artifact did land/.test(landed.message) && !/installed and authenticated/.test(landed.message)) {
    pass('  超时但已落盘 → 提示先核验产物（而不是让人重跑）');
  } else {
    fail(`  超时+落盘文案不符: ${JSON.stringify(landed.message)}`);
  }

  const readOnly = persistRunOutcome({
    kind: 'research',
    cleanExit: false,
    sawError: false,
    emittedText: false,
    persisted: false,
    timedOut: true,
  });
  if (!readOnly.ok && /time limit/.test(readOnly.message) && !/installed and authenticated/.test(readOnly.message)) {
    pass('  只读种类超时 → 同样如实说明（不套 30 分钟体检口径）');
  } else {
    fail(`  只读种类超时文案不符: ${JSON.stringify(readOnly.message)}`);
  }

  // timedOut 缺省 = false：既有分支逐字不变（回归保护）
  const notTimedOut = persistRunOutcome({
    kind: 'evaluate',
    cleanExit: false,
    sawError: false,
    emittedText: false,
    persisted: false,
  });
  if (!notTimedOut.ok && /exited with an error/.test(notTimedOut.message)) pass('  timedOut 缺省时既有分支不变');
  else fail(`  缺省分支被改动: ${JSON.stringify(notTimedOut.message)}`);
}

// ── 4. 无输出分支（noOutputError 迁入）────────────────────────────────────
console.log('无输出分支');
{
  const dead = persistRunOutcome({ kind: 'evaluate', cleanExit: false, sawError: false, emittedText: false, persisted: false });
  if (!dead.ok && /exited with an error/.test(dead.message)) pass('  非零退出且零输出 → 装没装好');
  else fail(`  非零退出分支被破坏: ${JSON.stringify(dead)}`);
  const silent = persistRunOutcome({ kind: 'checkup', cleanExit: true, sawError: false, emittedText: false, persisted: false });
  if (!silent.ok && /produced no output/.test(silent.message)) pass('  正常退出但零输出 → 同样拦截');
  else fail(`  零输出分支被破坏: ${JSON.stringify(silent)}`);
}

// ── 5. 只读种类不经此门禁（persisted 恒 false 也放行）────────────────────
console.log('只读种类放行');
{
  const got = persistRunOutcome({ kind: 'research', cleanExit: true, sawError: false, emittedText: true, persisted: false });
  if (got.ok) pass('  research 无产物要求');
  else fail(`  research 被误拒: ${JSON.stringify(got.message)}`);
  const portal = persistRunOutcome({ kind: 'fix-portal', cleanExit: true, sawError: false, emittedText: true, persisted: false });
  if (portal.ok) pass('  fix-portal 维持现状不拦（portals.yml 增量是已记录缺口）');
  else fail('  fix-portal 意外被拦——超出 ADR-0030 范围，先补 portals.yml 增量判据再扩');
}

// ── 6. 台账行计数（ADR-0030 决议 1：只数「像数据行」的行）────────────────
console.log('checkupLedgerRowCount');
{
  const TSV = [
    '# tracker#\tdate\tcompany-slug\tcompany\tstar\trisks\thtml\tnote',
    '12\t2026-09-14\tacme\tAcme\t2.5\ttactics\treports/checkups/12-acme-2026-09-14.html\t主体混淆',
    '# 一条注释行',
    '?\t2026-09-15\tghost\t幽灵公司\t1.5\t-\t-\t参保 0 人',
    '',
    'truncated\t2026-09-16',
    '917\t2026-09-14\thenan-lanhui\t河南蓝辉\t1.5\ttactics\treports/checkups/917.html\t同名双主体',
  ].join('\r\n');
  const got = checkupLedgerRowCount(TSV);
  if (got === 3) pass('  表头/注释/空行/截断行跳过，? 空键行计入（CRLF 容忍）');
  else fail(`  行计数不符: got ${got}, want 3`);
  if (checkupLedgerRowCount('') === 0) pass('  空文件 → 0');
  else fail('  空文件应为 0 行');
  if (checkupLedgerRowCount(undefined) === 0) pass('  缺文件（undefined）→ 0');
  else fail('  undefined 应为 0 行');
}

// ── 7. 可核验产物行计数（ADR-0030 跟进决议，2026-09-17 #1022）──────────────
// 「行在、它声明的 HTML 不在」不许算落盘：否则 10 次 0–6s 取消的 run 也能记 done。
console.log('checkupArtifactRowCount');
{
  const TSV = [
    '# tracker#\tdate\tcompany-slug\tcompany\tstar\trisks\thtml\tnote',
    '12\t2026-09-14\tacme\tAcme\t2.5\ttactics\treports/checkups/have.html\tn1',
    '999\t2026-09-17\tghost\tGhost\t1.5\t-\treports/checkups/gone.html\tn2',
    '?\t2026-09-15\tnokey\tNoKey\t3.0\t-\t-\tn3',
    '1022\t2026-09-17\tyijin\t易金易购\t2.5\t-\treports/checkups/missing.html\tn4',
  ].join('\r\n');
  const probe = (rel) => rel === 'reports/checkups/have.html';
  const raw = checkupLedgerRowCount(TSV);
  if (raw === 4) pass('  对照：原始行计数仍是 4（ADR-0030 决议 1 的语义未变）');
  else fail(`  原始行计数漂移: ${raw}`);
  const artifact = checkupArtifactRowCount(TSV, probe);
  if (artifact === 2) pass('  可核验产物 = 2（have.html + 无附件的 `?` 行；两条缺 HTML 不计入）');
  else fail(`  可核验产物计数不符: got ${artifact}, want 2`);
  if (checkupArtifactRowCount(TSV) === 1) pass('  探针缺失 → 声明了 HTML 的行一律不计（防线不放宽）');
  else fail('  探针缺失时不应把缺 HTML 的行计入');
  if (checkupArtifactRowCount(undefined, probe) === 0) pass('  台账读不到（undefined）→ 0');
  else fail('  undefined 台账应为 0');
  if (checkupArtifactRowCount(TSV, probe) <= raw) pass('  可核验计数恒 ≤ 原始行计数');
  else fail('  可核验计数竟超过原始行计数');
}

// ── 8. HTML 存在性探针（真实文件系统，临时根）──────────────────────────────
console.log('makeCheckupHtmlProbe');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-ops-probe-'));
  try {
    const dir = path.join(root, 'reports', 'checkups');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ok.html'), '<html></html>');
    fs.mkdirSync(path.join(dir, 'dir.html'));
    fs.writeFileSync(path.join(root, 'secret.txt'), 'x');
    const probe = makeCheckupHtmlProbe(root);
    if (probe('reports/checkups/ok.html') === true) pass('  存在的文件 → true');
    else fail('  存在的文件未被识别');
    if (probe('reports/checkups/missing.html') === false) pass('  不存在的文件 → false（#1022 的判据）');
    else fail('  不存在的文件被当作存在');
    if (probe('reports/checkups/dir.html') === false) pass('  同名目录不算报告（必须是文件）');
    else fail('  目录被当作报告');
    if (probe('output/x.html') === false) pass('  reports/checkups/ 之外 → false');
    else fail('  越界前缀被放行');
    if (probe('reports/checkups/../../secret.txt') === false) pass('  `..` 逃逸 → false（根内的文件也不放行）');
    else fail('  路径逃逸被放行');
    if (probe(undefined) === false) pass('  非字符串 → false');
    else fail('  非字符串输入被放行');
  } finally {
    // 临时目录很小；若本机 safe-delete shim 拦下批量删除，残留无害，不影响断言
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── 9. 当天已有可核验产物（approach B：同重复体检不得误报失败）─────────────
// 2026-09-23 实测：#1072 已被 codebuddy 当日体检成功写入台账 + HTML，之后 qoder
// （Flash/Max）重复点体检时，worker 发现当天产物已在 → 不重复落盘（正确行为），
// 但全局增量门禁把它误判成「零产物失败」。门禁需要一个「本 tracker# 当天已有
// 可核验产物」的正向判据。`checkupArtifactTodayForTracker` 就是这个纯判据。
console.log('checkupArtifactTodayForTracker');
{
  const TSV = [
    '# tracker#\tdate\tcompany-slug\tcompany\tstar\trisks\thtml\tnote',
    '1072\t2026-09-21\tbeilu\t\u5317\u8def\u667a\u63a7\t2.5\ttactics\treports/checkups/old.html\t\u65e7',
    '1072\t2026-09-23\tbeilu\t\u5317\u8def\u667a\u63a7\t2.0\treview-negative\treports/checkups/today.html\t\u4eca\u5929',
    '999\t2026-09-23\tghost\tGhost\t3.0\t-\t-\t\u522b\u884c\u4eca\u5929',
  ].join('\r\n');
  const probe = (rel) => rel === 'reports/checkups/today.html';
  const got = checkupArtifactTodayForTracker(TSV, '1072', '2026-09-23', probe);
  if (got === 2.0) pass('  \u547d\u4e2d\u672c tracker# \u5f53\u5929\u53ef\u6838\u9a8c\u884c \u2192 \u8fd4\u56de\u661f\u7ea7');
  else fail(`  \u5f53\u5929\u661f\u7ea7\u4e0d\u7b26: got ${JSON.stringify(got)}, want 2`);
  if (checkupArtifactTodayForTracker(TSV, '1072', '2026-09-21', probe) === null) pass('  \u975e\u5f53\u5929\u65e5\u671f\uff08HTML \u4e0d\u5728\uff09\u2192 null');
  else fail('  \u5386\u53f2\u65e5\u671f\u88ab\u5f53\u4f5c\u5f53\u5929\u5df2\u6709');
  if (checkupArtifactTodayForTracker(TSV, '999', '2026-09-23', probe) === 3.0) pass('  \u5176\u4ed6 tracker \u7684\u5f53\u5929\u65e0\u9644\u4ef6\u884c\u53ef\u6838\u9a8c \u2192 \u661f\u7ea7');
  else fail('  \u65e0\u9644\u4ef6\u884c\u672a\u88ab\u7b97\u4f5c\u53ef\u6838\u9a8c\u4ea7\u7269');
  if (checkupArtifactTodayForTracker(TSV, '1072', '2026-09-23') === null) pass('  \u63a2\u9488\u7f3a\u5931 \u2192 \u58f0\u660e\u4e86 HTML \u7684\u884c\u4e0d\u53ef\u6838\u9a8c \u2192 null\uff08\u4e0d\u653e\u5bbd\uff09');
  else fail('  \u63a2\u9488\u7f3a\u5931\u65f6\u4e0d\u5e94\u628a\u58f0\u660e HTML \u7684\u884c\u7b97\u4f5c\u5df2\u6709');
  if (checkupArtifactTodayForTracker(undefined, '1072', '2026-09-23', probe) === null) pass('  \u53f0\u8d26\u8bfb\u4e0d\u5230 \u2192 null');
  else fail('  undefined \u53f0\u8d26\u5e94\u4e3a null');
  if (checkupArtifactTodayForTracker(TSV, '?', '2026-09-23', probe) === null) pass('  \u975e\u6570\u5b57 tracker \u952e \u2192 null');
  else fail('  \u975e\u6570\u5b57\u952e\u5e94\u8fd4\u56de null');
  if (checkupArtifactTodayForTracker(TSV, '1072', 'bad-date', probe) === null) pass('  \u975e\u6cd5\u65e5\u671f \u2192 null');
  else fail('  \u975e\u6cd5\u65e5\u671f\u5e94\u8fd4\u56de null');
}

// ── 10. persistRunOutcome 将「当日已有产物」辨为已完成（非 error）─────────
console.log('persistRunOutcome already-current');
{
  const ac = persistRunOutcome({ kind: 'checkup', cleanExit: true, sawError: false, emittedText: true, persisted: false, checkupAlreadyCurrentStar: 2.0 });
  if (ac.ok && ac.alreadyCurrent === true && /\u26052/.test(ac.message)) pass('  \u65e0\u65b0\u884c\u4f46\u5f53\u5929\u5df2\u6709\u53ef\u6838\u9a8c\u62a5\u544a \u2192 ok + alreadyCurrent + \u661f\u7ea7\uff08\u4e0d\u518d\u662f\u964c\u751f\u7684\u300c\u96f6\u4ea7\u7269\u300d\uff09');
  else fail(`  already-current \u672a\u751f\u6548: ${JSON.stringify(ac)}`);
  const none = persistRunOutcome({ kind: 'checkup', cleanExit: true, sawError: false, emittedText: true, persisted: false, checkupAlreadyCurrentStar: null });
  if (!none.ok && /company-checkups\.tsv/.test(none.message)) pass('  \u65e0\u65b0\u884c\u4e14\u65e0\u5f53\u5929\u62a5\u544a \u2192 \u4ecd\u7136 error\uff08\u4e0d\u653e\u677e\uff0cADR-0030 \u8bed\u4e49\u4e0d\u53d8\uff09');
  else fail(`  \u65e0\u5f53\u5929\u62a5\u544a\u65f6\u4e0d\u5e94\u653e\u884c: ${JSON.stringify(none)}`);
  const crashed = persistRunOutcome({ kind: 'checkup', cleanExit: true, sawError: true, emittedText: true, persisted: false, checkupAlreadyCurrentStar: 3.0 });
  if (!crashed.ok) pass('  sawError \u4f18\u5148\uff1a\u5373\u4f7f\u5f53\u5929\u5df2\u6709\u62a5\u544a\uff0c\u5d29\u6e83\u7684 run \u4e0d\u8bb0 done');
  else fail(`  \u5d29\u6e83\u88ab already-current \u6d88\u9ed8: ${JSON.stringify(crashed)}`);
  const unclean = persistRunOutcome({ kind: 'checkup', cleanExit: false, sawError: false, emittedText: true, persisted: false, checkupAlreadyCurrentStar: 3.0 });
  if (!unclean.ok) pass('  \u975e\u6b63\u5e38\u9000\u51fa\u4e0d\u5f97\u88ab already-current \u6d88\u9ed8');
  else fail(`  \u975e\u6b63\u5e38\u9000\u51fa\u88ab\u653e\u884c: ${JSON.stringify(unclean)}`);
  const ev = persistRunOutcome({ kind: 'evaluate', cleanExit: true, sawError: false, emittedText: true, persisted: false, checkupAlreadyCurrentStar: 2.0 });
  if (!ev.ok && /didn't save a report/.test(ev.message)) pass('  evaluate \u4e0d\u53d7 already-current \u5f71\u54cd');
  else fail(`  evaluate \u88ab\u65b0\u53c2\u6570\u6c61\u67d3: ${JSON.stringify(ev)}`);
}
