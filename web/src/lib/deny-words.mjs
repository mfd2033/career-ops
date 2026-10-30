// deny-words.mjs — 「拉黑所选」的候选词推导（标题门黑名单的零 token 前端）。
//
// 用户在结果区勾选几条不合适的岗位，工具栏「拉黑所选」把标题里的特征词带进
// GatePanel 的黑名单草稿——弹窗里现成的试算（buildTitleFilterExplained 同一份
// 编译）会让用户在保存前看到「会多毙几条」，所以这里只负责「提议」，不负责
// 「判定」：推导出的每个词都只是 chip，增删改全部发生在标题门弹窗里。
//
// 为什么是独立 .mjs：与 result-tags.mjs 同一理由——可判定口径必须能被
// node --test 上锁（本仓 web 组件没有渲染测试基建，ADR-0072 known gap）。
//
// 零 token：只看标题字符串本身，不读 JD 正文、不调 LLM、不做中文分词——
// 没有可靠的轻量中文分词器，整段 CJK 连串作为一个候选交给用户修剪
// （「仓储主管」想毙的也许是「仓储」两个字，但替用户猜错比让他删三个字更贵：
// 猜错的词进了黑名单会无声多毙一批，修剪过短只会少毙——两类错误的代价不对称）。

/** 候选词长度上限：超过它多半是整句话而不是岗位特征词。 */
const MAX_LEN = 24;

/** 标题开头的招聘噪声（急聘/高薪一类），剥掉后再提候选——它们不是岗位名。
 *  「招聘」不在列：它本身是真实角色名的一部分（招聘专员），剥坏比留着贵。 */
const NOISE_PREFIX = /^(?:急聘|急招|诚聘|直聘|高薪聘|高薪)+/;

/**
 * 从单个标题提取黑名单候选词：拉丁词（≥2 字符，含 PHP/C++/.NET 一类内部
 * 符号——与 compileKeyword 的子串匹配同口径）+ CJK 连串（整串一条，标题里的
 * 「/」「·」等分隔符会把并列岗位自然断开）。
 *
 * @param {string|undefined} title
 * @returns {string[]}
 */
export function titleDenyCandidates(title) {
  let s = String(title ?? "");
  // 括号里的内容（（双休）（浦东）(15-25K)）是福利/地点/薪资注脚，不是岗位名。
  s = s.replace(/[（(【\[][^（(【\[）)】\]]*[）)】\]]/g, " ");
  s = s.replace(NOISE_PREFIX, "");
  const out = [];
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9+#.]*/g)) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  for (const m of s.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    out.push(m[0]);
  }
  return [...new Set(out.filter((w) => w.length <= MAX_LEN))];
}

/**
 * 批量提议：按 offer 顺序展平 + 大小写不敏感去重（保留首次出现的形态）。
 *
 * @param {Array<{title?: string}>|null|undefined} offers
 * @returns {string[]}
 */
export function suggestDenyWords(offers) {
  const seen = new Set();
  const out = [];
  for (const o of offers || []) {
    for (const w of titleDenyCandidates(o?.title)) {
      const k = w.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(w);
    }
  }
  return out;
}

/**
 * 把一批新词并进一份黑名单：大小写不敏感去重，已有词原样保留（与 GatePanel
 * 的 addOne 同一去重口径——「同名词表里落两条」正是那处注释防的事）。
 *
 * @param {string[]|null|undefined} saved
 * @param {string[]|null|undefined} additions
 * @returns {string[]} 新数组，不改传入值。
 */
export function mergeDenyWords(saved, additions) {
  const list = [...(saved || [])];
  for (const w of additions || []) {
    const t = String(w).trim();
    if (!t) continue;
    if (!list.some((k) => k.trim().toLowerCase() === t.toLowerCase())) list.push(t);
  }
  return list;
}
