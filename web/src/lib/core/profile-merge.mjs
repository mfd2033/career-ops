// profile-merge.mjs — text-level merge of one patch into config/profile.yml.
//
// Why not js-yaml: `yaml.load` → `yaml.dump` is a round-trip, and a round-trip
// deletes every comment in the file — the same reason portals-merge.mjs exists.
// profile.yml is a USER-LAYER file that carries the *reasoning* behind its
// settings (「# 评估模式（ADR-0087 / CO-65）：市场词汇与评分规则取自该目录的模式集」).
// Losing that means the next edit is made blind, and nothing on screen says it
// happened — the user just watches their notes disappear on Save.
//
// So: splice the leaves the patch actually carries, leave every other byte
// alone. A text-level merge is tractable here (unlike in general) because the
// patch shape is small, closed and known — profile-patch.mjs for the config
// page, `{followup_cadence: {...}}` for the cadence card.
//
// Contract, pinned by profile-merge.test.mjs:
//   • `yaml.load(result)` deep-equals the same patch applied to the loaded
//     document (`deepMerge`, with `null` deleting its key);
//   • every byte outside the touched leaves survives verbatim, comments too;
//   • a scalar's own trailing comment survives its value being replaced;
//   • `null` deletes the key *and* the comment block directly above it, so no
//     orphaned explanation is left pointing at a key that is gone;
//   • a list may carry object items (ADR-0091's `target_roles.archetypes`):
//     they render as block mappings riding the `- `, while a nested object
//     VALUE refuses the whole list (never a half-splice).
//
// Dependency-free on purpose (like portals-merge.mjs / portals-serialize.mjs):
// it takes text and returns text, so `node --test` exercises it without a Next
// runtime.

/** `key: rest` — a mapping key line. Same shape portals-merge.mjs parses. */
const KEY_LINE = /^(\s*)([^\s#][^:]*?):(\s.*|)$/;
const SEQ_ITEM = /^(\s*)-\s+(.*)$/;
const COMMENT = /^\s*#/;

const stripQuotes = (k) => String(k ?? "").trim().replace(/^["']|["']$/g, "");
const indentOf = (line) => line.match(/^\s*/)[0].length;

/**
 * Flatten a nested patch into `{path, value}` leaves, depth-first and in key
 * order. `null` survives as a leaf (it means "delete this key"); arrays are
 * leaves (a list is replaced wholesale, never merged item by item).
 *
 * @param {Record<string, unknown>} node
 * @returns {{path: string[], value: unknown}[]}
 */
export function flattenPatch(node, path = [], out = []) {
  for (const [key, value] of Object.entries(node ?? {})) {
    const next = [...path, key];
    if (value && typeof value === "object" && !Array.isArray(value)) flattenPatch(value, next, out);
    else out.push({ path: next, value });
  }
  return out;
}

/** Line index of the `path` mapping key, via an indent-stack walk. -1 when absent. */
function findKey(lines, path) {
  const stack = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || COMMENT.test(line)) continue;
    if (SEQ_ITEM.test(line)) continue; // a sequence item is not a mapping key
    const m = line.match(KEY_LINE);
    if (!m) continue;
    const indent = m[1].length;
    const key = stripQuotes(m[2]);
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ key, indent });
    if (stack.length === path.length && stack.every((s, k) => s.key === path[k])) return i;
  }
  return -1;
}

/** Where a block's own content ends (trailing blanks/comments excluded). */
function contentEndOf(lines, keyLine, indent) {
  let end = lines.length;
  for (let j = keyLine + 1; j < lines.length; j++) {
    const l = lines[j];
    if (!l.trim() || COMMENT.test(l)) continue;
    if (indentOf(l) <= indent) {
      end = j;
      break;
    }
  }
  let contentEnd = end;
  while (contentEnd > keyLine + 1 && (!lines[contentEnd - 1].trim() || COMMENT.test(lines[contentEnd - 1]))) contentEnd -= 1;
  return contentEnd;
}

/**
 * Should this string be quoted to survive a YAML round-trip unchanged?
 *
 * Deliberately conservative-but-quiet: `25K-30K`, `modes/zh`, `郑州本地优先，可接受远程`
 * and `CNY` all stay bare (quoting them would make a hand-maintained file read
 * like generated output), while anything YAML would re-type — a leading
 * indicator char, a `: ` inside, a ` #` comment start, or the digit-only form
 * that loads as a number — gets quoted.
 */
