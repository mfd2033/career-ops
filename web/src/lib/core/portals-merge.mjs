// portals-merge.mjs — text-level upsert of one nested list block in portals.yml.
//
// Why not js-yaml: `yaml.load` → `yaml.dump` is a round-trip, and a round-trip
// deletes every comment in the file. portals.yml is where this user's targeting
// decisions are written down — 「刻意不用裸「项目经理/PM」——否则「工程项目经理」(土建)
// 会一并进来」, 「原为裸"产品"，误中酒类产品经理（啤酒）；改为软件产品」. Those lines
// are the *rationale* for the word list, so losing them means the next edit is made
// blind, and nothing on screen says it happened. The other half is the write
// itself: replacing `positive` wholesale dropped the user's own hand-written words
// every time the config page (or the assistant's setPortals) saved target roles.
//
// So: locate the block, splice it, leave every other byte alone. Two rules that
// are easy to get wrong and are pinned by tests:
//   • blanks/comments *after* the last item belong to the next block (「# -- 黑名单 --」
//     introduces `negative`), so an append steps back over them;
//   • a replace removes exactly the old items — not the blank line and comment that
//     separate two sections.
//
// Dependency-free on purpose (like portals-serialize.mjs): it takes text and
// returns text, so `node --test` can exercise it without a Next runtime.

