/**
 * profile-patch.mjs — map the config form's JD evaluation/exclusion rule patch
 * onto the config/profile.yml YAML structure.
 *
 * The config page ("JD 评估/排除规则") edits two fields that the evaluation
 * pipeline consumes from profile.yml as free text (`lib/context-budget.mjs`
 * injects the whole file; `run-prompts.mjs` tells the agent to read it):
 *
 *   dealBreakers        → narrative.deal_breakers              (string[])
 *   locationFlexibility → compensation.location_flexibility     (string)
 *   marketMode          → language.modes_dir                    (string; "root" = 清空)
 *
 * marketMode 的三态：不传 = 不动；传 "root" 或空串 = 清空（回到通用模式）；
 * 传 `modes/<lang>` = 切到该模式集。清空用 **null** 表达，由 api/profile/route.ts
 * 在 merge 后把 `language.modes_dir === null` 删键——不能直接把 null 写进 profile.yml，
 * 那会留下一个歧义值，让 resolver 分不清「未配置」与「显式清空」。
 *
 * This mapper is the test seam between the form and the merge-safe writer in
 * api/profile/route.ts. It is a PURE function: it never touches the filesystem
 * and never returns a key the form did not send, so a save from the web and a
 * hand-edit in profile.yml produce the same YAML shape.
 *
 * Plain `.mjs` (same pattern as profile-keywords.mjs) so the test can import
 * the real module under Node without a TypeScript runner.
 */

/**
 * Map a form patch to the nested keys deep-merged into config/profile.yml.
 * Legacy profile fields (name/email/location/roles/comp/remote) keep their
 * existing mappings; the new JD rules join them. Returns {} when nothing
 * meaningful was sent — the caller refuses the write on an empty patch.
 *
 * @param {{
 *   name?: string; email?: string; location?: string; roles?: string[];
 *   compMin?: number; compMax?: number; currency?: string; remote?: string;
 *   dealBreakers?: string[]; locationFlexibility?: string; marketMode?: string;
 *   archetypes?: (string | {name: string; level?: string; fit?: string})[];
 * }} patch
 * @param {unknown[]} [existingArchetypes] 磁盘上已存的原型条目，仅供 archetypes
 *   名单按名对账（ADR-0091）：旧名字整条保留 level/fit，新名字补默认 fit。
 * @returns {Record<string, unknown>}
 */
export function patchToProfile(patch, existingArchetypes = []) {
  const out = {};
  const candidate = {};
  if (patch.name) candidate.full_name = patch.name;
  if (patch.email) candidate.email = patch.email;
  if (patch.location) candidate.location = patch.location;
  if (Object.keys(candidate).length) out.candidate = candidate;
  const target = {};
  if (patch.roles?.length) target.primary = patch.roles.slice(0, 6);
  // 原型名单（ADR-0091）：三态与 marketMode 同构——undefined = 不动；空/全空白 =
  // null 删键（mergeYamlPatch 的删除语义，不留歧义空值）；非空 = 按名对账后的
  // 对象列表整体替换。
  if (Array.isArray(patch.archetypes)) {
    const reconciled = reconcileArchetypes(existingArchetypes, patch.archetypes);
    target.archetypes = reconciled.length ? reconciled : null;
  }
  if (Object.keys(target).length) out.target_roles = target;

  const comp = {};
  if (patch.compMin && patch.compMax) comp.target_range = `${patch.compMin}-${patch.compMax}`;
  if (patch.currency) comp.currency = patch.currency;
  if (patch.remote) comp.location_flexibility = patch.remote;
  if (patch.locationFlexibility) comp.location_flexibility = patch.locationFlexibility;
  if (Object.keys(comp).length) out.compensation = comp;

  // Deal-breakers are a free-text list: trim, drop empties, de-dupe (order
  // preserved). All-blank → no narrative key at all (never a bare array).
  if (Array.isArray(patch.dealBreakers)) {
    const cleaned = [...new Set(patch.dealBreakers.map((b) => String(b).trim()).filter(Boolean))];
    if (cleaned.length) out.narrative = { deal_breakers: cleaned };
  }

  // 评估模式（CO-51/CO-65）：只搬运目录值，合法性由 resolveMarketMode 在消费端把关。
  if (patch.marketMode !== undefined) {
    const v = String(patch.marketMode ?? "").trim();
    out.language = { modes_dir: v && v !== "root" ? v : null };
  }

  return out;
}

