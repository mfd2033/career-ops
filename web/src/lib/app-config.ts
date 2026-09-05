// Server-side mirror of the web config the extension needs to "reuse the
// configured CLI + model": the config page keeps cliId/model in localStorage
// (saved-cli.ts), which a browser extension on a different origin CANNOT read.
// When the user picks a CLI/model there, saved-cli.ts POSTs the pair here; the
// extension (and the /api/config route) reads it back. Kept OUTSIDE the
// career-ops checkout so it survives across installs and never pollutes the
// user's data repo. Absent file → empty config (fallback picks sole installed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type AppConfig = { cliId?: string; model?: string };

/** Persistent location for the salvageable web-level config (not the checkout). */
export function appConfigPath(): string {
  return path.join(os.homedir(), ".career-ops-web", "config.json");
}

export function readAppConfig(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(appConfigPath(), "utf8"));
    const out: AppConfig = {};
    if (typeof raw.cliId === "string" && raw.cliId) out.cliId = raw.cliId;
    if (typeof raw.model === "string" && raw.model) out.model = raw.model;
    return out;
  } catch {
    return {};
  }
}

export function writeAppConfig(cfg: AppConfig): AppConfig {
  const dir = path.dirname(appConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(appConfigPath(), JSON.stringify(cfg, null, 2));
  return cfg;
}