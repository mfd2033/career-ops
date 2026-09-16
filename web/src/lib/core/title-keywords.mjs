// title-keywords.mjs (WEB MIRROR) — behaviourally identical to the repo-root
// ../title-keywords.mjs, which stays the single definition of how a
// `title_filter` keyword matches a job title.
//
// WHY A MIRROR AT ALL: the root module's own header says there is one copy of
// this logic "so a second copy would repeat" the profile-keywords drift. The
// copy exists anyway, for a reason the root module cannot see: Turbopack's root
// is pinned to web/ and refuses modules outside it (web/next.config.mjs; same
// constraint as web/src/lib/tracker-table.mjs and profile-keywords.mjs). The
// browser-mode title gate runs in the EXTENSION path, inside the Next app, so it
// cannot import the root module — and the CLI cannot run it either, because
// browser discovery is extension-driven (ADR-0007) and must not spawn the
// scanner.
//
// The alternative — inlining "just the substring match" — is exactly the drift
// this pair exists to prevent: an empty positive list means "accept everything"
// here and "reject everything" there, AND-groups work on one side only, a
// non-string YAML entry is dropped on one side and coerced on the other. Those
// three drifts are historical, not hypothetical.
//
// The pair is held together by tests/title-keywords-parity.test.mjs in the ROOT
// suite (web-ci.yml cannot run it: importing the root module resolves nothing
// inside web/). If you change the root module, change this one to match — the
// parity test is the tripwire.
//
// Only the header differs from the root file; every rule below is kept
// textually identical on purpose, so a diff of the two bodies is empty.

