import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, listMarketModes } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { mergeYamlPatch } from "@/lib/core/profile-merge.mjs";
import { extractArchetypes, patchToProfile } from "@/lib/profile-patch.mjs";
import { extractDealBreakers, replaceDealBreakersSection } from "@/lib/profile-md-sync.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Merge-safe writer for config/profile.yml (a USER-LAYER file — DATA_CONTRACT:
// never clobber the user's narrative/proof-points, and archetypes only through
// ADR-0091's name-reconciled path: the job-target card may replace the NAME
// list, but an existing entry keeps its whole object — level/fit/unknown keys
// survive; anything else leaves archetypes untouched). On first create we
// seed from config/profile.example.yml; on an existing file we deep-merge ONLY
// the proposed keys, write atomically (temp + rename), and only ever via the
// confirm-gated setProfile action. The web orchestrates the real file — no
// parallel store.

type ProfilePatch = {
  name?: string;
  email?: string;
  location?: string;
  roles?: string[];
  compMin?: number;
  compMax?: number;
  currency?: string;
  remote?: string;
  /** JD evaluation/exclusion rules (config page). string[] → narrative.deal_breakers. */
  dealBreakers?: string[];
  /** JD evaluation/exclusion rules (config page). string → compensation.location_flexibility. */
  locationFlexibility?: string;
  /** 评估模式（CO-51）：`modes/<lang>`；"root" / 空串 = 清空回通用模式。 */
  marketMode?: string;
  /** 原型名单（ADR-0091）：undefined = 不动；空数组 = 删键；非空 = 按名 reconcile。 */
  archetypes?: string[];
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge src onto dst (objects recurse; arrays/scalars replace). Non-mutating. */
function deepMerge(dst: unknown, src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isObj(dst) ? { ...dst } : {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = isObj(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** Read the current JD evaluation/exclusion rules out of config/profile.yml
 *  so the config page can prefill its form. Best-effort: any parse/read failure
 *  yields the empty defaults, never a throw — a malformed profile is surfaced
 *  by POST's DATA-LOSS GUARD, not by this read path. */
export async function GET() {
  const root = careerOpsRoot();
  const file = path.join(root, "config", "profile.yml");
  let dealBreakers: string[] = [];
  let locationFlexibility = "";
  let roles: string[] = [];
  let archetypes: Record<string, unknown>[] = [];
  let marketMode: string | null = null;
  if (fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(file, "utf8"));
    } catch {
      parsed = undefined;
    }
    const profile = isObj(parsed) ? (parsed as Record<string, unknown>) : {};
    const narrative = isObj(profile.narrative) ? (profile.narrative as Record<string, unknown>) : {};
    if (Array.isArray(narrative.deal_breakers)) {
      dealBreakers = (narrative.deal_breakers as unknown[]).filter((b): b is string => typeof b === "string");
    }
    const comp = isObj(profile.compensation) ? (profile.compensation as Record<string, unknown>) : {};
    if (typeof comp.location_flexibility === "string") locationFlexibility = comp.location_flexibility;
    const targets = isObj(profile.target_roles) ? (profile.target_roles as Record<string, unknown>) : {};
    if (Array.isArray(targets.primary)) {
      roles = (targets.primary as unknown[]).filter((r): r is string => typeof r === "string");
    }
    archetypes = extractArchetypes(profile);
    const language = isObj(profile.language) ? (profile.language as Record<string, unknown>) : {};
    if (typeof language.modes_dir === "string" && language.modes_dir.trim()) {
      marketMode = language.modes_dir.trim();
    }
  }
  // `modes/_profile.md` is ALSO read by the evaluation pipeline (SKILL.md loads
  // it for every mode; context-budget injects both files). A rule hand-written
  // there but absent from profile.yml would be silently dropped by the next web
  // save if the form only showed profile.yml — so prefill the union (profile.yml
  // first, order preserved, deduped) and let Save write both back.
  const profileMd = path.join(root, "modes", "_profile.md");
  if (fs.existsSync(profileMd)) {
    const md = fs.readFileSync(profileMd, "utf8");
    const mdBreakers = extractDealBreakers(md);
    if (mdBreakers.length) {
      const merged = [...dealBreakers];
      for (const b of mdBreakers) if (!merged.includes(b)) merged.push(b);
      dealBreakers = merged;
    }
  }
  return Response.json({ dealBreakers, locationFlexibility, roles, archetypes, marketMode, marketModes: listMarketModes() });
}

export async function POST(req: Request) {
  let patch: ProfilePatch;
  try {
    patch = (await req.json()) as ProfilePatch;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const root = careerOpsRoot();
  const file = path.join(root, "config", "profile.yml");
  // ADR-0091: only a patch that carries an archetype list needs the on-disk
  // entries to reconcile against; a roles-only save keeps its old cheap path.
  // Malformed YAML refuses here already (the same guard the merge re-checks).
  let existingArchetypes: Record<string, unknown>[] = [];
  if (Array.isArray(patch.archetypes) && fs.existsSync(file)) {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(file, "utf8"));
    } catch {
      return Response.json({ error: "config/profile.yml exists but is not valid YAML — refusing to overwrite it." }, { status: 409 });
    }
    existingArchetypes = extractArchetypes(parsed);
  }
  const proposed = patchToProfile(patch, existingArchetypes);
  if (Object.keys(proposed).length === 0) return Response.json({ error: "nothing to write" }, { status: 400 });

  let next: string;
  let seeded = false;
  let changed = true;
  // DATA-LOSS GUARD (maintainer, bug-class #649/#704/#920/#958): distinguish
  // "no profile yet" (safe to seed from the example) from "profile EXISTS but is
  // malformed" (NEVER overwrite — that would silently destroy the user's data).
  if (!fs.existsSync(file)) {
    let base: Record<string, unknown> = {};
    try {
      base = (yaml.load(fs.readFileSync(path.join(root, "config", "profile.example.yml"), "utf8")) as Record<string, unknown>) || {};
      seeded = Object.keys(base).length > 0;
    } catch {
      base = {};
    }
    // First create: there is no file, so there are no comments to lose — a
    // normalized dump is the right shape for a freshly seeded profile.
    next = yaml.dump(deepMerge(base, proposed), { lineWidth: 100, noRefs: true });
  } else {
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
      yaml.load(text);
    } catch {
      return Response.json({ error: "config/profile.yml exists but is not valid YAML — refusing to overwrite it." }, { status: 409 });
    }
    // Text-level splice, NOT load→dump: profile.yml is the user layer and its
    // comments are the rationale for the settings. A round-trip deletes every
    // one of them and nothing on screen says it happened (see profile-merge.mjs).
    const merged = mergeYamlPatch(text, proposed);
    if (merged.skipped.length) {
      // The patch asked to replace real content with a shape we cannot guarantee
      // (e.g. a whole mapping became a string). Refuse rather than guess.
      return Response.json(
        { error: `refusing to overwrite ${merged.skipped.join(", ")}: the existing value has a different shape` },
        { status: 409 },
      );
    }
    next = merged.text;
    changed = merged.changed;
  }
  if (changed) {
    try {
      atomicWriteWithBackup(file, next);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
    }
  }

  // Mirror the deal-breakers into modes/_profile.md — the evaluation pipeline
  // reads that file too (SKILL.md loads it for every mode). Only when this
  // patch actually carried deal-breakers, and only by rewriting the
  // "## Your Deal-Breakers" section: never fabricate it, never touch the rest.
  const narrative = isObj(proposed.narrative) ? (proposed.narrative as Record<string, unknown>) : {};
  if (Array.isArray(narrative.deal_breakers)) {
    const profileMd = path.join(root, "modes", "_profile.md");
    if (fs.existsSync(profileMd)) {
      try {
        const md = fs.readFileSync(profileMd, "utf8");
        const { markdown, found } = replaceDealBreakersSection(md, narrative.deal_breakers as string[]);
        if (found) atomicWriteWithBackup(profileMd, markdown);
      } catch (e) {
        return Response.json(
          {
            error: `profile.yml saved, but could not sync modes/_profile.md: ${e instanceof Error ? e.message : "write failed"}`,
          },
          { status: 500 },
        );
      }
    }
  }
  return Response.json({ ok: true, seeded });
}
