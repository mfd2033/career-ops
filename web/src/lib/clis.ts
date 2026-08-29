import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexStreamArgs, isFatalClaudeStderr, isFatalCodexStderr, isFatalOpenCodeStderr, parseClaudeEvent, parseCodexEvent } from "./run-cli-support.mjs";
import { loadOpencodeModels } from "./opencode-models.mjs";

// Server-only (node imports). The agnostic runtimes career-ops can delegate to
// in headless mode (AGENTS.md). Install URLs from career-ops-docs.
export type ModelOption = {
  id: string; // the exact value passed to the CLI's model flag
  label: string; // human label for the config dropdown
};

export type ModelMeta = {
  /** The CLI's model-selection flag (e.g. "--model" or "-m"). */
  flag: string;
  /** The model id the CLI would use when the user selects nothing. */
  default: string;
  /** Dropdown options for the config page. */
  options: ModelOption[];
};

export type CliSpec = {
  id: string;
  name: string;
  bin: string;
  run: string;
  url: string;
  /** headless invocation args for a single prompt, emitting PLAIN TEXT on stdout.
   * Every caller that reads the output itself (the `<<offer:>>`/`<<cv:>>` envelope
   * routes, the apply planners) uses this, so it must stay unstructured. */
  args: (prompt: string) => string[];
  /** Structured-output CLIs only: args for a run whose stdout the caller parses
   * with `parseEvent` — i.e. /api/run's dashboard stream, the one consumer that
   * understands events. Absent → that caller falls back to `args`.
   *
   * INVARIANT: `parseEvent` only applies to output produced by THIS argv (for
   * claude, by claude-invocation.mjs's `claudeCliArgs`, which spells its own
   * `--output-format stream-json`). Pairing one CLI's parser with a plain-text
   * invocation yields a silent stream of unparseable lines. */
  streamArgs?: (prompt: string) => string[];
  /** Structured-output CLIs only: parse one stdout line into dashboard events.
   * Absent → the route streams stdout as raw text (the default for every CLI
   * without its own structured output format). */
  parseEvent?: (line: string) => import("./run-cli-support.mjs").ParsedEvent | null;
  /** Structured-output CLIs only: decide whether a stderr line is fatal.
   * Absent → the route falls back to the shared generic error regex. */
  stderrIsFatal?: (line: string) => boolean;
  /** Model selection metadata — what the config page offers for this CLI. */
  model: ModelMeta;
};

/**
 * NO RUNTIME HERE MAY GRANT ITSELF MORE PERMISSION THAN THE AUDITED ONE.
 *
 * The permission model is per-worker AND per-CLI, but only one axis is written
 * down: WRITE_CAPABLE_TOOLS and the per-kind deny lists live in
 * claude-invocation.mjs — i.e. on Claude's path. A new CLI arriving with a
 * blanket auto-approve flag (`--always-approve`, `--yolo`,
 * `--dangerously-skip-permissions`, `--yes`) is not breaking that rule; it is
 * entering where the rule does not exist.
 *
 * Concretely: the `pdf` worker has Bash explicitly denied and must never regain
 * it. Pair Grok with `--always-approve` and that same worker gets Write and
 * Bash auto-approved — so the user's choice of runtime silently changes what a
 * worker may do to their files, while both paths look identical in the UI.
 *
 * If a CLI has no per-tool deny list to pair with, the answer is NOT to
 * auto-approve: it is to withhold the workers that write. Needing such a flag
 * to make a runtime work is a core architecture issue, not a line inside a
 * CLI-support PR.
 *
 * Enforced by tests/lib/clis-permissions.test.mjs, because a rule that only
 * lives in a comment is a rule the next contributor may never read.
 */

