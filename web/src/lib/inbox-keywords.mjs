// inbox-keywords.mjs — 收件箱关键词条的纯逻辑层（ADR-0068，node --test locked）。
//
// 全部零 token：已评估行直接采信报告 `## Keywords extracted` 现成节（oferta.md
// 系统层契约），未评估行用「关键词词表」做词典匹配。红线：报告的 AI 评估正文
// 永不参与匹配——否则 cv.md 用词会经报告措辞反向污染命中集（ADR-0068 Context 4）。
//
// 纯 .mjs（无 fs、无 yaml 依赖）：文件读取与 YAML 解析留在 career-ops.ts 服务端，
// 本模块只做文本/集合运算，口径可被 node --test 直接上锁（同 inbox-score.mjs /
// pipeline-sections.mjs 的取舍）。

/** 关键词条默认展示的 chip 上限（ADR-0068 决议 4）。 */
export const KEYWORD_TOP_N = 12;

/** 词条合法性：禁逗号/顿号/分号（URL 参数 `?kwd=a,b` 的分隔符即失效形态）与
 *  过长句子残留。 */
export function isValidTerm(term) {
  if (!term) return false;
  if (/[,，、;；]/.test(term)) return false;
  return term.length <= 24;
}

/**
 * 把一段关键词文本归一拆成词条数组。分隔符 `、 ， , ; ；` 与换行统一；
 * 剥掉 markdown 强调/列表符；去空、去句子残留（isValidTerm）、大小写
 * 不敏感去重（保留首个词形）。
 * @param {string} text
 * @returns {string[]}
 */
