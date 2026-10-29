/**
 * profile-md-sync.mjs — keep the rules that live in `modes/_profile.md`
 * ("## Your Deal-Breakers" / "## Your Comp Targets") in sync with the config
 * page's save target `config/profile.yml` (`narrative.deal_breakers` /
 * `compensation.target_range` + `compensation.minimum`).
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

/** 「## Your Comp Targets」里两个数值锚点行（其余行是规则叙述，不重写只换数字）。 */
const COMP_TARGET_ANCHOR = /^(\s*[-*]\s*)目标薪资\s*[：:]\s*(.*)$/;
const COMP_FLOOR_ANCHOR = /^(\s*[-*]\s*)底线\s*[：:]\s*(.*)$/;

/** 把「值（注释）」拆成值部分与尾部括号注释（注释原样保留）。 */
function splitValueAndNote(rest) {
  const m = /^([^（(]*?)\s*([（(].*)?$/.exec(String(rest ?? ""));
  return { value: (m?.[1] ?? "").trim(), note: (m?.[2] ?? "").trim() };
}

function finiteOrNull(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 从单个值里拆出货币前缀与单位后缀（"25K" → `K`），用作未指定格式时的兜底。 */
function formatParts(text) {
  const m = /^(\D*?)(\d+(?:\.\d+)?)(.*)$/.exec(String(text ?? "").trim());
  return m ? { prefix: m[1].trim(), unit: m[3].trim() } : { prefix: "", unit: "" };
}

/** 取出文本里的所有数字片段（用于判断旧行的写法能不能按位重编）。 */
function numbersIn(text) {
  return String(text ?? "").match(/\d+(?:\.\d+)?/g) ?? [];
}

/**
 * 按位把文本里的数字换成给定值（非数字字符——连字符、`K`、`$`、`万`——全部原样保留）。
 * 这样 "25–30K" → "30–35K"、"$150K-200K" → "$160K-210K"，不把用户原有的
 * 书写习惯强行改写成另一种模板。
 */
function renumberInText(text, values) {
  let i = 0;
  return String(text ?? "").replace(/\d+(?:\.\d+)?/g, (m) => (i < values.length ? String(values[i++]) : m));
}

/**
 * Rewrite the numbers inside ONLY the "## Your Comp Targets" section of
 * `modes/_profile.md` so it matches the salary card's save target.
 *
 * 为什么不能只改 `config/profile.yml`：评估时上下文里同时注入 profile.yml 与
 * `_profile.md`，两边数字不一致会让 agent 拿到两个互相矛盾的事实（用户在配置页
 * 改了底线、评估却按旧底线判 hard_stop）。所以这里同步三处：
 *   1. `- 目标薪资：…` 行重写为新区间，尾部括号注释原样保留；
 *   2. `- 底线：…` 行重写为新底线，注释同样保留（含注释里引用的旧底线数字）；
 *   3. 段内其余行（触线规则、低于目标怎么处理等）把旧值文本精确替换为新值。
 * 段不存在或三项都取不到时 `found:false`，调用方跳过写入而非凭空造段。
 * 段外内容逐字节保留（包括谈判话术等其他段落）。
 *
 * @param {string} markdown raw `modes/_profile.md`
 * @param {{ min?: number; max?: number; floor?: number; prefix?: string; unit?: string }} targets
 * @returns {{ markdown: string; found: boolean }}
 */
export function replaceCompTargetsSection(markdown, targets) {
  const original = String(markdown ?? "");
  const lines = original.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Your\s+Comp\s+Targets\s*$/.test(l.trim()));
  if (start === -1) return { markdown: original, found: false };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }

  const min = finiteOrNull(targets?.min);
  const max = finiteOrNull(targets?.max);
  const floor = finiteOrNull(targets?.floor);

  // 格式优先级：调用方显式传入的 → 区间旧行的 → 底线旧行的。所以一个没带
  // prefix/unit 的调用方（如 assistant 的 setProfile）不会把 "25–30K" 写成 "25–30"。
  const rangeIdx = lines.findIndex((l, i) => i > start && i < end && COMP_TARGET_ANCHOR.test(l));
  const floorIdx = lines.findIndex((l, i) => i > start && i < end && COMP_FLOOR_ANCHOR.test(l));

  const rangeMatch = rangeIdx === -1 ? null : COMP_TARGET_ANCHOR.exec(lines[rangeIdx]);
  const floorMatch = floorIdx === -1 ? null : COMP_FLOOR_ANCHOR.exec(lines[floorIdx]);
  const oldRange = splitValueAndNote(rangeMatch?.[2] ?? "");
  const oldFloor = splitValueAndNote(floorMatch?.[2] ?? "");
  const rangeParts = formatParts(oldRange.value.split(/[-\u2013\u2014~]/)[0]);
  const floorParts = formatParts(oldFloor.value);
  const givenPrefix = typeof targets?.prefix === "string" ? targets.prefix.trim() : "";
  const givenUnit = typeof targets?.unit === "string" ? targets.unit.trim() : "";
  const prefix = givenPrefix || rangeParts.prefix || floorParts.prefix;
  const unit = givenUnit || rangeParts.unit || floorParts.unit;

  // 新区间/新底线一律沿用旧值的逐字写法（连字符、`K`、`$` 都不动）：只存在两个数字
  // 时才按位重编，否则退回模板拼接（旧值是本卡管不了的自由文本）。
  const dash = /[\u2013\u2014]/.test(oldRange.value) ? "\u2013" : "-";
  const newRange =
    min === null || max === null
      ? null
      : numbersIn(oldRange.value).length === 2
        ? renumberInText(oldRange.value, [min, max])
        : `${prefix}${min}${unit}${dash}${prefix}${max}${unit}`;
  const newFloor =
    floor === null
      ? null
      : numbersIn(oldFloor.value).length >= 1
        ? renumberInText(oldFloor.value, [floor])
        : `${prefix}${floor}${unit}`;

  const next = [...lines];
  const touched = new Set();

  if (rangeIdx !== -1 && newRange) {
    const note = oldRange.note.replaceAll(oldRange.value, newRange);
    next[rangeIdx] = `${rangeMatch[1]}目标薪资：${newRange}${note}`;
    touched.add(rangeIdx);
  }
  if (floorIdx !== -1 && newFloor) {
    const note = oldFloor.note.replaceAll(oldFloor.value, newFloor);
    next[floorIdx] = `${floorMatch[1]}底线：${newFloor}${note}`;
    touched.add(floorIdx);
  }
  // 其余行：旧值文本 → 新值（只在段内、只在旧值非空时）。
  for (let i = start + 1; i < end; i++) {
    if (touched.has(i)) continue;
    let line = next[i];
    if (newRange && oldRange.value) line = line.replaceAll(oldRange.value, newRange);
    if (newFloor && oldFloor.value) line = line.replaceAll(oldFloor.value, newFloor);
    next[i] = line;
  }

  return { markdown: next.join("\n"), found: true };
}
