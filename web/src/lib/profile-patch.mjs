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
 *   archetypes?: string[];
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
 * Reconcile a submitted archetype NAME list against the entries on disk
 * (ADR-0091 决议 3). The output order follows the submitted names; a name that
 * still exists keeps its WHOLE old entry object (level/fit/unknown keys
 * survive untouched); a new name becomes `{name, fit: "primary"}` with no
 * level (that nuance stays hand-editable in profile.yml). Names are trimmed,
 * blank items dropped, duplicates deduped to the first occurrence.
 *
 * Matching identity is normalized on BOTH sides — submitted names are trimmed
 * strings, so disk names are matched by `String(name).trim()` while the
 * preserved entry keeps its original `name` untouched (a hand-written
 * `" TechLead "` or YAML-typed numeric name survives verbatim).
 *
 * @param {unknown[]} existing entries on disk (malformed shapes tolerated)
 * @param {unknown[]} names the submitted list (non-strings tolerated)
 * @returns {Record<string, unknown>[]}
 */
export function reconcileArchetypes(existing, names) {
  const clean = [...new Set((Array.isArray(names) ? names : []).map((n) => String(n ?? "").trim()).filter(Boolean))];
  const byName = new Map();
  for (const e of Array.isArray(existing) ? existing : []) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    if (typeof e.name !== "string" && typeof e.name !== "number" && typeof e.name !== "boolean") continue;
    const key = typeof e.name === "string" ? e.name.trim() : String(e.name);
    if (key === "" || byName.has(key)) continue;
    byName.set(key, e);
  }
  return clean.map((name) => byName.get(name) ?? { name, fit: "primary" });
}