/**
 * Model choices offered on the config page per CLI. `id` is the exact value the
 * CLI's model flag receives; `label` is what the user sees. `default` is the
 * value used when the user has not picked one — it matches what the CLI would
 * use on its own, so the "current model" readout is honest before any choice.
 *
 * Sources: official CLI docs/help for each runtime (verified 2026-08); the
 * model IDs are current-generation. A model ID here must be something the CLI
 * ACCEPTS on its flag — for Antigravity that is a display name, not an API
 * slug (google-antigravity/antigravity-cli#83).
 */
const MODELS: Record<string, ModelMeta> = {
  claude: {
    flag: "--model",
    default: "sonnet",
    options: [
      { id: "opus", label: "Opus (claude-opus-5)" },
      { id: "sonnet", label: "Sonnet (claude-sonnet-5)" },
      { id: "haiku", label: "Haiku (claude-haiku-4-5)" },
      { id: "claude-opus-5", label: "claude-opus-5" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
      { id: "claude-sonnet-4-5-20250929", label: "claude-sonnet-4-5-20250929" },
      { id: "claude-opus-4-8", label: "claude-opus-4-8" },
    ],
  },
  codex: {
    flag: "--model",
    default: "gpt-5.4",
    options: [
      { id: "gpt-5.4", label: "gpt-5.4 (default)" },
      { id: "gpt-5.4-mini", label: "gpt-5.4-mini (fast)" },
      { id: "gpt-5.3-codex", label: "gpt-5.3-codex (deep engineering)" },
      { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark (Pro)" },
    ],
  },
  gemini: {
    flag: "--model",
    default: "auto",
    options: [
      { id: "auto", label: "auto (routed)" },
      { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview" },
      { id: "gemini-3-flash-preview", label: "gemini-3-flash-preview" },
      { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    ],
  },
  opencode: {
    flag: "--model",
    default: "anthropic/claude-sonnet-4-5-20250929",
    options: [
      { id: "anthropic/claude-sonnet-4-5-20250929", label: "anthropic/claude-sonnet-4-5" },
      { id: "anthropic/claude-opus-4-5", label: "anthropic/claude-opus-4-5" },
      { id: "openai/gpt-5", label: "openai/gpt-5" },
      { id: "opencode/gpt-5.1-codex", label: "opencode/gpt-5.1-codex" },
      { id: "google/gemini-3-pro", label: "google/gemini-3-pro" },
      { id: "lmstudio/", label: "lmstudio/ (local, custom)" },
    ],
  },
  copilot: {
    flag: "--model",
    default: "auto",
    options: [
      { id: "auto", label: "auto (default routing)" },
      { id: "claude-sonnet-4.5", label: "claude-sonnet-4.5" },
      { id: "claude-opus-4.5", label: "claude-opus-4.5" },
      { id: "claude-haiku-4.5", label: "claude-haiku-4.5" },
      { id: "gpt-5.4", label: "gpt-5.4" },
      { id: "gpt-5.6", label: "gpt-5.6" },
    ],
  },
  qwen: {
    flag: "--model",
    default: "qwen3.5-plus",
    options: [
      { id: "qwen3.5-plus", label: "qwen3.5-plus (default)" },
      { id: "qwen3-coder-plus", label: "qwen3-coder-plus" },
      { id: "qwen3.6-plus", label: "qwen3.6-plus" },
      { id: "qwen3.7-plus", label: "qwen3.7-plus" },
    ],
  },
  antigravity: {
    flag: "--model",
    default: "",
    options: [
      // Display names, not API slugs — the flag accepts what `agy models` prints.
      { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
      { id: "Gemini 3.5 Flash", label: "Gemini 3.5 Flash" },
      { id: "Claude Sonnet 4.6", label: "Claude Sonnet 4.6" },
      { id: "Claude Opus 4.6", label: "Claude Opus 4.6" },
    ],
  },
  grok: {
    flag: "--model",
    default: "grok-build",
    options: [
      { id: "grok-build", label: "grok-build (default)" },
      { id: "grok-build-0.1", label: "grok-build-0.1" },
    ],
  },
};

export const KNOWN: CliSpec[] = [
  { id: "claude", name: "Claude Code", bin: "claude", run: "claude -p", url: "https://claude.ai/code", args: (p) => ["-p", p], model: MODELS.claude, parseEvent: parseClaudeEvent, stderrIsFatal: isFatalClaudeStderr },
  { id: "codex", name: "Codex", bin: "codex", run: "codex exec", url: "https://github.com/openai/codex", args: (p) => ["exec", p], model: MODELS.codex, streamArgs: codexStreamArgs, parseEvent: parseCodexEvent, stderrIsFatal: isFatalCodexStderr },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", run: "gemini -p", url: "https://github.com/google-gemini/gemini-cli", args: (p) => ["-p", p], model: MODELS.gemini },
  { id: "opencode", name: "OpenCode", bin: "opencode", run: "opencode run", url: "https://opencode.ai", args: (p) => ["run", p], model: MODELS.opencode, stderrIsFatal: isFatalOpenCodeStderr },
  { id: "copilot", name: "GitHub Copilot CLI", bin: "copilot", run: "copilot -p", url: "https://docs.github.com/en/copilot/github-copilot-in-the-cli", args: (p) => ["-p", p], model: MODELS.copilot },
  { id: "qwen", name: "Qwen CLI", bin: "qwen", run: "qwen -p", url: "https://qwen.ai/qwencode", args: (p) => ["-p", p], model: MODELS.qwen },
  { id: "antigravity", name: "Antigravity CLI", bin: "agy", run: "agy -p", url: "https://antigravity.google", args: (p) => ["-p", p], model: MODELS.antigravity },
  // Grok Build also speaks `--output-format streaming-json`, but that is its own
  // schema, not Claude's `stream-json` — and the run route only parses the
  // latter. Plain `-p` streams text, which is what every other non-Claude entry
  // here does.
  { id: "grok", name: "Grok Build CLI", bin: "grok", run: "grok -p", url: "https://docs.x.ai/build/overview", args: (p) => ["-p", p], model: MODELS.grok },
];

function searchDirs(): string[] {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".deno/bin"),
    path.join(home, ".opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  if (process.platform === "win32") {
    // Windows CLIs frequently install under per-user AppData roots and don't
    // reliably add themselves to PATH (e.g. Antigravity → %LOCALAPPDATA%\agy\bin).
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    extra.push(
      path.join(localAppData, "agy", "bin"), // Antigravity CLI
      path.join(localAppData, "Microsoft", "WindowsApps"), // winget/Store shims
      path.join(appData, "npm"), // npm global prefix on Windows
    );
  }
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extra])];
}

// On Windows, executables carry an extension (claude.exe, claude.cmd, ...).
// Mirror the shell's PATHEXT resolution so a native-installer claude.exe is
// found, not just an extensionless npm shim. On POSIX, "" keeps the bare name.
function binCandidates(bin: string): string[] {
  if (process.platform !== "win32") return [bin];
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = pathext
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    // Only include extensions that `child_process.spawn()` can execute directly.
    .filter((e) => [".com", ".exe", ".bat", ".cmd"].includes(e.toLowerCase()));

  // On Windows an extensionless file beside the executable is almost always a
  // POSIX shim — npm writes a bash script on the bare `bin` name (`opencode`)
  // next to `opencode.cmd`/`opencode.exe`. child_process.spawn cannot execute
  // that extensionless script and fails with `spawn ... ENOENT`, while
  // fs.accessSync(X_OK) reports it as "executable" because Windows treats X_OK
  // as mere existence. Try the real executable extensions first (mirroring the
  // shell's PATHEXT resolution) and fall back to the bare name only as a last
  // resort for a rare genuinely-executable extensionless shim.
  return [...exts.map((ext) => bin + ext), bin];
}

function isSpawnable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// An npm global install tucks the REAL native binary under
// `{prefix}\node_modules\{pkg}\bin\{bin}.exe` (and, for scoped packages,
// `{prefix}\node_modules\{@scope}\{pkg}\bin\{bin}.exe`). The `{bin}` and
// `{bin}.cmd` at the prefix root are just a POSIX shim and a cmd shim. Only
// the `.exe` can be spawned directly — the shims cannot: the extensionless one
// fails `spawn ... ENOENT`, and the `.cmd` fails `EINVAL` on Node < 22.9, or
// (routed through cmd.exe) mangles a multi-line prompt by truncating it at the
// first newline. So on Windows resolve the real `.exe` first.
function findNpmGlobalExe(dir: string, bin: string): string | null {
  const nm = path.join(dir, "node_modules");
  let packages: string[];
  try {
    packages = fs.readdirSync(nm);
  } catch {
    return null; // no node_modules here (most PATH entries) — cheap to skip
  }
  for (const pkg of packages) {
    // npm stages an install into a transient `.pkg-XXXXXX` dir and renames it
    // into place; a stale one left behind holds an OLD copy of the native
    // binary and (sorting first) would shadow the real package. Skip dot-dirs.
    if (pkg.startsWith(".")) continue;
    if (pkg.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = fs.readdirSync(path.join(nm, pkg));
      } catch {
        continue;
      }
      for (const sub of scoped) {
        if (sub.startsWith(".")) continue;
        const exe = path.join(nm, pkg, sub, "bin", bin + ".exe");
        if (isSpawnable(exe)) return exe;
      }
    } else {
      const exe = path.join(nm, pkg, "bin", bin + ".exe");
      if (isSpawnable(exe)) return exe;
    }
  }
  return null;
}

