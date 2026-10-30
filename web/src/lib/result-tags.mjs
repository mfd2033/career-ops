// result-tags.mjs — 探索页结果标签条的纯逻辑层（口径同 ADR-0068 收件箱关键词条）。
//
// 为什么是独立 .mjs：探索结果是流式落到浏览器侧的，标签只能在客户端算；但「什么算
// 一个命中」「选中项之间怎么组合」「chip 数字等于什么」这些可判定口径必须能被
// node --test 上锁——本仓 web 组件没有渲染测试基建（ADR-0072 known gap）。
//
// 零 token：标签 = 收件箱同一份词表（portals.yml title_filter.positive ∪ cv.md
// Skills 节 ∪ skill-extract.mjs 的 SKILL_TOKENS ∪ config/keywords.yml 增量）对结果
// 卡片文本面（职位名 + 公司 + 地点）的词典匹配。不读 JD 正文、不调 LLM、不发明词条，
// 也不对已评估报告做二次提炼——发现阶段的结果还没有报告，词表就是唯一口径。

import { assembleRowKeywords, countKeywords } from "./inbox-keywords.mjs";

/** 标签条默认展示的 chip 上限（与收件箱 KEYWORD_TOP_N 同一视觉纪律）。 */
export const RESULT_TAG_TOP_N = 12;

/** 结果卡片的可匹配文本面——与收件箱行同一口径（公司 + 职位 + 地点），空白段丢弃。 */
export function offerTagFaces(offer) {
  const raw = [offer?.title, offer?.company, offer?.location];
  return raw.filter((s) => typeof s === "string" && s.trim() !== "");
}

/**
 * 单个结果的标签：词表命中（`exclude` 同时压掉词表命中）。
 * 命中实现复用 inbox-keywords.mjs 的 matchVocab（ASCII 大小写不敏感子串、
 * CJK 直接子串），两处永不漂移。
 * @param {{title?: string, company?: string, location?: string}} offer
 * @param {string[]} vocab
 * @param {string[]} [exclude]
 * @returns {string[]}
 */
export function offerTags(offer, vocab, exclude) {
  return assembleRowKeywords({ faces: offerTagFaces(offer), vocab, exclude });
}

/**
 * 批量打标：返回新数组，每行多一个只读 `tags` 字段（不改原对象）。词表为空时
 * 每行 tags 为空数组——标签条随之整条隐藏，过滤恒放行。
 * @template T
 * @param {T[]} offers
 * @param {string[]} [vocab]
 * @param {string[]} [exclude]
 * @returns {(T & {tags: string[]})[]}
 */
export function withTags(offers, vocab, exclude) {
  const list = offers || [];
  if (!vocab || vocab.length === 0) return list.map((o) => ({ ...o, tags: [] }));
  return list.map((o) => ({ ...o, tags: offerTags(o, vocab, exclude) }));
}

/**
 * 标签过滤：未选中任何 chip → 全放行；选中 → 命中任一即保留（chip 之间 OR，
 * 与其余条件——tab、搜索框——之间 AND，由调用方在上游先过滤）。
 * @template {{tags?: string[]}} T
 * @param {T[]} rows
 * @param {Set<string>|null|undefined} selected
 * @returns {T[]}
 */
export function filterByTags(rows, selected) {
  const list = rows || [];
  if (!selected || selected.size === 0) return list;
  return list.filter((r) => (r.tags || []).some((tag) => selected.has(tag)));
}

/**
 * chip 计数：与收件箱同一实现（countKeywords）——按命中行数降序、同数按词形升序，
 * 每行同一标签只计一次。计数基底由调用方给出（口径：通过其余全部条件的行集），
 * 保证 chip 上的数字恒等于点击后的匹配行数。
 * @param {Array<{tags?: string[]}>} rows
 * @returns {[string, number][]}
 */
export function countOfferTags(rows) {
  return countKeywords((rows || []).map((r) => ({ keywords: r.tags })));
}

/**
 * 保证选中项恒可见：不在计数里的选中标签补一枚 0 计数行。否则用户切到不含该词
 * 的 tab / 改了搜索词后，选中态仍在、chip 却消失——既看不见也取消不掉，页面只剩
 * 「0 结果」而无解释。
 * @param {[string, number][]} counts
 * @param {Set<string>|null|undefined} selected
 * @returns {[string, number][]}
 */
export function withSelectedCounts(counts, selected) {
  const list = counts || [];
  if (!selected || selected.size === 0) return list;
  const seen = new Set(list.map(([tag]) => tag));
  const missing = [...selected].filter((tag) => !seen.has(tag)).map((tag) => [tag, 0]);
  return [...list, ...missing];
}
