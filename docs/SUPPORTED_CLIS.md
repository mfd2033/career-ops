# Supported CLIs

Career-ops is AI-agnostic and runs on several command-line agent tools. The core logic is shared via `AGENTS.md`, while CLI-specific nuances are handled through entry wrappers in the repository root.

| CLI | Entry File | How to Invoke |
| --- | --- | --- |
| Claude Code | `CLAUDE.md` | Interactive: `claude` (then `/career-ops`). Headless/Batch: `claude -p "prompt"` |
| Cursor | `AGENTS.md` | Interactive: open the project in Cursor and ask for `career-ops` (skill entrypoint at `.cursor/skills/career-ops/SKILL.md`) |
| Codex | `CODEX.md` (see [`docs/CODEX.md`](CODEX.md)) | Interactive: `codex` (then use plain text). Headless/Batch: `codex exec "prompt"` |
| OpenCode | `OPENCODE.md` | Interactive: `opencode` (then `/career-ops`). Headless/Batch: `opencode run "prompt"` |
| Antigravity CLI | `AGENTS.md` | Interactive: `agy` (then `/career-ops`). Headless/Batch: `agy -p "prompt"` |
| Grok Build CLI | `AGENTS.md` | Interactive: `grok` (then `/career-ops`). Headless/Batch: `grok -p "prompt"` |
| Qwen | `AGENTS.md` | Interactive: `qwen`. Headless/Batch: `qwen -p "prompt"` |
| Kimi | `KIMI.md` | Interactive: `kimi` |
| GitHub Copilot CLI | `AGENTS.md` | Headless/Batch: `copilot -p "prompt"` |
| Qoder CN | — (not verified as an entrypoint) | Headless/Batch: `qoderclicn -p "prompt"` (the CN build's binary; the dashboard drives it over `--output-format stream-json`, see [ADR-0052](adr/0052-qoder-cn-stream-json-engine.md)) |
| CodeBuddy | — (not verified as an entrypoint) | Headless/Batch: `codebuddy -p "prompt"` (the dashboard drives it over `--output-format stream-json`, see [ADR-0053](adr/0053-codebuddy-cli-engine-and-vendor-bundle-discovery.md)). Ships as an extensionless `#!/usr/bin/env node` script in both of its channels — the vendor's own installer (`%USERPROFILE%\AppData\Local\codebuddy\bin`) and the copy WorkBuddy bundles inside its install tree — so the dashboard resolves it and runs it through the interpreter. Permissions travel as `--settings`, not as tool flags: the flag forms were measured to fail here |
| Gemini | `GEMINI.md` | Legacy wrapper redirecting to `AGENTS.md` (transitioned to Antigravity CLI). |
