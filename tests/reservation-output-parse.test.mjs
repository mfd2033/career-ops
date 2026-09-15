// Regression: batch-evaluate's reservation parser hard-coded THREE-digit
// report numbers (`^(\d{3})(?:-(\d{3}))?$` in web/src/app/api/batch-evaluate/
// route.ts). Once reports crossed #999 the allocator legitimately returns e.g.
// `1838-1851`, the parse threw "unexpected reservation output: 1838-1851", and
// EVERY batch run died at the reserve step — 40 worker cards red per click,
// with the sentinels the allocator had already written leaked behind it
// (854 stale NNN-RESERVED.md files found 2026-09-15).
//
// The parser now lives in web/src/lib/run-cli-support.mjs so it can be tested
// from here — the same move the stderr classifier needed (a regex inside a .ts
// closure had no reachable test, which is how its drift went unnoticed).

import { strict as assert } from 'assert';
import { parseReservationOutput } from '../web/src/lib/run-cli-support.mjs';
import { pass, fail } from './helpers.mjs';

const cases = [
  // The exact output that killed every batch on 2026-09-15.
  { name: '4-digit range (the 2026-09-15 outage)', in: '1838-1851', out: range(1838, 1851) },
  { name: '4-digit single', in: '1852', out: [1852] },
  // Legacy shapes that must keep working.
  { name: '3-digit padded single', in: '007', out: [7] },
  { name: '3-digit padded range', in: '042-049', out: range(42, 49) },
  // Garbage must stay garbage (null → route throws its honest message).
  { name: 'allocator error text is rejected', in: 'reserve-report-num: boom', out: null },
  { name: 'empty output is rejected', in: '', out: null },
  { name: '2-digit output is rejected', in: '12', out: null },
  { name: 'non-numeric is rejected', in: 'abc-def', out: null },
  // Tolerance the caller used to get for free from stdout.trim().
  { name: 'trailing newline tolerated', in: '1852-1853\n', out: range(1852, 1853) },
];

function range(a, b) {
  return Array.from({ length: b - a + 1 }, (_, k) => a + k);
}

for (const c of cases) {
  let got;
  try {
    got = parseReservationOutput(c.in);
  } catch (err) {
    fail(`${c.name}: threw ${err.message.split('\n')[0]}`);
    continue;
  }
  try {
    assert.deepEqual(got, c.out);
    pass(`${c.name} → ${got === null ? 'null' : `${got[0]}..${got[got.length - 1]} (${got.length})`}`);
  } catch {
    fail(`${c.name}: expected ${JSON.stringify(c.out)}, got ${JSON.stringify(got)}`);
  }
}
