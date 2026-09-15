// Tests for the 「体检这家」request contract (ADR-0026 决议 5/7):
// the request text is self-contained (draining agent executes without asking
// again); dedup is same tracker# + same day + still pending; resolved (`[x]`)
// lines and other days never block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkupRequestText, hasPendingCheckupRequest } from "../../src/lib/checkup-request.mjs";

test("request text carries full context (no follow-up questions needed)", () => {
  const text = checkupRequestText({ n: "917", company: "河南蓝辉人力资源管理有限公司", date: "2026-09-14" });
  assert.match(text, /公司体检 #917/);
  assert.match(text, /河南蓝辉人力资源管理有限公司/);
  assert.match(text, /modes\/_custom\.md/);
  assert.match(text, /无需再次确认/);
});

const INBOX = `# Agent Inbox
> protocol header
- [x] 2026-09-13 10:00 — evaluate https://acme.com/jobs/1 → result: scored 4.0
- [ ] 2026-09-14 09:00 — 公司体检 #917 河南蓝辉人力资源管理有限公司（checkup request, ADR-0025/0026）— ...
- [ ] 2026-09-14 09:30 — evaluate https://acme.com/jobs/2
- [ ] 2026-09-13 08:00 — 公司体检 #917 河南蓝辉人力资源管理有限公司（checkup request, ADR-0025/0026）— ...
- [x] 2026-09-14 08:00 — 公司体检 #918 Acme（checkup request, ADR-0025/0026）→ result: ★2.5`;

test("dedup: same tracker# + same day + pending → blocks", () => {
  assert.equal(hasPendingCheckupRequest(INBOX, "917", "2026-09-14"), true);
});

test("dedup: resolved (`[x]`) same-day request never blocks", () => {
  assert.equal(hasPendingCheckupRequest(INBOX, "918", "2026-09-14"), false);
});

test("dedup: pending request from an earlier day never blocks (跨天可复检)", () => {
  assert.equal(hasPendingCheckupRequest(INBOX, "918", "2026-09-13"), false);
  assert.equal(hasPendingCheckupRequest(INBOX, "917", "2026-09-15"), false);
});

test("dedup: other rows' pending requests don't block this row", () => {
  assert.equal(hasPendingCheckupRequest(INBOX, "919", "2026-09-14"), false);
});

test("dedup: prefix collision — #91 must not match #917", () => {
  assert.equal(hasPendingCheckupRequest(INBOX, "91", "2026-09-14"), false);
});

test("dedup: empty/missing inbox → never blocks", () => {
  assert.equal(hasPendingCheckupRequest(null, "917", "2026-09-14"), false);
  assert.equal(hasPendingCheckupRequest("", "917", "2026-09-14"), false);
});