// Opt-in whole-word matching for a keyword too long to get it automatically.
// Chosen over widening the 2-3 char rule to every single-word keyword, because
// the right-hand boundary is exactly what a NEGATIVE usually wants to keep:
// "crypto" is meant to catch "Cryptocurrency" and "fellows" to catch
// "Fellowship", and anchoring the whole list would silently stop both. So the
// list says which entries want it, one entry at a time.
//
// The prefix cannot collide with a real keyword: a job title never contains a
// colon-suffixed "word", and an entry is one keyword, not a sentence.
export const WORD_PREFIX = 'word:';

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// One definition of "inside a word", used by BOTH branches below. Anything else
// reintroduces, inside this module, exactly the drift the module exists to
// prevent: the acronym branch used ASCII \b while the `word:` branch had been
// made Unicode-aware, so `vp` still matched inside an accented word.
//
// String.raw, not a plain template literal: `\p` is not a recognised string
// escape, so an ordinary template drops the backslash and the class degenerates
// to the literal characters p, {, L, } — no error, and the anchor is simply off.
//
// CJK IS DELIBERATELY EXCLUDED, and this is the one place where "inside a word"
// is not simply "a Unicode letter". Han/Hiragana/Katakana/Hangul ARE \p{L}, but
// they do not attach to a Latin acronym the way a Latin letter does: those
// scripts are written without spaces, and a neighbouring ideograph is exactly
// where a word ends. Treating 项 as a word character made `IT` fail inside
// `IT项目管理`, silently killing every Chinese title of the form "IT项目经理"
// (likewise `HR` in `HR主管`, `AI` in `AI工程师`) — Latin titles were the only
// ones that matched, which reads as "the filter works, the market is just thin"
// rather than as a bug. Excluding CJK makes the ideograph a BOUNDARY. Nothing
// about Latin changes: `IT` still refuses `IThub`, because `h` is still a word
// character.
const CJK_CHAR = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]`;
const WORD_CHAR = String.raw`(?:(?!${CJK_CHAR})[\p{L}\p{M}\p{N}_])`;
const anchoredPattern = (body) => new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'u');

/**
 * Compile a lowercased keyword into a matcher.
 *
 * Short all-letter acronyms (2-3 chars: cfo, coo, sdr, bdr, gsi…) match on WORD
 * BOUNDARIES so "COO" does not match "Coordinator". A `word:` prefix asks for
 * the same treatment explicitly, at any length: `word:intern` rejects
 * "Operations Intern" and leaves "Internal Tools" and "International
 * Partnerships Manager" alone. Multi-word phrases and keywords containing
 * non-letters (".NET", "SAP ", "L&D") keep fast, permissive substring matching.
 *
 * @param {string} kw - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
export function compileKeyword(kw) {
  if (kw.startsWith(WORD_PREFIX)) {
    const bare = kw.slice(WORD_PREFIX.length).trim();
    // A bare `word:` is a config typo. Matching NOTHING is the safe reading: as
    // a positive it simply contributes no match, while the alternative — an
    // empty pattern matching every title — would veto an entire scan from one
    // stray colon. Same trade as the "C++" note on scan.mjs's AND_SEPARATOR:
    // prefer a silent drop of one entry over a silent flood.
    if (!bare) return () => false;
    // Explicit alphanumeric lookarounds rather than \b, because \b's meaning
    // depends on the characters at the keyword's own edges: for `word:c++` a
    // trailing \b would sit after "+" and assert the opposite of the intent.
    // WORD_CHAR rather than [a-z0-9_]: an ASCII-only lookaround treats every
    // accented letter as a separator, so `word:intern` matched inside
    // "preintern" spelled with an accent and vetoed exactly the international
    // titles this prefix exists to protect. \p{M} covers combining marks, so a
    // decomposed "é" does not split a word either.
    const re = anchoredPattern(escapeForRegExp(bare));
    return (lower) => re.test(lower);
  }
  if (/^[a-z]{2,3}$/.test(kw)) {
    // The same boundary as above, not \b: \b is ASCII-only, so "vp" matched
    // inside an accented word while `word:vp` did not. Two spellings of one
    // rule in one file is the drift this module was extracted to end.
    const re = anchoredPattern(kw);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(kw);
}

// An AND-group: " + " (whitespace-delimited) between terms means EVERY term
// must appear in the title, in any order. `title_filter.positive` is otherwise
// matched by compileKeyword — a plain substring, EXCEPT for a 2-3 letter
// keyword ("AI", "ML", "VP") or a `word:`-prefixed one, both of which are
// anchored so they cannot hit inside another word. Either way an entry
// expresses one exact spelling and nothing else, and real titles vary in
// separator and word order:
//
//   "Director of Engineering" misses  Director - Software Engineering
//                                     Director Engineering (Mobile Platform)
//                                     Senior Director, Platform Engineering
//
// The combinations are {level} x {, - of none} x {optional domain word}: no
// hand-maintained list of literal spellings converges, and every miss is
// silent — the summary reports one "filtered by title" count that cannot tell
// a well-tuned filter from a leaking one (#2544).
//
// The separator REQUIRES surrounding whitespace on purpose. A bare split('+')
// would turn the perfectly ordinary keyword "C++" into "c", which matches
// almost every title — trading a silent drop for a silent flood.
// Exported because a caller that must reason about the TERMS of a group — the
// dead-positive guard in tests/title-filter-word-prefix.test.mjs — has to split
// them exactly as this file does, and a second copy of the rule is the drift
// this module was extracted to end.
export const AND_SEPARATOR = /\s+\+\s+/;

/**
 * Compile one `positive` entry into a matcher.
 *
 * Entries without " + " keep their exact previous behaviour, so existing
 * configs are unaffected.
 *
 * @param {string} keyword - already trimmed and lowercased.
 * @returns {(lower: string) => boolean}
 */
export function compilePositiveKeyword(keyword) {
  if (!AND_SEPARATOR.test(keyword)) return compileKeyword(keyword);
  const terms = keyword.split(AND_SEPARATOR).map(t => t.trim()).filter(Boolean);
  if (terms.length === 0) return compileKeyword(keyword);
  // Each term keeps compileKeyword's own rule, so a short term like "vp" is
  // still matched on a word boundary and cannot hit "vp" inside another word.
  const matchers = terms.map(compileKeyword);
  return (lower) => matchers.every(m => m(lower));
}

/**
 * Compile a whole `title_filter` into one predicate.
 *
 * This lives here, rather than in scan.mjs beside its main caller, because
 * openrouter-runner.mjs filters titles too and cannot import scan.mjs. It used
 * to keep a second implementation, and the two had drifted in three separate
 * ways: an empty positive list meant "accept everything" here and "reject
 * everything" there, AND-groups worked only here, and a non-string YAML entry
 * was dropped here but coerced into a real keyword there. One shared predicate
 * removes the class rather than those three instances.
 *
 * @param {{positive?: unknown, negative?: unknown}} [titleFilter]
 * @returns {(title: string) => boolean}
 */
export function buildTitleFilter(titleFilter) {
  // The predicate itself lives in buildTitleFilterExplained below, which returns
  // it next to the reason a rejection carries. Kept as one implementation on
  // purpose: a caller that needs to SAY which word rejected a title must not be
  // free to derive that from a second copy of the rule, or the panel and the scan
  // become two answers to one question — and the drift would be invisible, since
  // the panel would confidently name the wrong word.
  return buildTitleFilterExplained(titleFilter).pass;
}

/**
 * buildTitleFilter's predicate, plus the reason a rejected title was rejected.
 *
 * The Explorer's rules card shows the user WHY each posting sits in the 「已过滤」
 * fold, and its live 试算 re-judges the current batch under an edited word list.
 * Both need the matching rule rather than a description of it, so the reasons are
 * produced from the same compiled matchers as the verdict — with each entry kept
 * AS WRITTEN beside its matcher, because the reason is displayed as the user's own
 * word from portals.yml, never as the lowercased form the matcher compiles.
 *
 * @param {{positive?: unknown, negative?: unknown}} [titleFilter]
 * @returns {{
 *   pass: (title: string) => boolean,
 *   explain: (title: string) => {type: 'negative'|'no-positive', words: string[]}
 * }}
 */
export function buildTitleFilterExplained(titleFilter) {
  // Normalize defensively: a malformed title_filter (a null, numeric, or otherwise
  // non-string entry in the YAML) must not crash the scan via k.toLowerCase().
  const normalize = (arr, compile) => (Array.isArray(arr) ? arr : [])
    .filter(k => typeof k === 'string')
    .map(k => k.trim())
    .filter(k => k.length > 0)
    .map(k => [k, compile(k.toLowerCase())]);
  // AND-groups are a POSITIVE-side feature only. On the negative side an entry
  // is a veto, and " + " there would read as "reject when both appear", which
  // is a different and much easier thing to write as two entries.
  const positive = normalize(titleFilter?.positive, compilePositiveKeyword);
  const negative = normalize(titleFilter?.negative, compileKeyword);

  const pass = (title) => {
    // String(), not `title || ''`: openrouter-runner used String(title ?? '')
    // before both paths were merged here, and scan.mjs threw on a truthy
    // non-string. Consolidating on scan.mjs's version would have carried that
    // throw onto a path that never had it, where it aborts jobs.filter and
    // drops a whole company's results for one malformed title.
    const lower = String(title ?? '').toLowerCase();
    // An empty positive list is "no positive constraint", not "match nothing":
    // a negative-only title_filter is a legitimate config that rejects a few
    // roles and keeps the rest.
    const hasPositive = positive.length === 0 || positive.some(([, m]) => m(lower));
    const hasNegative = negative.some(([, m]) => m(lower));
    return hasPositive && !hasNegative;
  };

  // Only meaningful for a title `pass` rejected: every veto the title hit (there
  // can be several — an entry is a veto, not a ranking), else "nothing in the
  // allow list matched it". A caller that reads this off a PASSING title gets the
  // negative hits it found but must not read them as a verdict.
  const explain = (title) => {
    const lower = String(title ?? '').toLowerCase();
    const hits = negative.filter(([, m]) => m(lower)).map(([k]) => k);
    return hits.length > 0 ? { type: 'negative', words: hits } : { type: 'no-positive', words: [] };
  };

  return { pass, explain };
}
