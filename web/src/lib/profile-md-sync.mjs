/**
 * profile-md-sync.mjs — keep the deal-breakers that live in `modes/_profile.md`
 * ("## Your Deal-Breakers") in sync with the JD-rule form's save target
 * `config/profile.yml` (`narrative.deal_breakers`).
 *
 * The evaluation pipeline reads BOTH files (SKILL.md loads `_profile.md` for
 * every mode; `lib/context-budget.mjs` injects `_profile.md` and `profile.yml`
 * side by side; `run-prompts.mjs` tells the agent to read `modes/_profile.md`).
 * A rule typed into the web form is therefore only visible to the agent if it
 * reaches `_profile.md` too — hence this mirror. Pure + filesystem-free so the
 * web test suite can exercise it under Node with no TS runner (same pattern as
 * profile-patch.mjs).
 */

/**
 * Extract the bullet lines of the "## Your Deal-Breakers" section from a
 * `modes/_profile.md` file as a plain string list (un-prefixed, trimmed).
 * Returns [] when the section is absent or empty. Used by the GET handler so
 * the form prefills from BOTH files — a hand-written rule in `_profile.md`
 * must never be silently dropped by a later web save.
 *
 * @param {string} markdown - raw `modes/_profile.md` content
 * @returns {string[]}
 */
export function extractDealBreakers(markdown) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Your\s+Deal-Breakers\s*$/.test(l.trim()));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line.trim())) break; // next section heading
    const m = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (m) {
      const item = m[1].trim();
      if (item) out.push(item);
    }
  }
  return out;
}

/**
 * Rewrite ONLY the "## Your Deal-Breakers" section of a `modes/_profile.md`
 * document so its bullet list mirrors the given deal-breakers (order preserved,
 * no dedup here — the POST path already normalizes via profile-patch.mjs).
 * Everything outside that section is preserved byte-for-byte, including blank
 * line placement, so a sync can never clobber the rest of the user's profile.
 *
 * @param {string} markdown - raw `modes/_profile.md` content
 * @param {string[]} dealBreakers - the rules to write into the section
 * @returns {{ markdown: string; found: boolean }} `found:false` when the
 *   section heading is absent — the caller then skips the write rather than
 *   fabricating a section into a file the user hasn't shaped yet.
 */
export function replaceDealBreakersSection(markdown, dealBreakers) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Your\s+Deal-Breakers\s*$/.test(l.trim()));
  if (start === -1) return { markdown: String(markdown ?? ""), found: false };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }

  const items = (Array.isArray(dealBreakers) ? dealBreakers : [])
    .map((b) => String(b).trim())
    .filter(Boolean);

  const block = [`## Your Deal-Breakers`];
  if (items.length) {
    // heading + blank + bullets + trailing blank (keeps the original
    // blank-line separation before the next section heading).
    block.push("", ...items.map((b) => `- ${b}`), "");
  } else {
    block.push("");
  }

  const next = [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  return { markdown: next, found: true };
}
