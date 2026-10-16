// ADR-0079 冻结判定：followup-cadence.mjs 每行输出的 silenceDays / readState /
// freezeSuggested。「已读不回」建议冻结的规则与 [unread] token 解析都必须在
// 引擎单点完成（web 只消费不复算），所以判定矩阵在这里钉死。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { analyzeFromContent, parseFollowups, stripUnreadToken, DEFAULT_CADENCE, loadProfileCadence } =
  await import(pathToFileURL(join(ROOT, 'followup-cadence.mjs')).href);
const { localToday } = await import(pathToFileURL(join(ROOT, 'lib/local-today.mjs')).href);

// 相对今天构造 ISO 日期，测试不随时间漂移
function daysAgo(n) {
  const d = new Date(localToday());
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function trackerRow(num, status, appliedDaysAgo) {
  const date = daysAgo(appliedDaysAgo + 5); // Date 列=评估日，notes 里才是申请日
  return (
    `| ${num} | ${date} | Acme ${num} | Engineer | 4.0/5 | ${status} | ❌ | ` +
    `[${num}](reports/00${num}-acme.md) | Applied ${daysAgo(appliedDaysAgo)} |`
  );
}

function tracker(...rows) {
  return (
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
    '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
    rows.join('\n') + '\n'
  );
}

function fuRow(fuNum, appNum, daysAgoCount, unread = false) {
  const line =
    `| ${fuNum} | ${appNum} | ${daysAgo(daysAgoCount)} | Acme ${appNum} | Engineer | LinkedIn | jane | 跟进 |`;
  return unread ? line + ' [unread]' : line;
}

function followups(...rows) {
  return (
    '| # | App | Date | Company | Role | Channel | Contact | Notes |\n' +
    '|---|-----|------|---------|------|---------|---------|-------|\n' +
    rows.join('\n') + '\n'
  );
}

function entryFor(cadence, num) {
  return (cadence.entries || []).find(e => e.num === num) || null;
}

test('DEFAULT_CADENCE 携带 freeze_threshold_days=14', () => {
  assert.equal(DEFAULT_CADENCE.freeze_threshold_days, 14);
});

test('profile 的 freeze_threshold_days 可覆盖默认值', () => {
  const cadence = loadProfileCadence(join(ROOT, 'tests/fixtures/profile-freeze-threshold.yml'));
  assert.equal(cadence.freeze_threshold_days, 7);
});

test('applied 达阈值（无跟进记录，按申请日起算）→ 建议冻结', () => {
  const c = analyzeFromContent(tracker(trackerRow(1, 'Applied', 20)), '');
  const e = entryFor(c, 1);
  assert.equal(e.silenceDays, 20);
  assert.equal(e.readState, null);
  assert.equal(e.freezeSuggested, true);
});

test('applied 未达阈值（最近跟进 5 天前）→ 不建议', () => {
  const c = analyzeFromContent(
    tracker(trackerRow(1, 'Applied', 20)),
    followups(fuRow(1, 1, 5)),
  );
  const e = entryFor(c, 1);
  assert.equal(e.silenceDays, 5);
  assert.equal(e.readState, 'read');
  assert.equal(e.freezeSuggested, false);
});

test('applied 最近跟进 20 天前且已读（默认）→ 建议冻结', () => {
  const c = analyzeFromContent(
    tracker(trackerRow(1, 'Applied', 40)),
    followups(fuRow(1, 1, 20)),
  );
  const e = entryFor(c, 1);
  assert.equal(e.silenceDays, 20);
  assert.equal(e.readState, 'read');
  assert.equal(e.freezeSuggested, true);
});

test('最近一次跟进带 [unread] → readState=unread，永不建议冻结', () => {
  const c = analyzeFromContent(
    tracker(trackerRow(1, 'Applied', 40)),
    followups(fuRow(1, 1, 20, true)),
  );
  const e = entryFor(c, 1);
  assert.equal(e.readState, 'unread');
  assert.equal(e.freezeSuggested, false);
});

test('[unread] 只看最近一次：旧跟进带标记、最近跟进不带 → readState=read', () => {
  const c = analyzeFromContent(
    tracker(trackerRow(1, 'Applied', 40)),
    followups(fuRow(1, 1, 30, true), fuRow(2, 1, 20)),
  );
  const e = entryFor(c, 1);
  assert.equal(e.readState, 'read');
  assert.equal(e.freezeSuggested, true);
});

test('responded 不参与冻结（双向互动不是已读不回）', () => {
  const c = analyzeFromContent(tracker(trackerRow(1, 'Responded', 30)), '');
  const e = entryFor(c, 1);
  assert.equal(e.silenceDays, 30);
  assert.equal(e.freezeSuggested, false);
});

test('interview 达阈值且已读 → 建议冻结', () => {
  const c = analyzeFromContent(tracker(trackerRow(1, 'Interview', 20)), '');
  const e = entryFor(c, 1);
  assert.equal(e.freezeSuggested, true);
});

test('[unread] token 从 notes 中剥离，不污染展示字段', () => {
  const entries = parseFollowups(followups(fuRow(1, 1, 5, true)));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].unread, true);
  assert.equal(entries[0].notes.includes('[unread]'), false);
});

test('stripUnreadToken：行尾 token 剥离并置位；无 token 原样返回', () => {
  assert.deepEqual(stripUnreadToken('| a | b | [unread]'), { text: '| a | b |', unread: true });
  assert.deepEqual(stripUnreadToken('| a | b |'), { text: '| a | b |', unread: false });
  // 行中间出现 [unread] 不算行尾标记（避免误剥正文引用）
  assert.deepEqual(stripUnreadToken('note [unread] tail'), { text: 'note [unread] tail', unread: false });
});
