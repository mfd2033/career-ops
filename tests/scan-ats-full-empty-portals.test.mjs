// tests/scan-ats-full-empty-portals.test.mjs — the portals config reader must
// tolerate an EMPTY YAML document (blank, whitespace-only, or comments-only).
//
// js-yaml's load() THROWS on an empty document ("expected a document, but the
// input is empty"), while the state it represents — "no filter config" — is
// legitimate: it is what an all-empty Explorer filter set serializes to, and
// resolveTitleFilterConfig already documents that a missing/empty config must
// not throw. Fatal-ing on it costs the whole sweep: the web reads the result
// from stdout as --json, so an exit before that payload means the page can only
// report "The scanner returned no readable output." (the onboarding hand-off
// ?run=1, before the serializer emitted a mapping, hit exactly this).
//
// A genuinely MALFORMED document must still throw — tolerance for "empty", not
// for "broken".
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';

console.log('\nscan-ats-full — empty portals config');

const mod = await import(pathToFileURL(join(ROOT, 'scan-ats-full.mjs')).href);
const { loadPortalsConfig } = mod;

if (typeof loadPortalsConfig !== 'function') {
  fail('loadPortalsConfig is not exported — the empty-document tolerance is missing');
} else {
  const empties = [
    ['empty string', ''],
    ['whitespace only', '  \n\t\n'],
    ['comments only', '# Ephemeral Explorer filters — generated per-search, safe to delete.\n'],
    ['commented-out keys', '# title_filter:\n#   positive:\n#     - "AI"\n'],
    ['comment with leading indent', '   # indented note\n'],
  ];
  for (const [label, raw] of empties) {
    try {
      const got = loadPortalsConfig(raw);
      if (got === null) pass(`${label} → null (no config), no throw`);
      else fail(`${label} → expected null, got ${JSON.stringify(got)}`);
    } catch (err) {
      fail(`${label} threw: ${err.message}`);
    }
  }

  // A real document still parses — the tolerance must not swallow content.
  {
    const raw = 'title_filter:\n  positive:\n    - "AI"\n';
    const got = loadPortalsConfig(raw);
    if (got?.title_filter?.positive?.[0] === 'AI') pass('a real document still parses');
    else fail(`real document lost its content: ${JSON.stringify(got)}`);
  }

  // Malformed YAML is NOT "empty" — it must keep throwing so main()'s caller
  // sees a real error instead of a silently-unfiltered sweep.
  {
    try {
      loadPortalsConfig('title_filter: [unclosed\n');
      fail('malformed YAML must still throw');
    } catch {
      pass('malformed YAML still throws (tolerance is for empty only)');
    }
  }
}
