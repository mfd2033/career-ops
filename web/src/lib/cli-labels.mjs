// Runtime display names — the ONE source every surface names a CLI runtime from
// (config picker via clis.ts, explore AI-search block, worker cards, /jobs rows,
// worker detail). Before this, clis.ts and explorer-view.tsx each carried their
// own map and had already drifted: Copilot read "GitHub Copilot CLI" in one and
// "Copilot CLI" in the other, and grok was missing from the second entirely.
//
// PURE by design — no `node:` imports — because CLIENT components import it
// (job-store / worker surfaces). clis.ts stays server-only and reads its `name`
// from here rather than hardcoding a second copy.
//
// ADR-0043 运行引擎: the label plus the ONE rendering rule for a worker's engine.

/** id → display name for every runtime KNOWN can spawn. */
export const CLI_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  copilot: "GitHub Copilot CLI",
  qwen: "Qwen CLI",
  antigravity: "Antigravity CLI",
  grok: "Grok Build CLI",
  // The CN build is a separate product from the international Qoder CLI (own
  // binary, own site, own model catalogue), so the id names the build — a
  // run-ledger entry recorded today must not turn ambiguous if the
  // international one is ever added beside it (ADR-0052).
  "qoder-cn": "Qoder (CN)",
  // CodeBuddy Code (Tencent). The id names the CLI, not the IDE that shares
  // its name: `CodeBuddy CN` is a VS Code fork whose own command-line entry
  // (`buddycn`) is a window launcher, not an agent runtime — so it is not an
  // engine and never appears here (ADR-0053).
  codebuddy: "CodeBuddy",
};

/**
 * Display name for a runtime id. An unknown id falls back to the raw id — never
 * a guess, never blank (the id itself is still the honest fact we hold).
 * @param {unknown} id
 * @returns {string} "" only when nothing was recorded at all
 */
export function cliDisplayName(id) {
  if (typeof id !== "string" || !id) return "";
  return CLI_LABELS[id] || id;
}

/**
 * ADR-0043 运行引擎: the value requested when a worker was dispatched, as one
 * display string — "Claude Code · agnes-2.5-flash", or just the runtime when no
 * model was requested.
 *
 * @param {unknown} cliId  the runtime the dispatch asked for
 * @param {unknown} model  the model the dispatch asked for (may be absent)
 * @returns {string|null} null = nothing was recorded (a pre-feature run); callers
 *   render no placeholder in a list and 「未记录（早于该功能）」 on a detail page.
 */
export function formatRunEngine(cliId, model) {
  const name = cliDisplayName(cliId);
  if (!name) return null;
  const m = typeof model === "string" ? model.trim() : "";
  return m ? `${name} · ${m}` : name;
}
