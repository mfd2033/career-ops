import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import * as yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { DEFAULT_FILTERS, cleanChips, type ExploreFilters } from "@/lib/explore";
import { profileTargetKeywords } from "@/lib/profile-keywords.mjs";
import { extractBrowserQuery, browserCityValue } from "../browser-search.mjs";

/**
 * ACL for portals.yml — the core's scan-filter config (a CONTRACT entry-point,
 * see reference_web_core_sync_protocol). The Explorer NEVER mutates the user's
 * real portals.yml: it writes an EPHEMERAL filter file and points the scanner at
 * it via CAREER_OPS_PORTALS, so an ad-hoc search can't clobber the curated config.
 * We also read the real portals.yml + config/profile.yml (tolerantly) only to
 * SEED sensible defaults for the first search.
 *
 * Filter semantics mirror scan.mjs::buildTitleFilter / buildLocationFilter:
 *   title positive → substring match (empty = everything matches)
 *   title negative → substring reject
 *   location block_hard > always_allow > block > allow (case-insensitive substring);
 *   block_hard is the one tier always_allow cannot override (scan.mjs, #2956)
 */
type FilterLists = Pick<ExploreFilters, "positive" | "negative" | "allow" | "block" | "alwaysAllow" | "blockHard">;

function listFrom(v: unknown): string[] {
  return cleanChips(v);
}

// serializePortals lives in portals-serialize.mjs (pure, no TS deps) so the web
// `node --test` suite can load it — the block_hard round-trip (#3102) is exactly
// a "don't silently drop a tier" property that has to be asserted, not eyeballed.
export { serializePortals } from "./portals-serialize.mjs";
import { serializePortals } from "./portals-serialize.mjs";

/** Write the ephemeral filter file to a temp path; caller cleans it up. */
export function writeTempPortals(f: FilterLists): string {
  const file = path.join(os.tmpdir(), `career-ops-explore-${randomUUID()}.yml`);
  fs.writeFileSync(file, serializePortals(f), "utf8");
  return file;
}

export function cleanupTempPortals(file: string): void {
  try {
    if (file.startsWith(os.tmpdir()) && file.includes("career-ops-explore-")) fs.unlinkSync(file);
  } catch {
    /* best-effort */
  }
}

function loadYaml(rel: string): Record<string, unknown> | null {
  try {
    const doc = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8"));
    return doc && typeof doc === "object" ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Tolerantly seed first-search defaults from the user's real config. Reads
 * portals.yml (title_filter / location_filter) and falls back to
 * config/profile.yml (target_roles, location) for the positive keywords when
 * portals has none. Never throws — a bare checkout just yields DEFAULT_FILTERS.
 */
export function seedExploreFilters(): { filters: ExploreFilters; seededFrom: string[] } {
  const filters: ExploreFilters = { ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] };
  const seededFrom: string[] = [];
  // 求职意向（目标职位）一次读好，bsk 关键词框与 ATS 正向关键词都以它为来源；
  // 与核心的 providers/_profile-keywords.mjs 同口径（primary + archetypes.name）。
  const profile = loadYaml("config/profile.yml");
  const fromRoles = listFrom(profileTargetKeywords(profile));

  const portals = loadYaml("portals.yml");
  if (portals) {
    const tf = (portals.title_filter ?? {}) as Record<string, unknown>;
    const lf = (portals.location_filter ?? {}) as Record<string, unknown>;
    filters.positive = listFrom(tf.positive);
    filters.negative = listFrom(tf.negative);
    filters.allow = listFrom(lf.allow);
    filters.block = listFrom(lf.block);
    filters.alwaysAllow = listFrom(lf.always_allow);
    filters.blockHard = listFrom(lf.block_hard);
    if (filters.positive.length || filters.allow.length || filters.block.length || filters.blockHard.length) seededFrom.push("portals.yml");
    // Browser mode's city box: seed from the user's own config — profile.yml
    // location.city first (the ground truth of where they want to work), then
    // portals.yml location_filter.allow (the CLI scan's location filter). Only a
    // KNOWN Chinese city (in BROWSER_CITY_MAP) is used — an unrecognised value
    // keeps the national default rather than silently mis-filtering.
    const profileCity =
      (profile?.candidate && typeof profile.candidate === "object" && (profile.candidate as Record<string, unknown>).location) ||
      (profile?.location && typeof profile.location === "object" && (profile.location as Record<string, unknown>).city);
    const candidateCity = typeof profileCity === "string" ? profileCity.trim() : "";
    const allowList = Array.isArray(lf.allow) ? (lf.allow as unknown[]) : [];
    const allowCity = String(allowList[0] ?? "").trim();
    if (browserCityValue("zhipin", candidateCity)) {
      filters.zhCity = candidateCity;
      seededFrom.push("profile.yml");
    } else if (browserCityValue("zhipin", allowCity)) {
      filters.zhCity = allowCity;
      seededFrom.push("portals.yml");
    }
  }

  // Browser mode's keyword box follows 求职意向（target_roles）：
  // 空集分隔多个候选职位（扫描阶段会把空白展开回 OR，见 runBrowserDiscovery）。
  // 只有 profile 里没有目标职位时才退回 CLI 的 search_queries 意图，保证裸配置不失效。
  if (fromRoles.length) {
    filters.zhQuery = fromRoles.join(" ");
    seededFrom.push("profile.yml");
  } else if (portals) {
    const queries = Array.isArray(portals.search_queries) ? portals.search_queries : [];
    for (const q of queries) {
      if (!q || typeof q !== "object") continue;
      const qr = q as Record<string, unknown>;
      if (qr.enabled === false || typeof qr.query !== "string") continue;
      const extracted = extractBrowserQuery(qr.query);
      if (extracted) {
        filters.zhQuery = extracted;
        seededFrom.push("search_queries");
        break;
      }
    }
  }

  if (filters.positive.length === 0) {
    // Shape-reading lives in profile-keywords.mjs, mirroring the core's
    // providers/_profile-keywords.mjs. Inlined here it had drifted from the
    // core on BOTH fields — `primary` read as a string when it is a list,
    // `archetypes` spread raw when its entries are objects — so this fallback
    // returned nothing for every profile.yml the app itself writes.
    if (fromRoles.length) {
      filters.positive = fromRoles;
      seededFrom.push("profile.yml");
    }
  }

  return { filters, seededFrom };
}

export { listFrom as normalizeKeywords };
