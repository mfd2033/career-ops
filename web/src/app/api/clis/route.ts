import { NextResponse } from "next/server";
import { detectClisCached } from "@/lib/clis";

export const dynamic = "force-dynamic";

// Detects which agnostic CLIs are installed on THIS machine (local-first). The
// web delegates career-ops to one of these in headless mode, on the user's own
// auth/tokens — no API key needed.
//
// ADR-0015: results are cached for the server process lifetime. A plain GET
// answers from cache (the first request after startup performs the real scan);
// `?refresh=1` — the config page's manual re-check button — invalidates it and
// really rescans, including opencode's cached model list.
export async function GET(request: Request) {
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  return NextResponse.json({ clis: detectClisCached({ refresh }) });
}
