import { readBlacklist, readPreambleAndRows, writeBlacklist, mutators, localTodayStr, type BlacklistRow } from "@/lib/blacklist-store";

// Company blacklist management (ADR-0084). GET lists entries with joined
// evidence; POST adds, DELETE removes, PATCH sets/clears the `Exempt until`
// date. Every write snapshots the data layer to the shadow ledger first (via
// the store) and never touches scoring — the blacklist is a gate, not a signal.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// `today` is the USER's calendar day (lib/local-today.mjs), never the UTC day:
// the exemption window is compared against local dates, and the UTC answer is
// off by one for the first/last hours of the day (#2765, #2932).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function parseBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function bad(msg: string) {
  return Response.json({ error: msg }, { status: 400 });
}

export async function GET() {
  const today = await localTodayStr();
  const { entries, totalBlocked } = await readBlacklist(today);
  return Response.json({ today, totalBlocked, entries });
}

export async function POST(req: Request) {
  const body = await parseBody(req);
  if (!body) return bad("bad json");
  const company = String(body.company ?? "").trim();
  const reason = String(body.reason ?? "").trim();
  if (!company) return bad("company is required");
  if (!reason) return bad("reason is required");
  const exemptUntil = String(body.exemptUntil ?? "").trim();
  if (exemptUntil && !DATE_RE.test(exemptUntil)) return bad("exemptUntil must be YYYY-MM-DD or empty");

  const { preamble, rows } = await readPreambleAndRows();
  const { addRow } = await mutators();
  const next: BlacklistRow[] = addRow(rows, {
    company,
    since: String(body.since ?? "").trim() || (await localTodayStr()),
    scope: String(body.scope ?? "").trim() || "company",
    exemptUntil,
    reason,
  });
  if (next.length === rows.length) return bad("该公司已存在");
  try {
    await writeBlacklist(preamble, next);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const body = await parseBody(req);
  const company = String(body?.company ?? "").trim();
  if (!company) return bad("company is required");
  const { preamble, rows } = await readPreambleAndRows();
  const { removeRow } = await mutators();
  const next = removeRow(rows, company);
  if (next.length === rows.length) return bad("未找到该公司");
  try {
    await writeBlacklist(preamble, next);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return Response.json({ ok: true });
}

export async function PATCH(req: Request) {
  const body = await parseBody(req);
  if (!body) return bad("bad json");
  const company = String(body.company ?? "").trim();
  if (!company) return bad("company is required");
  const exemptUntil = String(body.exemptUntil ?? "").trim();
  if (exemptUntil && !DATE_RE.test(exemptUntil)) return bad("exemptUntil must be YYYY-MM-DD or empty");
  const { preamble, rows } = await readPreambleAndRows();
  const { setExempt } = await mutators();
  if (!rows.some((r) => r.company === company)) return bad("未找到该公司");
  const next = setExempt(rows, company, exemptUntil);
  try {
    await writeBlacklist(preamble, next);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return Response.json({ ok: true });
}