export function findBin(bin: string, dirs = searchDirs()): string | null {
  if (process.platform === "win32") {
    // Prefer a directly-spawnable native binary, since spawn must pass a
    // multi-line prompt intact. Look for a real installer's `{bin}.exe`/`.com`
    // at each dir root, then npm's real `.exe` under node_modules. The
    // `.cmd`/`.bat`/extensionless shims below are a detectClis fallback only.
    for (const dir of dirs) {
      for (const candidate of [bin + ".exe", bin + ".com"]) {
        const p = path.join(dir, candidate);
        if (isSpawnable(p)) return p;
      }
      const exe = findNpmGlobalExe(dir, bin);
      if (exe) return exe;
    }
  }
  for (const dir of dirs) {
    for (const candidate of binCandidates(bin)) {
      const p = path.join(dir, candidate);
      if (isSpawnable(p)) return p;
    }
  }
  return null;
}

export type DetectedCli = {
  id: string;
  name: string;
  run: string;
  url: string;
  installed: boolean;
  path: string | null;
  model: ModelMeta;
};

export function detectClis(): DetectedCli[] {
  const dirs = searchDirs();
  return KNOWN.map((c) => {
    const found = findBin(c.bin, dirs);
    let model = c.model;
    // opencode's model list is user-config-driven (opencode.jsonc providers),
    // so a static list would diverge from what the opencode TUI/desktop shows.
    // Read the real config; fall back to the static defaults only when nothing
    // is found.
    if (c.id === "opencode") {
      // The full list opencode actually exposes — built-in free models plus
      // every configured provider — via the `opencode models` command (config
      // files as fallback). A static list would diverge from what the opencode
      // TUI/desktop shows.
      const dynamic = loadOpencodeModels(found ?? undefined);
      if (dynamic.length > 0) {
        // The static default is not in the real list, so it would render as an
        // unselectable phantom. Fall back to the first real model.
        model = { ...c.model, options: dynamic, default: dynamic[0].id };
      }
    }
    return { id: c.id, name: c.name, run: c.run, url: c.url, installed: !!found, path: found, model };
  });
}

export function resolveCli(id: string): { spec: CliSpec; binPath: string } | null {
  const spec = KNOWN.find((c) => c.id === id);
  if (!spec) return null;
  const binPath = findBin(spec.bin);
  if (!binPath) return null;
  return { spec, binPath };
}