/**
 * Read the archetype entries out of a parsed profile document, tolerantly.
 * GET prefills the form from this; POST feeds it to reconcileArchetypes.
 * Anything malformed (no target_roles, scalar where a list belongs, entries
 * without a usable name) yields fewer or zero entries — never a throw.
 * A usable name is a non-blank string OR a number/boolean — YAML auto-types
 * those hand-written forms, and hiding them from the prefill would make the
 * next save silently drop them (#数据丢失类守卫).
 *
 * @param {unknown} profile parsed config/profile.yml (or anything else)
 * @returns {Record<string, unknown>[]} the object entries with a usable name
 */
export function extractArchetypes(profile) {
  const roles = profile && typeof profile === "object" ? profile.target_roles : null;
  const list =
    roles && typeof roles === "object" && Array.isArray(roles.archetypes) ? roles.archetypes : [];
  return list.filter((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) return false;
    const n = e.name;
    if (typeof n === "string") return n.trim() !== "";
    return typeof n === "number" || typeof n === "boolean";
  });
}

/**
 * fit 分层封闭枚举（ADR-0092）：评估打分按此分层（primary=梦想/secondary=合适/
 * adjacent=够得着）。提交里出现枚举外的值（手编 profile.yml 的残留）按「未提供」
 * 处理——沿用磁盘旧值或缺省 primary，绝不静默改写或丢弃。UI 据此渲染下拉选项。
 */
export const ARCHETYPE_FIT_VALUES = ["primary", "secondary", "adjacent"];

/**
 * 把提交的原型条目归一成 {name, level, fit} 三元组：字符串条目（旧调用方）
 * 等价 {name}；对象条目取 name/level/fit 的字符串形态，缺失记空串。
 * 空 name 由调用方丢弃——这里只做归一，不做取舍，永不 throw。
 */
function normalizeArchetypeEntry(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const n = entry.name;
    const name = typeof n === "string" ? n.trim() : n == null ? "" : String(n).trim();
    return {
      name,
      level: typeof entry.level === "string" ? entry.level.trim() : "",
      fit: typeof entry.fit === "string" ? entry.fit.trim() : "",
    };
  }
  return { name: String(entry ?? "").trim(), level: "", fit: "" };
}

/**
 * Reconcile a submitted archetype list against the entries on disk
 * (ADR-0091 决议 3 + ADR-0092 扩展). The output order follows the submitted
 * entries; a name that still exists keeps its WHOLE old entry object as the
 * base (level/fit/unknown keys survive untouched), then the submission's
 * EXPLICIT fields override: a valid-enum `fit` replaces the disk fit, a
 * non-blank `level` replaces the disk level. A missing/invalid fit and a
 * blank/missing level keep the disk values (new names default to
 * `fit: "primary"` with no level — that nuance stays hand-editable in
 * profile.yml). Entries may be bare name strings (legacy) or `{name, level?,
 * fit?}` objects. Names are trimmed, blank items dropped, duplicates deduped
 * to the first occurrence.
 *
 * Matching identity is normalized on BOTH sides — submitted names are trimmed
 * strings, so disk names are matched by `String(name).trim()` while the
 * preserved entry keeps its original `name` untouched (a hand-written
 * `" TechLead "` or YAML-typed numeric name survives verbatim).
 *
 * @param {unknown[]} existing entries on disk (malformed shapes tolerated)
 * @param {unknown[]} entries the submitted list (strings or objects, junk tolerated)
 * @returns {Record<string, unknown>[]}
 */
export function reconcileArchetypes(existing, entries) {
  const clean = [];
  const seen = new Set();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const { name, level, fit } = normalizeArchetypeEntry(raw);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    clean.push({ name, level, fit });
  }
  const byName = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    if (typeof e.name !== "string" && typeof e.name !== "number" && typeof e.name !== "boolean") continue;
    const key = typeof e.name === "string" ? e.name.trim() : String(e.name);
    if (key === "" || byName.has(key)) continue;
    byName.set(key, e);
  }
  return clean.map(({ name, level, fit }) => {
    const old = byName.get(name);
    if (!old) {
      const next = { name, fit: ARCHETYPE_FIT_VALUES.includes(fit) ? fit : "primary" };
      if (level) next.level = level;
      return next;
    }
    // 旧条目整份浅拷贝作 base（unknown keys 不丢、不改动磁盘对象），再按
    // 提交显式覆盖（ADR-0092）：UI 显示什么就存什么，未暴露的键原样保留。
    const next = { ...old };
    if (ARCHETYPE_FIT_VALUES.includes(fit)) next.fit = fit;
    if (level) next.level = level;
    return next;
  });
}
