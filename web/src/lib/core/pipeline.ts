import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { normalizeUrl } from "./url-key.mjs";
import type { DiscoveredOffer } from "./scan";

/**
 * The canonical core writers (scan.mjs `appendToPipeline` / `appendToScanHistory`)
 * invoked in a short-lived node process (cwd = the user's career-ops root), so the
 * core owns the line format / section markers and the web never keeps a parallel
 * copy. No tokens are spent here.
 *
 * ADR-0021 splits the two writes into independent moments:
 *   - 采集（collection）records ONLY the seen ledger (scan-history.tsv) — via
 *     `recordSeenOffers`. A discovered posting is "seen", never auto-queued.
 *   - 确认（confirm）writes pipeline.md — via `addOffersToPipeline`. For offers
 *     already in the seen ledger (`skipScanHistory`) it must NOT append a second
 *     scan-history row: `appendToScanHistory` does not dedupe.
 */
export type AddResult = { added: number; error?: string };
type WriterMode = "both" | "pipeline" | "history";

export type AddOptions = { skipScanHistory?: boolean };

/** url/company/title/location/source の sane defaults — the writers' input contract. */
function cleanOffers(offers: DiscoveredOffer[]) {
  return offers
    .filter((o) => o && typeof o.url === "string" && /^https?:\/\//i.test(o.url))
    .map((o) => ({
      url: o.url,
      company: o.company || "",
      title: o.title || "",
      location: o.location || "",
      source: o.source || o.ats || "explorer",
      // Preserve the optional per-offer signal so it survives to pipeline.md.
      // The core writer treats an empty note as absent (byte-identical output).
      // Browser-mode salary rides the note (工单 03) — the canonical writer has
      // no dedicated salary column; the raw text (or a 「薪资未知」 marker when
      // a floor gate was active but the text parsed to nothing) is appended.
      note: [o.note, o.salaryText || (o.salaryUnknown ? "薪资未知" : "")].filter(Boolean).join(" · "),
    }));
}

function runWriter(offers: DiscoveredOffer[], mode: WriterMode): Promise<AddResult> {
  const clean = cleanOffers(offers);
  if (clean.length === 0) return Promise.resolve({ added: 0 });

  // Data-only / pre-scan-ats checkout has no scan.mjs writers → fail with an
  // actionable message instead of a silent added:0.
  if (!fs.existsSync(rootScript("scan"))) {
    return Promise.resolve({ added: 0, error: "This checkout is data-only — the pipeline writer (scan.mjs) isn't available." });
  }

  const scanUrl = pathToFileURL(rootScript("scan")).href;
  const localTodayUrl = pathToFileURL(path.join(careerOpsRoot(), "lib", "local-today.mjs")).href;
  const code = `
import { appendToPipeline, appendToScanHistory } from ${JSON.stringify(scanUrl)};
import { localToday } from ${JSON.stringify(localTodayUrl)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", async () => {
  try {
    const { offers, mode } = JSON.parse(input);
    // LOCAL calendar day, not the UTC one — west of Greenwich, an evening
    // add would otherwise stamp scan-history.tsv's first_seen a day ahead,
    // opening scan.mjs's recheck/cooldown gate a day late for this row (#3070).
    const date = localToday();
    if (mode !== "pipeline") await appendToScanHistory(offers, date, "added");
    if (mode !== "history") await appendToPipeline(offers);
    process.stdout.write(JSON.stringify({ added: offers.length }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ added: 0, error: String((e && e.message) || e) }));
  }
});
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ added: 0, error: e instanceof Error ? e.message : "spawn failed" }));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim() || "{}") as AddResult;
        resolve({ added: parsed.added ?? 0, error: parsed.error });
      } catch {
        resolve({ added: 0, error: err.trim().slice(0, 200) || "writer returned no result" });
      }
    });
    child.stdin.write(JSON.stringify({ offers: clean, mode }));
    child.stdin.end();
  });
}

/** 确认入管（ADR-0021）：写 pipeline.md；`skipScanHistory` 用于已在见过台账里的
 *  offer（采集阶段已记过，再写就是重复行）。 */
export function addOffersToPipeline(offers: DiscoveredOffer[], opts?: AddOptions): Promise<AddResult> {
  return runWriter(offers, opts?.skipScanHistory ? "pipeline" : "both");
}

/** 采集记「见过」（ADR-0021）：只写 scan-history.tsv，绝不碰 pipeline.md。 */
export function recordSeenOffers(offers: DiscoveredOffer[]): Promise<AddResult> {
  return runWriter(offers, "history");
}

/** 规范键的「见过」集合 —— data/scan-history.tsv 里出现过的每个职位 URL。
 *  路由侧用它把 offer 切成「已见过（补 pipeline 即可）」与「全新（两处都写）」。 */
export function loadSeenUrlKeys(): Set<string> {
  const keys = new Set<string>();
  let text = "";
  try {
    text = fs.readFileSync(path.join(careerOpsRoot(), "data", "scan-history.tsv"), "utf8");
  } catch {
    return keys; // 首跑无表
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("url\t")) continue;
    const key = normalizeUrl(line.split("\t")[0]);
    if (key) keys.add(key);
  }
  return keys;
}