/** Nested mapping key to look for: ["title_filter", "positive"]. */
const MAX_DEPTH = 2;
const KEY_LINE = /^(\s*)([^\s#][^:]*?):(\s.*|)$/;
const SEQ_ITEM = /^(\s*)-\s*(.*)$/;

const stripQuotes = (k) => String(k ?? "").trim().replace(/^["']|["']$/g, "");

/** Caps for a word list that arrives from the UI. A title_filter is read on every
 *  scan and matched against every card, so an unbounded list is a scan-slowing
 *  typo, not a feature; 120 chars is well past the longest real keyword. */
export const WORD_LIST_MAX = 200;
export const WORD_LIST_MAX_LEN = 120;

/**
 * Validate + normalize a word list sent by the rules card.
 *
 * Returns null — never [] — for anything malformed. The distinction is the whole
 * point: `[]` is a legitimate instruction ("this side is empty", the state the
 * gate reads as "no constraint"), so treating a missing or wrong-typed field as
 * [] would delete a list the user spent time on because a request was malformed.
 * Same reason the route rejects rather than guesses.
 *
 * Non-string entries inside an otherwise valid list are skipped rather than
 * failing the request: the UI can only send strings, and a blank row in a paste
 * should not cost the whole save.
 *
 * @param {unknown} v
 * @returns {string[]|null} trimmed, de-duplicated (case-folded), order preserved
 */
export function normalizeWordList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  const seen = new Set();
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const w = raw.trim();
    if (!w) continue;
    if (w.length > WORD_LIST_MAX_LEN) return null;
    const key = wordKey(w);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out.length > WORD_LIST_MAX ? null : out;
}
/** Comparison key for "is this word already in the list" — case + edge space only. */
const wordKey = (w) => String(w ?? "").trim().toLowerCase();

/**
 * One `- <scalar>` line → the scalar, with its trailing comment removed.
 * Handles double-quoted (comment after the closing quote), single-quoted and bare
 * scalars — the three shapes that actually appear in a hand-maintained portals.yml.
 */
function readScalar(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (s.startsWith('"')) {
    let i = 1;
    while (i < s.length) {
      if (s[i] === "\\") {
        i += 2;
        continue;
      }
      if (s[i] === '"') break;
      i += 1;
    }
    return s.slice(1, i).replace(/\\(["\\])/g, "$1");
  }
  if (s.startsWith("'")) {
    const end = s.indexOf("'", 1);
    return (end > 0 ? s.slice(1, end) : s.slice(1)).replace(/''/g, "'");
  }
  // Bare scalar: a comment needs whitespace before it.
  const cut = s.match(/^(.*?)\s+#/);
  return (cut ? cut[1] : s).trim();
}

/** `[a, "b"]` → ["a", "b"] — the inline style, which has no item lines to append after. */
function parseFlowSeq(s) {
  const inner = s.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  const out = [];
  let buf = "";
  let quote = "";
  for (const ch of inner) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map(readScalar).filter(Boolean);
}

/** Line index of the `path` mapping key, via an indent-stack walk. -1 when absent. */
function findKey(lines, path) {
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (SEQ_ITEM.test(line)) continue; // a sequence item is not a mapping key
    const m = line.match(KEY_LINE);
    if (!m) continue;
    const indent = m[1].length;
    const key = stripQuotes(m[2]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ key, indent });
    if (stack.length === path.length && stack.every((s, k) => s.key === path[k])) return { line: i, indent };
  }
  return null;
}

/** Where the block's own content ends (trailing blanks/comments excluded). */
function contentEndOf(lines, keyLine, indent) {
  let end = lines.length;
  for (let j = keyLine + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (l.match(/^\s*/)[0].length <= indent) {
      end = j;
      break;
    }
  }
  let contentEnd = end;
  while (contentEnd > keyLine + 1 && (!lines[contentEnd - 1].trim() || /^\s*#/.test(lines[contentEnd - 1]))) contentEnd -= 1;
  return contentEnd;
}

/** Reuse the indentation the file already uses for this block's items. */
function itemIndentOf(lines, from, to, fallback) {
  for (let j = from; j < to; j++) {
    const m = lines[j].match(SEQ_ITEM);
    if (m) return m[1].length;
  }
  return fallback;
}

/**
 * Ensure `words` are present in the nested list block at `path`, editing `text` in
 * place (byte-for-byte outside that block).
 *
 * @param {string} text raw YAML — a real portals.yml, not a round-tripped object
 * @param {string[]} path mapping keys, max depth 2, e.g. ["title_filter","positive"]
 * @param {string[]} words words to write (trimmed, blanks dropped)
 * @param {{mode?: "append"|"replace"}} [opts] append = keep what's there and add the
 *   missing (the user layer: their hand-written words are decisions, not defaults);
 *   replace = the block becomes exactly `words` (the seeding layer, where the words
 *   being replaced are placeholders we wrote ourselves)
 * @returns {{text: string, added: string[], skipped: string[], changed: boolean, created: boolean, mode: "append"|"replace"}}
 */
export function upsertYamlList(text, path, words, opts = {}) {
  const original = String(text ?? "");
  const mode = opts.mode === "replace" ? "replace" : "append";
  const keys = (Array.isArray(path) ? path : []).map(stripQuotes).filter(Boolean);
  const wanted = (Array.isArray(words) ? words : []).map((w) => String(w ?? "").trim()).filter(Boolean);
  if (keys.length === 0 || keys.length > MAX_DEPTH) throw new Error(`unsupported path: ${JSON.stringify(path)}`);

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const key = keys[keys.length - 1];
  const hit = findKey(lines, keys);

  // ── the key is absent: create it (under an existing parent, else at EOF) ──
  if (!hit) {
    if (!wanted.length) return { text: original, added: [], skipped: [], changed: false, created: false, mode };
    const block = keys.length === 2 ? [`${keys[0]}:`, `  ${key}:`, ...wanted.map((w) => `    - ${JSON.stringify(w)}`)] : [key, ...wanted.map((w) => `  - ${JSON.stringify(w)}`)];
    const parent = keys.length === 2 ? findKey(lines, [keys[0]]) : null;
    if (parent) {
      // The parent mapping is already in the file — nesting the child under it keeps
      // one `title_filter:` per document. Appending a second one would be a
      // duplicate top-level key.
      const childIndent = `${" ".repeat(parent.indent + 2)}`;
      const itemIndent = `${" ".repeat(parent.indent + 4)}`;
      lines.splice(parent.line + 1, 0, `${childIndent}${key}:`, ...wanted.map((w) => `${itemIndent}- ${JSON.stringify(w)}`));
    } else {
      const tail = [...lines];
      while (tail.length && !tail[tail.length - 1].trim()) tail.pop();
      // Column 0 always closes whatever block the file ends with, so the new
      // section is a sibling and never gets swallowed by the last sequence.
      lines.length = 0;
      lines.push(...tail, ...(tail.length ? [""] : []), ...block, "");
    }
    const created = lines.join(eol);
    return { text: created, added: wanted, skipped: [], changed: created !== original, created: true, mode };
  }

  // ── the key is present ──
  const keyLine = hit.line;
  const keyIndent = hit.indent;
  const contentEnd = contentEndOf(lines, keyLine, keyIndent);
  const rest = (lines[keyLine].match(KEY_LINE)?.[3] ?? "").trim();
  const inline = rest.startsWith("[") ? parseFlowSeq(rest) : null;
  const existing = inline ?? [];
  if (!inline) {
    for (let j = keyLine + 1; j < contentEnd; j++) {
      const m = lines[j].match(SEQ_ITEM);
      if (m) existing.push(readScalar(m[2]));
    }
  }
  const itemIndent = inline ? keyIndent + 2 : itemIndentOf(lines, keyLine + 1, contentEnd, keyIndent + 2);

  let added;
  let skipped;
  if (mode === "append") {
    const have = new Set(existing.map(wordKey));
    added = [];
    skipped = [];
    for (const w of wanted) {
      if (have.has(wordKey(w))) skipped.push(w);
      else {
        have.add(wordKey(w));
        added.push(w);
      }
    }
    if (!added.length) return { text: original, added, skipped, changed: false, created: false, mode };
  } else {
    added = wanted;
    skipped = [];
  }

  if (inline) {
    // An inline list has no item lines to append after, so the block becomes a
    // block-sequence holding both the words that were already there and the new ones.
    const all = mode === "append" ? [...existing, ...added] : added;
    lines.splice(keyLine, 1, `${" ".repeat(keyIndent)}${key}:`, ...all.map((w) => `${" ".repeat(itemIndent)}- ${JSON.stringify(w)}`));
  } else if (mode === "append") {
    // After the block's last item — appending right under the key would bury the
    // user's own words under the new ones and read as if the file had been reordered.
    lines.splice(contentEnd, 0, ...added.map((w) => `${" ".repeat(itemIndent)}- ${JSON.stringify(w)}`));
  } else {
    lines.splice(keyLine + 1, contentEnd - (keyLine + 1), ...added.map((w) => `${" ".repeat(itemIndent)}- ${JSON.stringify(w)}`));
  }

  const out = lines.join(eol);
  return { text: out, added, skipped, changed: out !== original, created: false, mode };
}
