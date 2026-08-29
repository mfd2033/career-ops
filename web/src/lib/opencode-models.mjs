import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// Strip JS-style comments from a JSONC string, string-aware: a `//` inside a
// quoted string (e.g. an https:// baseURL) must survive, while both line
// comments and block comments outside strings are removed.
function stripJsoncComments(text) {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Parse `opencode models` output: one provider-qualified model id per line
 * (e.g. `opencode/hy3-free`, `model-scope/deepseek-ai/DeepSeek-V4-Pro`).
 *
 * @param {string} output
 * @returns {{id: string, label: string}[]}
 */
export function parseModelsOutput(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id }));
}

/**
 * Read opencode's provider configuration and extract all configured models.
 *
 * Checks both the user-level config (~/.config/opencode/opencode.jsonc) and
 * any project-level config (opencode.jsonc / opencode.json in cwd), in that
 * order. Providers listed in `disabled_providers` are excluded.
 *
 * Returns an empty array when no config file is found or all providers are
 * disabled — the caller should fall back to the `opencode models` command.
 *
 * @param {string[]} [candidates] - config paths to read (defaults to the
 *   user-level + project-level opencode config locations)
 * @returns {{id: string, label: string}[]}
 */
export function loadOpencodeModelsFromFiles(candidates) {
  const files =
    candidates ||
    [
      path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
      path.join(process.cwd(), "opencode.jsonc"),
      path.join(process.cwd(), "opencode.json"),
    ];

  const models = [];
  const seen = new Set();
  const disabledProviders = new Set();

  for (const fp of files) {
    let cfg;
    try {
      const raw = fs.readFileSync(fp, "utf-8");
      cfg = JSON.parse(stripJsoncComments(raw));
    } catch {
      continue; // file not found or parse error → skip
    }

    // Collect disabled providers — use the first list found
    if (disabledProviders.size === 0 && Array.isArray(cfg.disabled_providers)) {
      for (const p of cfg.disabled_providers) {
        if (typeof p === "string") disabledProviders.add(p);
      }
    }

    if (!cfg.provider) continue;

    for (const [providerId, provider] of Object.entries(cfg.provider)) {
      if (disabledProviders.has(providerId)) continue;
      const modelsOf = provider?.models;
      if (!modelsOf) continue;
      for (const [modelId] of Object.entries(modelsOf)) {
        const fullId = `${providerId}/${modelId}`;
        if (seen.has(fullId)) continue;
        seen.add(fullId);
        models.push({ id: fullId, label: fullId });
      }
    }
  }

  return models;
}

let commandCache = null;
let commandCacheAt = 0;
const COMMAND_CACHE_TTL_MS = 60_000;

/**
 * The complete model list opencode actually exposes: the `opencode models`
 * command output (built-in free models like opencode/hy3-free + every
 * configured provider, disabled_providers already excluded by opencode itself).
 *
 * Falls back to the user/project config files if the command can't run (e.g.
 * opencode not installed or a PATH hiccup). The command result is cached for
 * a minute so the config page's /api/clis calls don't spawn a subprocess each.
 *
 * @param {string} [binPath] - the resolved opencode executable; defaults to `opencode`
 * @returns {{id: string, label: string}[]}
 */
export function loadOpencodeModels(binPath) {
  if (commandCache && Date.now() - commandCacheAt < COMMAND_CACHE_TTL_MS) {
    return commandCache;
  }
  try {
    const out = execFileSync(binPath || "opencode", ["models"], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const models = parseModelsOutput(out);
    if (models.length > 0) {
      commandCache = models;
      commandCacheAt = Date.now();
      return models;
    }
  } catch {
    // command unavailable or failed → fall through to config files
  }
  return loadOpencodeModelsFromFiles();
}