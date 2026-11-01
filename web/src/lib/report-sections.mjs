/**
 * report-sections.mjs — splitting a report body into its author-lettered
 * sections, and cleaning those headings for display.
 *
 * Plain .mjs (same pattern as clean-chips.mjs) so test-report-sections.mjs can
 * import it directly under Node, and so the two places that used to hard-code
 * the author-letter range can no longer drift apart: they were written as
 * `[A-G]` in report-view.tsx, which silently mis-handled `## H) Draft
 * Application Answers` — the heading rendered with its letter still attached
 * while every other section rendered clean, and splitSections reported
 * `letter: null` for it (#2324).
 *
 * The range is now any single letter. The `)` / `.` / `:` delimiter is what
 * keeps this from eating ordinary prose ("A Recommendation Was Requested"),
 * not the narrowness of the range — so widening it costs no safety, and a
 * block added past H is handled the day the core writes it.
 */

/**
 * Strips the prefix for display. A BARE letter needs a real delimiter, never a
 * bare space, or ordinary prose loses its first word ("A Recommendation Was
 * Requested" → "Recommendation Was Requested").
 *
 * After `Block` the whitespace form is allowed, because the word itself is the
 * disambiguator: "## Block A — Role Summary" (oferta.md:47) is unmistakably a
 * lettered heading. HEADING_LETTER below already reads that grammar as section
 * A, so leaving the prefix in the rendered heading made this file classify a
 * heading one way and display it another (CodeRabbit review).
 *
 * The separator is a RUN of dashes, not one character: modes/ja/kyujin.md and
 * modes/hi/naukri.md write the ASCII "## Block A -- Role Summary", which left a
 * stray "- " on every block of every report those modes produce.
 */
const HEADING_PREFIX = /^\s*(?:Block\s+([A-Z])(?:[).:]\s*|\s+(?:[—–-]+\s*)?)|([A-Z])[).:]\s*)/i;

/**
 * Reads the letter. A bare letter needs a delimiter, exactly like the display
 * form above — otherwise "A Recommendation Was Requested" is read as section A
 * and ReportView expands ordinary prose as if it were Block A.
 *
 * The whitespace form is kept for the spelled-out grammar only: oferta.md
 * writes "## Block A — Role Summary", where nothing follows the letter but a
 * space. Requiring a delimiter there would lose the F verdict callout and the
 * A/B expansion on those reports.
 */
const HEADING_LETTER = /^(?:Block\s+([A-Z])(?:[).:]|\s)|([A-Z])[).:])/i;

/**
 * @typedef {{ heading: string, letter: string | null, content: string }} Section
 */

/**
 * 结论文本（口播/lead）在报告里没有固定字母位：标准模板 `modes/oferta.md`
 * 的 F 是 Interview Plan，只有早期个别报告写过 `## F) Verdict (lead)`。
 * 按字母硬找会把「面试备考计划」当成评估结论渲染到页面最顶部（771 份报告里
 * 没有一份是 `F) Verdict`），所以改按标题识别——中英文、带不带冒号/括号都认。
 */
const VERDICT_EN = /^(?:(?:final|overall)\s+)?(?:verdict|assessment|overall\s+judgment)\b/i;
const VERDICT_ZH = /^(?:评估结论|评估总结|最终评估|最终结论|综合评估|综合结论|总体判断|总体评价|最终建议|结论)$/;

/**
 * Whether a section heading names the report's verdict block. Accepts either a
 * raw heading ("F) Verdict (lead)") or an already-cleaned one ("Verdict").
 * @param {string} heading
 * @returns {boolean}
 */
export function isVerdictHeading(heading) {
  const h = cleanHeading(heading).replace(/[\s:：]+$/, "");
  return VERDICT_EN.test(h) || VERDICT_ZH.test(h);
}

/**
 * 「为什么这份分低」在报告里没有统一字段：有的报告写了独立的 `## 评估结论`
 * 段（含不匹配理由），更多现代模板只在 B) Match with CV 下挂一个
 * `### 能力差距 (Gaps)` 子小节。没有结论段时，把该子小节里的条目首行抽成
 * 一份短摘要，供页面在评估结论上方展示扣分原因（400/771 份报告命中）。
 *
 * 只取条目首行——子行是「硬门槛还是加分项 / 能否等价证明 / 怎么补」的解释，
 * 放进顶部摘要会把决策点淹掉；完整内容仍在 B 段展开里。
 */
const GAP_SUBHEADING = /(?:gaps?|差距|缺口)/i;
/** 有的模式写成独立一行粗体小节标题（`**能力差距 (Gaps)：**`），不是 `###`。 */
const BOLD_SUBHEADING = /^\*\*([^*]+?)\*\*\s*[:：]?\s*$/;
/** 编号条目（`1.` / `2)`）或无序条目（`-` / `*`），且顶格——缩进子行是
 *  「硬门槛还是加分项 / 能否等价证明 / 怎么补」的解释，不属于条目首行。 */
const GAP_ITEM = /^(?:\d+[.)]|[-*])\s+(.*)$/;
/** 条目自带 `**标题**：解释…` 时只取标题本身。 */
const ITEM_BOLD_HEAD = /^\*\*([^*]+)\*\*/;

/**
 * @param {string} markdown 报告正文（通常是 B 段或整篇 body）
 * @param {number} max
 * @returns {string[]}
 */
export function extractGapHighlights(markdown, max = 6) {
  /** @type {string[]} */
  const out = [];
  let inGap = false;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^#{2,4}\s+(.*)$/);
    if (heading) {
      inGap = GAP_SUBHEADING.test(heading[1]);
      continue;
    }
    const bold = line.match(BOLD_SUBHEADING);
    if (bold) {
      inGap = GAP_SUBHEADING.test(bold[1]);
      continue;
    }
    if (!inGap) continue;
    const item = line.match(GAP_ITEM);
    if (!item) continue;
    const text = (item[1].match(ITEM_BOLD_HEAD)?.[1] ?? item[1]).replace(/[*_`]/g, "").trim();
    if (text.length < 4 || out.includes(text)) continue;
    out.push(text.length > 90 ? text.slice(0, 90).trimEnd() + "…" : text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Display form of a section heading: author-letter prefix and the trailing
 * "(lead)" / "(verdict)" marker removed. Falls back to the original when
 * stripping would leave nothing.
 * @param {string} h
 * @returns {string}
 */
export function cleanHeading(h) {
  const stripped = h
    .replace(HEADING_PREFIX, "")
    .replace(/\s*\((?:lead|verdict)\)\s*$/i, "")
    .trim();
  return stripped || h.trim();
}

/**
 * The author letter of a heading, uppercased, or null when it carries none.
 * @param {string} heading
 * @returns {string | null}
 */
export function authorLetter(heading) {
  const match = heading.match(HEADING_LETTER);
  return (match?.[1] ?? match?.[2])?.toUpperCase() ?? null;
}

/**
 * Split a report body on `## ` headings. Everything before the first one is
 * the intro.
 * @param {string} body
 * @returns {{ intro: string, sections: Section[] }}
 */
export function splitSections(body) {
  /** @type {string[]} */
  const intro = [];
  /** @type {Section[]} */
  const sections = [];
  /** @type {{ heading: string, letter: string | null, lines: string[] } | null} */
  let cur = null;
  for (const line of body.split("\n")) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join("\n").trim() });
      const heading = h[1].trim();
      cur = { heading, letter: authorLetter(heading), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      intro.push(line);
    }
  }
  if (cur) sections.push({ heading: cur.heading, letter: cur.letter, content: cur.lines.join("\n").trim() });
  return { intro: intro.join("\n").trim(), sections };
}
