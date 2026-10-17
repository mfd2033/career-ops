# Company Blacklist

Your own do-not-apply list (user layer, opt-in). Copy this file to `data/blacklist.md` and edit it — the system never creates or populates it for you, and no update ever touches it.

When `data/blacklist.md` exists:

- `scan.mjs` skips postings from listed companies (matched case- and punctuation-insensitively) and reports the count in the run summary — `--include-blacklisted` bypasses the filter for auditing. The scan always treats every row as a hard gate; it never honors the `Exempt until` column.
- The `auto-pipeline`, `oferta`, and `apply` modes stop on a match, quote your recorded reason, and ask for an explicit override before proceeding. Your call always wins. These three modes DO honor `Exempt until`: a current-or-future date temporarily lifts the gate for that company until the date passes, then it re-arms automatically.
- A blacklist entry never changes any score anywhere — it is a gate, not a signal. An exemption is a window, not a re-score.

| Company | Since | Scope | Exempt until | Reason |
|---------|-------|-------|--------------|--------|
| Acme Corp | 2026-01-15 | company |  | example: post-interview process signals |
| Globex | 2026-02-01 | company | 2026-03-01 | example: re-evaluating this month, gate lifted until the date |
