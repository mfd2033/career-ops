import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/components/home/decision-card.tsx"),
  "utf8",
);
const homeDict = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/lib/i18n/clusters/home.ts"),
  "utf8",
);

test("Today primary action opens the report, not Mark applied", () => {
  const primary = src.indexOf('href={`/pipeline/${app.n}`}');
  const mark = src.indexOf('setStatus("Applied")');
  assert.notEqual(primary, -1);
  assert.notEqual(mark, -1);
  assert.ok(primary < mark, "report link must come before the Applied writer");
  // Copy lives in the i18n dictionary now: the card wires the key and the
  // English source still reads "Review".
  assert.match(src, /t\("home\.review"\)/);
  assert.match(homeDict, /"home\.review": "Review"/);
});