function needsQuote(s) {
  if (s === "") return true;
  if (/^\s|\s$/.test(s)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/: |\s#|\n|\t/.test(s)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true;
  // Digit-only / numeric-shaped strings: unquoted they load as numbers, and the
  // value would come back changed (`'007'` → 7).
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true;
  return false;
}

/** One scalar → its inline YAML form. Numbers/booleans keep their own type. */
export function renderScalar(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = String(value ?? "");
  return needsQuote(s) ? JSON.stringify(s) : s;
}

/**
 * Ensure the mapping chain `path` exists, creating missing levels under their
 * nearest existing ancestor. Returns the line index + indent of the deepest
 * level (which is an *empty* mapping when it had to be created).
 *
 * Levels are created one at a time and always re-located afterwards: an insert
 * shifts every later line number, so nothing may be cached across a splice.
 */
function ensureMapping(lines, path) {
  if (path.length === 0) return { line: -1, indent: -2 };
  const at = findKey(lines, path);
  if (at !== -1) return { line: at, indent: indentOf(lines[at]) };
  const parent = ensureMapping(lines, path.slice(0, -1));
  const indent = parent.line === -1 ? 0 : parent.indent + 2;
  const insertAt = parent.line === -1 ? lines.length : contentEndOf(lines, parent.line, parent.indent);
  lines.splice(insertAt, 0, `${" ".repeat(indent)}${path[path.length - 1]}:`);
  return { line: insertAt, indent };
}

/**
 * Split a scalar line's value from its trailing comment, so replacing the value
 * keeps the explanation the user wrote next to it.
 *
 * Only whitespace-preceded `#` starts a comment in YAML, so `#` inside a bare
 * scalar (`C#`) is part of the value. A `#` inside a quoted scalar is too —
 * handled by walking the quotes instead of scanning for `#`.
 */
function splitTrailingComment(rest) {
  const s = rest;
  if (!s) return { value: "", comment: "" };
  let i = 0;
  let quote = "";
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 2;
      else {
        if (ch === quote) quote = "";
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return { value: s.slice(0, i).trimEnd(), comment: s.slice(i) };
    }
    i += 1;
  }
  return { value: s.trimEnd(), comment: "" };
}

/** Replace one scalar leaf in place. Returns false when the shape is unsupported. */
function writeScalar(lines, path, value) {
  const key = path[path.length - 1];
  const rendered = renderScalar(value);
  const at = findKey(lines, path);
  if (at === -1) {
    const parent = ensureMapping(lines, path.slice(0, -1));
    const indent = parent.line === -1 ? 0 : parent.indent + 2;
    const insertAt = parent.line === -1 ? lines.length : contentEndOf(lines, parent.line, parent.indent);
    lines.splice(insertAt, 0, `${" ".repeat(indent)}${key}: ${rendered}`);
    return true;
  }
  const m = lines[at].match(KEY_LINE);
  const indent = m[1].length;
  const { value: current, comment } = splitTrailingComment(m[3] ?? "");
  // The key currently heads a nested block (its value is on the following
  // lines). Turning that into a scalar would delete real content, so refuse:
  // the caller's patch shapes never do this, and silence beats data loss.
  if (current === "") {
    const contentEnd = contentEndOf(lines, at, indent);
    if (contentEnd > at + 1) return false;
  }
  const tail = comment ? `  ${comment}` : "";
  lines[at] = `${m[1]}${m[2]}: ${rendered}${tail}`;
  return true;
}

/** Delete one key line plus the comment block directly above it. */
function deleteKey(lines, path) {
  const at = findKey(lines, path);
  if (at === -1) return false;
  const indent = indentOf(lines[at]);
  let start = at;
  while (start > 0 && COMMENT.test(lines[start - 1]) && indentOf(lines[start - 1]) >= indent) start -= 1;
  lines.splice(start, contentEndOf(lines, at, indent) - start);
  return true;
}

/**
 * Render one list item into its YAML lines at the given item indent, or null
 * when the item is outside the contract (a nested object value cannot be
 * rendered losslessly — the caller refuses the whole list rather than
 * half-splice, mirroring writeScalar's scalar-where-block refusal).
 *
 * Scalar items → `- <scalar>`. Object items → a block mapping: first key rides
 * the `- ` (ADR-0091's archetypes shape), later keys align to the first key's
 * column. Keys go through the same quoting rule as values (`needsQuote`) —
 * reconciled entries carry hand-written keys verbatim, and a bare
 * quote-needing key would corrupt the whole file. `null` renders as `null`,
 * not an empty string, so a type survives the round-trip. An empty object
 * renders as flow `- {}`.
 */
