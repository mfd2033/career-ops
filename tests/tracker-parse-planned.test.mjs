import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';

const MD = `| # | Date | Company | Via | Role | Score | Status | Planned | PDF | Report | Notes | URL |
|---|------|---------|-----|------|-------|--------|--------|-----|--------|-------|---|
| 1 | 2026-10-21 | Acme | — | PM | 3.0/5 | Evaluated | 2026-10-22 | ❌ | — | note | https://x |
| 2 | 2026-10-21 | Beta | — | PM | 3.0/5 | Applied | 2026-10-23 | ❌ | — | note | https://y |
`;

test('parseTrackerRow 读取 Planned 列（共享别名表驱动）', () => {
  const colmap = resolveColumns(MD.split('\n'));
  assert.ok(colmap.planned != null, 'header 应映射到 planned 列');
  const rows = MD.split('\n').map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].planned, '2026-10-22');
  assert.equal(rows[1].planned, '2026-10-23');
});

test('无 Planned 列时不返回 planned 字段（向后兼容）', () => {
  const md2 = `| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|---|
| 3 | 2026-10-21 | Gamma | PM | 3.0/5 | Evaluated | ❌ | — | n | https://z |
`;
  const colmap = resolveColumns(md2.split('\n'));
  assert.equal(colmap.planned, undefined);
  const r = parseTrackerRow(md2.split('\n')[2], colmap);
  assert.equal(r.planned, undefined);
});
