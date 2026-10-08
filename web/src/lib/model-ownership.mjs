/**
 * web/src/lib/model-ownership.mjs — 模型 id 归属判定（ADR-0073）。
 *
 * 为什么需要它：2026-10-08 那次评估失败账本记的是 `claude + hy3`，而 `hy3` 只存在于
 * CodeBuddy 的模型目录里。配置页写 `cliId` 的那条路径（persistCliId）从不校正
 * `model`，于是「换了引擎没换模型」就成了一个谁都没配置过、却会被真实拼进 argv 的
 * 组合。守卫要回答的问题很朴素：**这个模型 id 是不是明确属于另一家引擎**。
 *
 * 只在有明确证据时动手（保守）：
 *   - id 在本引擎目录里 → 保留（哪怕别家也有同名 id，本引擎说了算）
 *   - 本引擎有目录、里面没有、且出现在别家目录里 → 判定为脏组合，丢弃
 *   - 本引擎根本没目录可参考（目录读自 CLI 自身的 opencode / qoder-cn，或检测里
 *     没这一行），又或两边都不认识这个 id → 保留
 * 后两档是刻意的：opencode / qoder-cn 的目录是运行时读自 CLI 本身（ADR-0052/0053），
 * 静态表看不见它们；把「静态表没有」当成「不属于本引擎」会误杀真实可用的模型，
 * 而误杀的代价是把用户选的模型静静换成引擎默认 —— 比漏过一个脏模型更难发现。
 *
 * 客户端安全：无 node 依赖，配置页与服务端两侧都能 import 同一份规则，不写两份。
 */

/** 把 `{ id, label }` 选项数组取成 id 列表；缺字段一律当空目录，不抛。 */
function optionIds(entry) {
  const options = entry && entry.model ? entry.model.options : null;
  return Array.isArray(options) ? options.map((o) => (o && typeof o.id === "string" ? o.id : "")).filter(Boolean) : [];
}

/**
 * 这个模型 id 是否明确属于「别家」引擎？
 *
 * @param {string} model - 待判定的模型 id
 * @param {string[]} ownIds - 目标引擎自己的模型目录
 * @param {string[]} otherIds - 其余引擎的模型目录（合并后的扁平列表）
 * @returns {boolean} true = 脏组合，应丢弃；false = 保留
 */
export function modelBelongsToOtherCli(model, ownIds, otherIds) {
  if (!model) return false;
  if (ownIds.includes(model)) return false;
  return otherIds.includes(model);
}

/**
 * 服务端版：从「引擎 → 模型 id 列表」的目录表里判定并丢弃脏模型（ADR-0073 决议 4）。
 *
 * 目录表由调用方提供（`clis.ts` 把静态 `MODELS` 压成 id 列表），判定规则与客户端
 * `reconcileEnginePick` 共用同一个 `modelBelongsToOtherCli`，两家不写两份规则。
 *
 * @param {{ [cliId: string]: string[] }} catalog - 每个引擎的模型 id 目录
 * @param {string} cliId - 本次派发的引擎 id（目录里查不到 = 空 own 目录）
 * @param {string | undefined} model - 请求带来的模型
 * @returns {string} 保留的模型 id；脏组合返回空串
 */
export function dropForeignModel(catalog, cliId, model) {
  if (!model) return "";
  const table = catalog || {};
  const own = table[cliId] || [];
  // 本引擎没有目录可参考 = 无从判定。静态表刻意留空的引擎（qoder-cn 的目录读自 CLI
  // 本身、opencode 读自用户配置，ADR-0052/0053）以及检测里根本没有这一行都走这里：
  // 此时「别家有」不能反推「本家跑不了」，误丢会把用户选的模型静静换成引擎默认。
  if (own.length === 0) return model;
  const others = Object.keys(table)
    .filter((id) => id !== cliId)
    .flatMap((id) => table[id] || []);
  return modelBelongsToOtherCli(model, own, others) ? "" : model;
}

/**
 * 客户端版：给定「要切到的引擎 + 本机检测到的引擎列表」，算出这次落盘该带哪个模型。
 *
 * `persistCliId` 用它保证 `cliId` 与 `model` 不会各说各话（ADR-0073 决议 3）。
 * 判定证据只来自检测响应里的目录，纯函数、可单测。
 *
 * @param {{ cliId: string, model?: string, modelCliId?: string, clis?: { id: string; model?: { options?: { id: string }[] } }[] }} args
 * @returns {{ model: string, modelCliId: string, dropped: boolean }} 清洗后的 model / modelCliId
 */
export function reconcileEnginePick({ cliId, model = "", modelCliId = "", clis = [] }) {
  if (!model) return { model: "", modelCliId, dropped: false };
  const list = Array.isArray(clis) ? clis : [];
  const catalog = {};
  for (const c of list) if (c && c.id) catalog[c.id] = optionIds(c);
  // own 目录为空（检测里没这一行、或该引擎的目录本就读自 CLI 自身）时
  // `dropForeignModel` 会保守保留：没有证据就不拆用户的模型。
  const kept = dropForeignModel(catalog, cliId, model);
  if (kept) return { model: kept, modelCliId, dropped: false };
  return { model: "", modelCliId: "", dropped: true };
}
