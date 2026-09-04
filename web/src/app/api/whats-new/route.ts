import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readApplications } from "@/lib/career-ops";
import { getNormalizeTextKey } from "@/lib/core/text-key";
import type { DiscoveredOffer } from "@/lib/explore";
import { collectWhatsNew, resolveOfferLimit } from "@/lib/whats-new.mjs";
import { normalizeUrl, rowToOfferOrNull } from "@/lib/whats-new-filter.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The SUPPLY loop, ZERO tokens: "new matches this week" = roles surfaced by past
// free scans (data/scan-history.tsv) in the last N days that the user hasn't
// evaluated yet. No scan runs here — it reads the history a past scan already
// wrote, so the home stays instant + free (directly answers the #1 token-cost
// complaint). cols: url, first_seen, portal, title, company, status, location.
// Company matching keys come from the CORE (see lib/core/text-key.ts), never a
// local reimplementation. The previous ASCII-only key deleted every non-Latin
// letter, so "Škoda" collided with "Koda" — suppressing a real offer as
// "already evaluated" — and "日本電産" keyed to the empty string (#2666).

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const days = Math.min(30, Math.max(1, Number(searchParams.get("days")) || 7));
  // Home only needs enough offers for its cards; Explore's “See all” hand-off
  // asks for more. Both stay finite — `count` is always complete, so the true
  // total is free while the rendered list keeps a ceiling (see MAX_OFFER_LIMIT).
  const offerLimit = resolveOfferLimit(searchParams.get("limit"));
  const cutoff = Date.now() - days * 86_400_000;
  let rows: string[];
  try {
    rows = fs.readFileSync(path.join(careerOpsRoot(), "data", "scan-history.tsv"), "utf8").split("\n");
  } catch {
    return Response.json({ offers: [], count: 0 });
  }

  // Already-evaluated postings → don't resurface as "new". Keyed TWO ways so
  // neither gap leaks: by company (a scan row with a company name matches a
  // tracker row whose URL column is absent) and by URL (a scan row with an
  // empty company column — browser-mode boards like 智联/BOSS record no
  // company — still matches the tracker row for the exact posting). Both sides
  // go through the same canonical key (normalizeTextKey / normalizeUrl), so
  // name case/punct and scheme/host/trailing-slash drift cannot hide an
  // evaluated posting. NOTE: normalizeUrl strips only campaign params (utm_*,
  // gh_src, …); a posting URL that grew a non-campaign param (e.g. zhipin's
  // securityId=…) after evaluation keys differently and is only caught by the
  // company dimension — acceptable, since browser-board rows carry no company
  // and their scan URL is the clean base link recorded at discovery time.
  const normalizeTextKey = await getNormalizeTextKey();
  const norm = (s: string) => normalizeTextKey(s, " ");
  const apps = readApplications();
  const evaluated = new Set(apps.map((a) => norm(a.company)).filter(Boolean));
  const evaluatedUrls = new Set(apps.map((a) => normalizeUrl(a.url)).filter(Boolean));
  // rowToOfferOrNull is a plain .mjs export (no type annotations) whose return
  // shape is exactly DiscoveredOffer — the tracked fields line up 1:1.
  const toOffer = (c: string[]): DiscoveredOffer | null =>
    rowToOfferOrNull({ norm, evaluated, evaluatedUrls }, c) as DiscoveredOffer | null;

  const { offers, count } = collectWhatsNew(rows, { cutoff, toOffer, offerLimit });
  return Response.json({ offers, count });
}
