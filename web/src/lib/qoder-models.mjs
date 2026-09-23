import { execFileSync } from "node:child_process";

// Qoder CN's model catalogue, as the CLI itself reports it (ADR-0052 决议 7-9).
//
// WHY NOT A STATIC LIST: `--list-models` is the authority and it moves with the
// service, not with this repo. A transcribed copy would silently offer models
// that no longer exist (or hide new ones) — and the ONE place that matters is
// the config page, where a stale choice rides into a run as `--model <name>`.
// Measured on v1.1.41: an unknown model name does not fail the run, the CLI
// prints a warning and silently falls back to `auto` — so a stale list would
// not even announce itself, the user would just quietly get a different model.
//
// The list requires a login: unauthenticated, `--list-models` writes "Not logged
// in. Run `qoderclicn login` to authenticate." to stderr and produces no stdout.
// There is no config-file equivalent to fall back on (the opencode module reads
// `opencode.jsonc` when its command fails; Qoder keeps no such readable list),
// so the answer in that case is an EMPTY list — the config page renders a note,
// and no static copy is invented to fill the gap.

/**
 * Parse `qoderclicn --list-models` output: a header row followed by one model
 * display name per line.
 *
 * The header is `MODEL`. Skipping a first line that reads exactly that is safe:
 * a model would have to be named "MODEL" for this to misfire, and the CLI
 * prints the header unconditionally (measured v1.1.41).
 *
 * @param {unknown} output
 * @returns {{id: string, label: string}[]} names in the CLI's own order, deduped
 */
export function parseQoderModelsOutput(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const body = lines[0]?.toUpperCase() === "MODEL" ? lines.slice(1) : lines;
  const seen = new Set();
  const models = [];
  for (const name of body) {
    if (seen.has(name)) continue;
    seen.add(name);
    // id === label: `--model` takes the display name verbatim ("Qwen3.8-Flash"),
    // so there is no separate slug to translate.
    models.push({ id: name, label: name });
  }
  return models;
}

let commandCache = null;
let commandCacheAt = 0;
const COMMAND_CACHE_TTL_MS = 60_000;

/**
 * Drop the cache so the next loadQoderModels() spawns the subprocess again.
 * Called by detectClisCached({ refresh: true }) — a manual re-check must mean
 * "really query", not "reuse a result younger than the TTL" (ADR-0015).
 */
export function resetQoderModelCache() {
  commandCache = null;
  commandCacheAt = 0;
}

/**
 * The models Qoder CN actually offers right now.
 *
 * Cached for a minute so the config page's /api/clis calls don't spawn a
 * subprocess each. A failure is NOT cached: the reason (not signed in, offline)
 * can change between two page loads, and caching an empty list would hide the
 * catalogue for a minute after a login.
 *
 * @param {string} [binPath] - the resolved qoderclicn executable
 * @param {typeof execFileSync} [exec] - injected so the cache/refresh contract
 *   is unit-testable without spawning anything
 * @returns {{id: string, label: string}[]} empty when the CLI cannot answer
 */
export function loadQoderModels(binPath, exec = execFileSync) {
  if (commandCache && Date.now() - commandCacheAt < COMMAND_CACHE_TTL_MS) {
    return commandCache;
  }
  try {
    const out = exec(binPath || "qoderclicn", ["--list-models"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      // stderr is the login prompt, not something to relay into a web response.
      stdio: ["ignore", "pipe", "ignore"],
    });
    const models = parseQoderModelsOutput(out);
    if (models.length > 0) {
      commandCache = models;
      commandCacheAt = Date.now();
      return models;
    }
  } catch {
    // Not signed in / offline / not installed → no claim about the catalogue.
  }
  return [];
}
