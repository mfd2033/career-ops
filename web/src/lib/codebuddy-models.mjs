import { stdoutOf } from "./exec-async.mjs";
import { spawnTargetFor } from "./spawn-cli.mjs";

// CodeBuddy Code's model catalogue, as the CLI itself reports it.
//
// WHY NOT ONLY A STATIC LIST: the catalogue is owned by the CLI and it moves
// with the service, not with this repo (ADR-0052 决议 9 discipline, same reason
// qoder-models.mjs exists). Measured here: the static snapshot was transcribed
// from `--help` on v2.137.1, and hy4flash-free / hy4flash shipped 2026-11-16
// without any CLI flag changing — a transcribed copy would silently hide them.
//
// SOURCE: `codebuddy --help` prints the accepted ids verbatim on the `--model`
// line: "Currently supported: (hy4std, hy4flash-free, …)". No login required —
// `--help` answers offline — so unlike qoder-cn this loader is not the ONLY
// source: clis.ts keeps a static fallback and the ADR-0073 guard reads that
// static table regardless. When this query cannot answer (CLI broken, spawn
// failure) the detection falls back to the static list instead of an empty
// picker.
//
// Windows note: the resolved CodeBuddy entry is often an extensionless
// `#!/usr/bin/env node` script, which CreateProcess cannot spawn directly —
// the default exec goes through spawnTargetFor, exactly like probeCli does
// (ADR-0053: probe and query must agree on how to start the binary).

/**
 * Parse `codebuddy --help` output: everything between "Currently supported: ("
 * and the closing ")", comma-separated.
 *
 * The marker is matched anywhere in the text — the surrounding usage lines are
 * noise by design, and a CLI reflowing its help must not break the reader.
 * Custom-local ids contain "/" and "." but never a comma, so a naive split is
 * safe.
 *
 * @param {unknown} output
 * @returns {{id: string, label: string}[]} ids in the CLI's own order, deduped
 */
export function parseCodebuddyModelsOutput(output) {
  const text = String(output ?? "");
  const match = text.match(/Currently supported:\s*\(([^)]*)\)/);
  if (!match) return [];
  const seen = new Set();
  const models = [];
  for (const raw of match[1].split(",")) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // id === label: `--model` takes the id verbatim; the CLI prints no separate
    // display names in `--help`.
    models.push({ id, label: id });
  }
  return models;
}

let commandCache = null;
let commandCacheAt = 0;
const COMMAND_CACHE_TTL_MS = 60_000;

/**
 * Drop the cache so the next loadCodebuddyModels() spawns the subprocess again.
 * Called by refreshSingleCliModels("codebuddy") and
 * detectClisCached({ refresh: true }) — a manual re-check must mean "really
 * query", not "reuse a result younger than the TTL" (ADR-0015).
 */
export function resetCodebuddyModelCache() {
  commandCache = null;
  commandCacheAt = 0;
}

/**
 * Default exec: run `--help` on the RESOLVED binary through spawnTargetFor
 * (same start recipe as probeCli — a node-script entry must go through the
 * interpreter, or Windows reports ENOENT for a CLI that runs fine).
 */
function defaultExec(binPath) {
  const target = spawnTargetFor(binPath);
  return stdoutOf(target.command, [...target.args, "--help"], {
    timeoutMs: 15_000,
    env: { ...process.env, ...target.env },
  });
}

/**
 * The models CodeBuddy Code actually supports right now.
 *
 * Cached for a minute so the config page's /api/clis calls don't spawn a
 * subprocess each. A failure is NOT cached: the reason (CLI updating, spawn
 * hiccup) can change between two page loads, and caching an empty list would
 * pin the static fallback for a minute after the CLI recovers.
 *
 * 异步（ADR-0098 决议 3）：`--help` 是个子进程，同步跑会把整个 web 服务冻到它
 * 退出为止，而这条调用就发生在 /api/clis 的请求路径上。
 *
 * @param {string} [binPath] - the resolved codebuddy entry (findBin output)
 * @param {(binPath: string) => Promise<string>} [exec]
 *   injected so the cache/refresh contract is unit-testable without spawning
 *   anything
 * @returns {Promise<{id: string, label: string}[]>} empty when the CLI cannot answer
 */
export async function loadCodebuddyModels(binPath, exec = defaultExec) {
  if (commandCache && Date.now() - commandCacheAt < COMMAND_CACHE_TTL_MS) {
    return commandCache;
  }
  try {
    const out = await exec(binPath);
    const models = parseCodebuddyModelsOutput(out);
    if (models.length > 0) {
      commandCache = models;
      commandCacheAt = Date.now();
      return models;
    }
  } catch {
    // CLI broken / not installed → no claim about the catalogue.
  }
  return [];
}
