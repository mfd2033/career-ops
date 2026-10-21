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
 * }} patch
 * @returns {Record<string, unknown>}
 */
export function patchToProfile(patch) {
  const out = {};
  const candidate = {};
  if (patch.name) candidate.full_name = patch.name;
  if (patch.email) candidate.email = patch.email;
  if (patch.location) candidate.location = patch.location;
  if (Object.keys(candidate).length) out.candidate = candidate;
  if (patch.roles?.length) out.target_roles = { primary: patch.roles.slice(0, 6) };

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