export function splitKeywordList(text) {
  if (!text) return [];
  const clean = String(text)
    .replace(/^[\s>-]+/gm, "")
    .replace(/\*\*/g, "")
    .replace(/[*_`]/g, "");
  const parts = clean.split(/[、，,;；\n]+/);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const term = p.replace(/\s+/g, " ").trim();
    if (!isValidTerm(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/**
 * 从报告全文提取 `## Keywords extracted` 节的词条。节尾 = 下一个 `## ` 标题或
 * 文件末尾（与 offer 模式的报告模板一致；不用正则锚 `$`，避开 CRLF/尾行坑）。
 * 只认这一节——报告其余章节一律不看（红线）。无节 → 空数组。
 * @param {string} md
 * @returns {string[]}
 */
export function extractSectionKeywords(md) {
  if (!md) return [];
  const lines = String(md).split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*keywords extracted\s*$/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return splitKeywordList(body.join("\n"));
}

/**
 * 解析 skill-extract.mjs 源码里的 SKILL_TOKENS 数组（ADR-0068 决议 2 的第三
 * 词源）。文本级提取：剥 // 与 /* *\/ 注释后取 `export const SKILL_TOKENS = [`
 * 到配对 `]` 的字面量区间，抓引号字符串，按该文件 DISPLAY 同规则去转义
 * （`\` 与 `?` 删除）。结构不符（上游改格式）→ 空集降级，不抛错不阻塞页面，
 * 由测试对当前格式上锁。
 * @param {string} srcText
 * @returns {string[]}
 */
export function parseSkillTokens(srcText) {
  if (!srcText) return [];
  try {
    const noBlock = String(srcText).replace(/\/\*[\s\S]*?\*\//g, "");
    // 逐行剥 // 注释（token 字面量不含 //，URL 类 token 不存在于此表）
    const lines = noBlock.split("\n").map((l) => {
      const idx = l.indexOf("//");
      return idx >= 0 && !hasQuoteBefore(l, idx) ? l.slice(0, idx) : l;
    });
    const src = lines.join("\n");
    const start = src.indexOf("SKILL_TOKENS");
    if (start === -1) return [];
    const open = src.indexOf("[", start);
    const close = src.indexOf("]", open);
    if (open === -1 || close === -1) return [];
    const body = src.slice(open + 1, close);
    const found = body.match(/'((?:[^'\\]|\\.)*)'/g);
    if (!found) return [];
    const out = [];
    const seen = new Set();
    for (const raw of found) {
      const display = raw.slice(1, -1).replace(/\\/g, "").replace(/\?/g, "");
      if (!display || seen.has(display.toLowerCase())) continue;
      seen.add(display.toLowerCase());
      out.push(display);
    }
    return out;
  } catch {
    return [];
  }
}

/** 行内 `//` 之前是否已有引号（引号内的 // 不是注释起点）。 */
function hasQuoteBefore(line, idx) {
  const before = line.slice(0, idx);
  const sq = (before.match(/'/g) || []).length;
  const dq = (before.match(/"/g) || []).length;
  return sq % 2 === 1 || dq % 2 === 1;
}

/**
 * cv.md 的 Skills 节技能词（第二词源）。节 = `^#+ Skills` 标题后到下一个任意
 * `^#+ ` 标题（与 jd-skill-gap.mjs 的 splitSkillsSection 同语义，此处做拆分
 * 用途）。标题行本身不算词。
 * @param {string} md
 * @returns {string[]}
 */
export function cvSkillsFromMd(md) {
  if (!md) return [];
  const lines = String(md).split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s*skills\s*$/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return [];
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return splitKeywordList(body.join("、"));
}

/**
 * 词表 = 各源并集（portals.yml title_filter.positive / cv.md Skills /
 * skill-extract SKILL_TOKENS / 用户 keywords.yml 增量），统一过 isValidTerm
 * 并大小写不敏感去重。返回去重后的词条数组（原词形）。
 * @param {Record<string, string[]>} sources
 * @returns {string[]}
 */
export function buildVocab(sources) {
  const seen = new Set();
  const out = [];
  for (const list of Object.values(sources || {})) {
    for (const term of list || []) {
      if (!isValidTerm(term)) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(term);
    }
  }
  return out;
}

/**
 * 关键词匹配的唯一口径实现：纯 ASCII 术语大小写不敏感子串，非 ASCII（CJK/混合）
 * 直接子串（与收件箱 `q` 搜索框的匹配姿态一致，不发明第二套分词）。命中判定
 * （matchVocab）与高亮分段（splitHighlight）共用本函数，杜绝两处口径漂移。
 * 空术语不命中。
 * @param {string} text
 * @param {string} term
 * @returns {Array<[number, number]>} 命中区间（半开 [start, end)，按出现序）
 */
function findTermRanges(text, term) {
  if (!text || !term) return [];
  const ascii = /^[\x00-\x7F]+$/.test(term);
  const needle = ascii ? term.toLowerCase() : term;
  const hay = ascii ? text.toLowerCase() : text;
  const ranges = [];
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    ranges.push([idx, idx + needle.length]);
    from = idx + needle.length;
  }
  return ranges;
}

/**
 * 词典匹配：text 命中词表里的哪些词（匹配口径见 findTermRanges）。
 * @param {string} text
 * @param {string[]} vocab
 * @returns {string[]}
 */
export function matchVocab(text, vocab) {
  if (!text || !vocab || !vocab.length) return [];
  const hay = String(text);
  const out = [];
  for (const term of vocab) {
    if (findTermRanges(hay, term).length > 0) out.push(term);
  }
  return out;
}

/**
 * 装配一行最终关键词（ADR-0068 决议 1/2）：词节来源 ∪ 各文本面的词典命中，
 * `exclude:` 同时压掉两个来源的产出（大小写不敏感），保持首次出现的词形序。
 * @param {{ sectionKeywords?: string[]; faces?: string[]; vocab?: string[]; exclude?: string[] }} opts
 * @returns {string[]}
 */
export function assembleRowKeywords(opts) {
  const { sectionKeywords, faces, vocab, exclude } = opts || {};
  const excludeKeys = new Set((exclude || []).map((e) => String(e).toLowerCase()));
  const seen = new Set();
  const out = [];
  const push = (term) => {
    const key = String(term).toLowerCase();
    if (excludeKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  for (const term of sectionKeywords || []) push(term);
  const matched = new Set(matchVocab((faces || []).join("\n"), vocab));
  for (const term of vocab || []) if (matched.has(term)) push(term);
  return out;
}

/**
 * 关键词条的 chip 数据源：按命中行数降序、同数按词形升序。计数口径 = 传入的
 * 「未隐藏全部 pending 行」，每行的同一关键词只计一次（ADR-0068 决议 4）。
 * @param {{ keywords?: string[] }[]} rows
 * @returns {[string, number][]}
 */
export function countKeywords(rows) {
  const counts = new Map();
  for (const r of rows || []) {
    const kws = new Set(r.keywords || []);
    for (const k of kws) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/**
 * URL 参数 `?kwd=词1,词2` → Set（`、，,` 归一，空段丢弃）。
 * @param {string} raw
 * @returns {Set<string>}
 */
export function parseKwdParam(raw) {
  const out = new Set();
  for (const p of String(raw || "").split(/[、，,]+/)) {
    const t = p.trim();
    if (t) out.add(t);
  }
  return out;
}

/**
 * Set → URL 参数字符串；空集 → 空串（调用侧按 falsy 删参数）。
 * @param {Set<string>|null|undefined} set
 * @returns {string}
 */
export function serializeKwd(set) {
  return [...(set || [])].join(",");
}

/**
 * 挑出选中词里已不再命中任何 pending 行的死词（删除/批量评估后调用）。
 * rows 必须传「全部 pending 行，含 hidden」——skip 可撤销、数据还在，不该被
 * 剪；done 行的 keywords 本就是空数组，天然不贡献存活集。
 * 死词过滤器让页面停在「0 匹配」而数据其实还在（用户报修：删完命中行后
 * 应显示剩余数据），由调用侧从 URL 里剪掉。
 * @param {Set<string>|null|undefined} kwdSet
 * @param {{ keywords?: string[] }[]} rows
 * @returns {string[]}
 */
export function deadKeywords(kwdSet, rows) {
  if (!kwdSet || kwdSet.size === 0) return [];
  const alive = new Set();
  for (const r of rows || []) for (const k of r.keywords || []) alive.add(k);
  return [...kwdSet].filter((k) => !alive.has(k));
}

/**
 * 命中高亮的分段器（ADR-0068 决议 6）：把 text 按 terms 的命中区间切成
 * [{t, hit}] 连续段（重叠区间自动合并）。匹配口径见 findTermRanges（与
 * matchVocab 同一实现）。无 terms → 单段不命中（行渲染零变化）。
 * @param {string} text
 * @param {string[]|null|undefined} terms
 * @returns {{t: string, hit: boolean}[]}
 */
export function splitHighlight(text, terms) {
  if (!text) return [];
  if (!terms || !terms.length) return [{ t: text, hit: false }];
  const marks = new Array(text.length).fill(false);
  for (const term of terms) {
    for (const [start, end] of findTermRanges(text, term)) {
      for (let i = start; i < end; i++) marks[i] = true;
    }
  }
  const out = [];
  let cur = { t: "", hit: marks[0] };
  for (let i = 0; i < text.length; i++) {
    if (marks[i] !== cur.hit) {
      out.push(cur);
      cur = { t: "", hit: marks[i] };
    }
    cur.t += text[i];
  }
  if (cur.t) out.push(cur);
  return out;
}
