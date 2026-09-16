import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { upsertYamlList } from "@/lib/core/portals-merge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Writer for portals.yml's title_filter (a USER-LAYER file), driven by the
// assistant's setProfile/setPortals on confirm.
//
// Two rules, both learned the hard way:
//
//   • APPEND, don't replace. This used to assign `tf.positive = roles`, so every
//     save from the config page / assistant silently deleted the user's own
//     hand-written words. Those words are targeting decisions, not defaults —
//     「刻意不用裸「项目经理/PM」——否则「工程项目经理」(土建) 会一并进来」 — and the
//     user has no way to notice they were dropped. Merging keeps the older
//     behaviour's point (a first-time user gets a working list with zero
//     configuration) without throwing away anything they wrote.
//     The one exception is a file we are creating: seeding from
//     templates/portals.example.yml replaces its placeholder roles, because those
//     words are ours, not theirs.
//
//   • Don't round-trip the document. `yaml.load` + `yaml.dump` deletes every
//     comment in the file, so the write goes through a text-level splice instead
//     (lib/core/portals-merge.mjs). Everything outside the block being written
//     stays byte-for-byte as the user left it.

/** Read a file, or "" when it isn't there / isn't readable. */
function readIfThere(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export async function POST(req: Request) {
  let body: { roles?: string[]; location?: string[] };
  try {
    body = (await req.json()) as { roles?: string[]; location?: string[] };
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const roles = (Array.isArray(body.roles) ? body.roles : []).map((r) => String(r).trim()).filter(Boolean).slice(0, 24);
  // No roles is a no-op, never a clear: returning here is what keeps an empty
  // list from wiping a word list the user spent time on.
  if (roles.length === 0) return Response.json({ error: "no roles" }, { status: 400 });

  const root = careerOpsRoot();
  const file = path.join(root, "portals.yml");
  const existing = readIfThere(file);
  const seeding = !existing.trim();
  const base = seeding ? readIfThere(path.join(root, "templates", "portals.example.yml")) : existing;

  const titleStep = upsertYamlList(base, ["title_filter", "positive"], roles, { mode: seeding ? "replace" : "append" });
  let text = titleStep.text;

  const cities = (Array.isArray(body.location) ? body.location : []).map((l) => String(l).trim()).filter(Boolean);
  if (cities.length) {
    // The location tier keeps its old semantics (the stated cities ARE the
    // allowed set) — only the way it is written changed, so its comments live too.
    text = upsertYamlList(text, ["location_filter", "allow"], cities, { mode: "replace" }).text;
  }

  if (text === existing) {
    // Nothing to add (every role was already there). Skipping the write keeps the
    // file's mtime and the backup chain free of no-op churn.
    return Response.json({ ok: true, changed: false, roles: roles.length, added: [], skipped: titleStep.skipped });
  }

  try {
    atomicWriteWithBackup(file, text);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
  return Response.json({ ok: true, changed: true, roles: roles.length, added: titleStep.added, skipped: titleStep.skipped });
}
