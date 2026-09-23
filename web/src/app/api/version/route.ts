import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { resolveVersionChannels, SERVER_CAPABILITIES } from "@/lib/version-info.mjs";

// The WEB build's own version + channel (NOT the user's data checkout) — read from
// the repo's VERSION (parent of the web/ cwd). The channel is derived from a
// pre-release suffix (`-rc`/`-beta`) so the UI can show a beta banner + the bug
// reporter can tag the right release. Invisible to stable installs (the updater
// reads VERSION from `main`, which stays stable while the bundle lives on a branch).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function readVersion(): string {
  const candidates = [path.join(process.cwd(), "..", "VERSION"), path.join(process.cwd(), "VERSION")];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, "utf8").split(/\s+/)[0].trim();
      if (v) return v;
    } catch {
      /* next candidate */
    }
  }
  return "";
}

function shortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

// Packaged builds (career-dashboard-ui.exe) are stamped by the packer with a
// build-info.json in the server cwd: the sha it was built FROM and when. This
// must WIN over the runtime git call below — the exe's cwd sits inside the
// user's checkout, where `git rev-parse` would report the working tree's CURRENT
// commit, making a stale exe look fresh. Dev mode has no build-info.json → git.
type BuildInfo = { sha?: string; builtAt?: string; cacheVersion?: string; coreVersion?: string };
function readBuildInfo(): BuildInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "build-info.json"), "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

function webVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch {
    return "";
  }
}

export async function GET() {
  const buildInfo = readBuildInfo();
  // coreVersion / channel / version folding lives in a pure module so the
  // packaged-vs-dev precedence is unit-tested without booting a server (#8).
  const { version, coreVersion, channel } = resolveVersionChannels({
    fileVersion: readVersion(),
    buildInfoCoreVersion: buildInfo?.coreVersion,
    webVersion: webVersion(),
  });
  return Response.json({
    version,
    coreVersion,
    channel,
    // packaged build → the sha/timestamp frozen at pack time; dev → live git
    sha: buildInfo?.sha ?? shortSha(),
    builtAt: buildInfo?.builtAt,
    packaged: !!buildInfo,
    // ADR-0051 决议 11：能力协商走这里，不走 /api/config（那个是用户可变存储）。
    // 老服务端没这个键 → 扩展读不到能力 → 自己回落批量路。
    capabilities: SERVER_CAPABILITIES,
  });
}
