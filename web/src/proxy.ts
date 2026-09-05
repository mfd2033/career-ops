import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRequest, parseAllowedHosts } from "@/lib/origin-guard.mjs";
import { EXTENSION_ORIGIN } from "@/lib/extension-origin.mjs";

// Single choke point over the API surface. Every /api request is gated on the
// same-origin + loopback guard before it can reach a route handler (which may
// spawn a child process or write the user's files). See origin-guard.mjs for
// the two-layer rationale (F1 drive-by CSRF, F2 LAN reachability).
//
// Opt in to extra hosts (e.g. a trusted LAN box) with a comma/space separated
// CAREER_OPS_WEB_ALLOWED_HOSTS; unset means loopback only.
//
// Extension pass: the BOSS直聘 MV3 extension (fixed ID, see extension-origin.mjs)
// reaches /api cross-site from chrome-extension://{id}. origin-guard admits it
// on loopback + matching origin; here we echo the CORS header and answer the
// preflight (for callers not covered by the extension's own host_permissions).
const extensionOrigins = new Set([EXTENSION_ORIGIN]);

export function proxy(req: NextRequest) {
  const decision = checkRequest({
    secFetchSite: req.headers.get("sec-fetch-site"),
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
    allowedHosts: parseAllowedHosts(process.env.CAREER_OPS_WEB_ALLOWED_HOSTS),
    extensionOrigins,
  });
  if (!decision.ok) {
    return NextResponse.json({ error: decision.reason }, { status: decision.status });
  }

  // Cross-site extension call admitted: answer the OPTIONS preflight (batched
  // jobs POST JSON, which preflights) and echo the extension origin as the CORS
  // allow origin on the real response. Headers are scoped to the trusted
  // extension origin only — never `*`, never the page's own origin.
  const extAllowOrigin = (decision as { extensionAllowOrigin?: string }).extensionAllowOrigin;
  if (extAllowOrigin) {
    const acao = extAllowOrigin;
    if (req.method === "OPTIONS") {
      return new NextResponse(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": acao,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "content-type",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    const res = NextResponse.next();
    res.headers.set("Access-Control-Allow-Origin", acao);
    return res;
  }

  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };