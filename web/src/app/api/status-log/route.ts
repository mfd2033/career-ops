import { NextResponse } from "next/server";
import { readStatusLog } from "@/lib/career-ops";
import { statusEventsFromStatusLog } from "@/lib/status-log.mjs";
import { trackerRowArg } from "@/lib/status-cli.mjs";

export const runtime = "nodejs"; // reads the user-layer ledger off disk
export const dynamic = "force-dynamic";

// Read-only: the transition ledger for ONE tracker row, newest first. The
// report page's status-history popup calls this on open — the same append-only
// data/status-log.tsv every writer (set-status.mjs, the web's /api/status)
// already maintains, so nothing here can drift from the tracker's own history.
//
// No spawn, no lock: reading the ledger is not the write path (compare
// /api/status). A row with no entries — bulk-seeded before the ledger existed —
// is a legitimate empty result, not a 404.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("n") ?? "";
  const row = trackerRowArg(raw);
  if (!row) {
    return NextResponse.json({ error: "n must be a tracker row number" }, { status: 400 });
  }
  const events = statusEventsFromStatusLog(readStatusLog() ?? "", row);
  return NextResponse.json({ n: Number.parseInt(row, 10), events });
}