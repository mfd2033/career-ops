// effective-city.test.mjs — where the city condition comes from and who resolves it
// (ADR-0029 决议 6). The pure three-state resolution is unit-tested in
// browser-search.test.mjs; this file guards the WIRING, which no unit test reaches:
// both drivers must resolve through the same helper, the preference must be seeded
// into its own field, and the picker must offer both "no specific city" states.
//
// The failure this prevents is silent and total in one direction and silent and
// useless in the other: resolve too eagerly and a preference of 河南 becomes a city
// condition that matches nothing (every posting dropped, no symptom); don't resolve
// at all and "unset" quietly means "national", which is how 882 异地 rows got into
// the inbox in the first place (data/pipeline.md, 2026-09-16).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const flat = (rel) => readFileSync(join(here, "../../src", rel), "utf8").replace(/\s+/g, " ");

test("both drivers resolve the city through the shared helper", () => {
  const server = flat("lib/core/browser-scan.ts");
  assert.match(server, /const city = effectiveBrowserCity\(filters\)/, "the bsk path must resolve, not read zhCity raw");
  assert.ok(
    !/const city = filters\.zhCity/.test(server),
    "reading zhCity raw makes the 未设置 state mean 'national' again — the gate and the preference would disagree",
  );

  const client = flat("components/explore/explore-provider.tsx");
  assert.match(client, /const city = effectiveBrowserCity\(f\)/, "the extension path must resolve the same way");
  assert.ok(!/const city = f\.zhCity/.test(client), "and not read zhCity raw");
});

test("the preference is seeded into its own field, never copied into zhCity", () => {
  const src = flat("lib/core/portals.ts");
  assert.match(src, /filters\.zhCityPreference = candidateCity/, "profile.yml's location.city is the preference's first choice");
  assert.match(src, /filters\.zhCityPreference = allowCity/, "else portals.yml's location_filter.allow");
  assert.ok(
    !/filters\.zhCity = candidateCity|filters\.zhCity = allowCity/.test(src),
    "pre-filling zhCity destroys the distinction between my standing preference and what I picked this hunt — and freezes one city into every link shared before the config changes",
  );
});

test("the URL codec carries zhCityPreference across a restore", () => {
  // paramsToBrowser spreads its base, so the preference rides the server seed — which
  // only holds because explorer-view passes seed.filters as that base.
  const src = flat("components/explore/explorer-view.tsx");
  assert.match(
    src,
    /paramsToBrowser\(sp, seed\.filters\)/,
    "without the seed base a restored hunt has an empty preference AND empty positive/negative — the gates then filter nothing",
  );
});

test("the picker offers both 'no specific city' states plus the known cities", () => {
  const src = flat("components/explore/filter-builder.tsx");
  assert.match(src, /<option value=\{ZH_CITY_ANY\}>/, "the explicit national option");
  assert.match(src, /CITY_NAMES\.map/, "and the known-city list — a free-text city that no board can filter by would become a condition that matches nothing");
  assert.ok(!/<input[^>]*zhCity/.test(src), "the city box is a select, so an unusable value cannot be typed in at all");
  assert.match(src, /t\("explore\.filter\.zhCityPreference", \{ city: filters\.zhCityPreference \}\)/, "the unset option must NAME the city it will fall back to, or the user cannot tell what it does");
});

test("every new city label exists in both locales", () => {
  const src = readFileSync(join(here, "../../src/lib/i18n/clusters/explore.ts"), "utf8");
  for (const key of ["explore.filter.zhCityPreference", "explore.filter.zhCityUnset", "explore.filter.zhCityAny"]) {
    const hits = (src.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) ?? []).length;
    assert.equal(hits, 2, `${key} must exist in both locales (found ${hits})`);
  }
});
