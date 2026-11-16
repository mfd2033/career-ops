import { NextResponse } from "next/server";
import { detectClisCached, refreshSingleCliModels } from "@/lib/clis";

export const dynamic = "force-dynamic";

// Detects which agnostic CLIs are installed on THIS machine (local-first). The
// web delegates career-ops to one of these in headless mode, on the user's own
// auth/tokens — no API key needed.
//
// ADR-0015: results are cached for the server process lifetime. A plain GET
// answers from cache (the first request after startup performs the real scan);
// `?refresh=1` — the config page's manual re-check button — invalidates it and
// really rescans, including opencode's cached model list.
//
// `?refresh=1&cli=<id>` — the config page's per-tool "refresh model list"
// button — re-reads ONLY that engine's model catalogue and splices the result
// back into the detection cache. No `--version` probes for the other engines.
// Returns just that one engine's entry; unknown ids get a 400 (falling back to
// a full sweep here would silently turn "refresh one tool" into "rescan all").
//
// ADR-0098: the scan is async (each engine's `--version`, the model catalogues and
// the WorkBuddy registry lookup are child processes). Waiting for this response no
// longer freezes `/api/version` — the tray's 2.5s probe and the extension's 6s
// probe stay green while a re-check runs.
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const refresh = params.get("refresh") === "1";
  const cli = params.get("cli");
  if (refresh && cli) {
    const fresh = await refreshSingleCliModels(cli);
    if (!fresh) return NextResponse.json({ error: "unknown-cli" }, { status: 400 });
    return NextResponse.json({ clis: [fresh] });
  }
  return NextResponse.json({ clis: await detectClisCached({ refresh }) });
}