function renderItemLines(item, step) {
  if (item === null || typeof item !== "object") return [`${step}- ${renderScalar(item)}`];
  const entries = Object.entries(item);
  if (entries.length === 0) return [`${step}- {}`];
  const cont = " ".repeat(step.length + 2);
  const lines = [];
  for (const [k, v] of entries) {
    if (v !== null && typeof v === "object") return null;
    const rk = needsQuote(k) ? JSON.stringify(k) : k;
    const rv = v === null ? "null" : renderScalar(v);
    lines.push(lines.length === 0 ? `${step}- ${rk}: ${rv}` : `${cont}${rk}: ${rv}`);
  }
  return lines;
}

/**
 * Replace a list block wholesale (the patch always carries the complete list —
 * `target_roles.primary`, `target_roles.archetypes`, `narrative.deal_breakers`).
 * Item-level comments inside the old block are dropped with it: a card that
 * rewrites the whole list has no way to say which item a note belonged to.
 * Every item is rendered BEFORE any splice: an unrenderable item refuses the
 * whole write so no half-replaced block is ever left behind.
 */
function writeList(lines, path, items) {
  const key = path[path.length - 1];
  const at = findKey(lines, path);
  let step, insertAt, removeCount, prefix;

  // ── key absent: create the block under its parent chain ──
  if (at === -1) {
    const parent = ensureMapping(lines, path.slice(0, -1));
    const base = parent.line === -1 ? -2 : parent.indent;
    step = " ".repeat(base + 4);
    insertAt = parent.line === -1 ? lines.length : contentEndOf(lines, parent.line, parent.indent);
    removeCount = 0;
    prefix = [`${" ".repeat(base + 2)}${key}:`];
  } else {
    const m = lines[at].match(KEY_LINE);
    const indent = indentOf(lines[at]);
    const rest = (m[3] ?? "").trim();
    const contentEnd = contentEndOf(lines, at, indent);

    if (rest.startsWith("[")) {
      // Inline flow list → becomes a block sequence (there are no item lines to
      // replace, and the inline form cannot hold item comments anyway).
      step = `${m[1]}  `;
      insertAt = at;
      removeCount = 1;
      prefix = [`${m[1]}${m[2]}:`];
    } else if (rest !== "") {
      // A scalar where a list is expected: the scalar was real content, so keep it
      // out of the blast radius and let the caller report instead of overwriting.
      return false;
    } else {
      // Keep the block's own item indentation when it already has items.
      step = `${m[1]}  `;
      for (let j = at + 1; j < contentEnd; j++) {
        const item = lines[j].match(SEQ_ITEM);
        if (item) {
          step = item[1];
          break;
        }
      }
      insertAt = at + 1;
      removeCount = contentEnd - (at + 1);
      prefix = [];
    }
  }

  const itemLines = [];
  for (const w of items) {
    const rendered = renderItemLines(w, step);
    if (!rendered) return false;
    itemLines.push(...rendered);
  }
  lines.splice(insertAt, removeCount, ...prefix, ...itemLines);
  return true;
}

/**
 * Merge `patch` into `text`, changing only the leaves the patch carries.
 *
 * @param {string} text raw config/profile.yml — never a round-tripped object
 * @param {Record<string, unknown>} patch nested patch, e.g. `{language:{modes_dir:"modes/zh"}}`
 * @returns {{text: string, changed: boolean, written: string[], removed: string[], skipped: string[]}}
 *   `skipped` lists dotted paths the merge refused to touch (a key that heads a
 *   block, a scalar where a list belongs) — the caller decides whether to fail
 *   loudly. Empty on every patch shape the config page sends.
 */
export function mergeYamlPatch(text, patch) {
  const original = String(text ?? "");
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const written = [];
  const removed = [];
  const skipped = [];

  for (const { path, value } of flattenPatch(patch)) {
    const dotted = path.join(".");
    // `undefined` is "the caller did not send this" — leave the file alone.
    // `null` is an explicit clear (the "back to the generic mode" case).
    if (value === undefined) continue;
    if (value === null) {
      if (deleteKey(lines, path)) removed.push(dotted);
      continue;
    }
    const ok = Array.isArray(value) ? writeList(lines, path, value) : writeScalar(lines, path, value);
    if (ok) written.push(dotted);
    else skipped.push(dotted);
  }

  const out = lines.join(eol);
  return { text: out, changed: out !== original, written, removed, skipped };
}
