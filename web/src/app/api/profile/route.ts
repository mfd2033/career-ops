import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { patchToProfile } from "@/lib/profile-patch.mjs";
import { extractDealBreakers, replaceDealBreakersSection } from "@/lib/profile-md-sync.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Merge-safe writer for config/profile.yml (a USER-LAYER file — DATA_CONTRACT:
// never clobber the user's archetypes/narrative/proof-points). On first create we
// seed from config/profile.example.yml; on an existing file we deep-merge ONLY the
// proposed keys, write atomically (temp + rename), and only ever via the confirm-
// gated setProfile action. The web orchestrates the real file — no parallel store.

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
  return Response.json({ dealBreakers, locationFlexibility, roles });
}

export async function POST(req: Request) {
  let patch: ProfilePatch;
  try {
    patch = (await req.json()) as ProfilePatch;
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const proposed = patchToProfile(patch);
  if (Object.keys(proposed).length === 0) return Response.json({ error: "nothing to write" }, { status: 400 });

  const root = careerOpsRoot();
  const file = path.join(root, "config", "profile.yml");
  let base: Record<string, unknown> = {};
  let seeded = false;
  // DATA-LOSS GUARD (maintainer, bug-class #649/#704/#920/#958): distinguish
  // "no profile yet" (safe to seed from the example) from "profile EXISTS but is
  // malformed" (NEVER overwrite — that would silently destroy the user's data).
  if (!fs.existsSync(file)) {
    try {
      base = (yaml.load(fs.readFileSync(path.join(root, "config", "profile.example.yml"), "utf8")) as Record<string, unknown>) || {};
      seeded = Object.keys(base).length > 0;
    } catch {
      base = {};
    }
  } else {
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(file, "utf8"));
    } catch {
      return Response.json({ error: "config/profile.yml exists but is not valid YAML — refusing to overwrite it." }, { status: 409 });
    }
    base = isObj(parsed) ? (parsed as Record<string, unknown>) : {};
  }

  const merged = deepMerge(base, proposed);
  try {
    // Back up the prior profile before the first normalized write (yaml.dump
    // reformats — comments are not preserved; the .bak is the safety net).
    atomicWriteWithBackup(file, yaml.dump(merged, { lineWidth: 100, noRefs: true }));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
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
