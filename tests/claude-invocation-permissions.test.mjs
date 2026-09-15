// Regression: the batch-evaluate route spawned workers with bare `claude -p` —
// no tool policy at all — while /api/run used claudeCliArgs's per-kind scope.
// Headless with default permissions, the FIRST Bash call (browser-extract.mjs —
// Chinese boards serve JDs behind a login wall) came back "This command
// requires approval", the worker dead-ended asking for an approval nobody can
// grant, and exited without writing its report or tracker-additions TSV.
// 2026-09-15: 80 batch workers ran ~77 minutes and produced ZERO artifacts,
// while the batch card still banked "done" (the second bug, fixed in the same
// commit). The route now appends permissionFlags("evaluate"), and this test
// pins the policy so it cannot drift again.

import { strict as assert } from 'assert';
import {
  claudeCliArgs, permissionFlags, argValue, toolNames, grantsWriteCapability,
  WRITE_CAPABLE_TOOLS, TOOL_SCOPES, KNOWN_KINDS,
} from '../web/src/lib/claude-invocation.mjs';
import { pass, fail } from './helpers.mjs';

const checks = [];

try {
  // The evaluate argv must carry the persisting scope — Bash is the one the
  // outage died on (browser-extract.mjs), Write/Edit the reports depend on.
  const ev = claudeCliArgs({ kind: 'evaluate', prompt: 'PROMPT-PLACEHOLDER' });
  assert.deepEqual(ev.slice(0, 2), ['-p', 'PROMPT-PLACEHOLDER']);
  assert.equal(argValue(ev, '--permission-mode'), 'acceptEdits');
  const evAllowed = toolNames(argValue(ev, '--allowedTools'));
  for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'WebFetch']) {
    assert.ok(evAllowed.includes(tool), `evaluate --allowedTools must include ${tool}`);
  }
  assert.deepEqual(
    toolNames(argValue(ev, '--disallowedTools')),
    ['MultiEdit', 'NotebookEdit', 'Task'],
    'evaluate denies only the write tools it does not use + Task',
  );
  checks.push(['evaluate argv carries the persisting scope (Bash/Write granted)', true]);
} catch (e) {
  checks.push(['evaluate argv carries the persisting scope (Bash/Write granted)', false, e.message]);
}

try {
  // The pdf kind must stay read-only — Bash denied is the #2172 contract, and
  // refactoring claudeCliArgs to compose permissionFlags() must not loosen it.
  const pdf = claudeCliArgs({ kind: 'pdf', prompt: 'x' });
  assert.ok(pdf.includes('--strict-mcp-config'), 'pdf keeps --strict-mcp-config');
  const scope = {
    allowed: argValue(pdf, '--allowedTools'),
    disallowed: argValue(pdf, '--disallowedTools'),
  };
  assert.equal(grantsWriteCapability(scope), false, 'pdf must grant no write-capable tool');
  checks.push(['pdf argv stays write-free after the permissionFlags refactor', true]);
} catch (e) {
  checks.push(['pdf argv stays write-free after the permissionFlags refactor', false, e.message]);
}

try {
  // permissionFlags is what the batch route appends: it must agree with
  // claudeCliArgs's tail for the same kind, for EVERY known kind.
  for (const kind of KNOWN_KINDS) {
    const full = claudeCliArgs({ kind, prompt: 'x' });
    const flags = permissionFlags(kind);
    const tail = full.slice(full.indexOf('--permission-mode'), full.indexOf('--permission-mode') + flags.length);
    assert.deepEqual(tail, flags, `${kind}: permissionFlags must equal claudeCliArgs's tail`);
    assert.deepEqual(flags.slice(0, 2), ['--permission-mode', 'acceptEdits']);
  }
  checks.push(['permissionFlags matches claudeCliArgs tail for every known kind', true]);
} catch (e) {
  checks.push(['permissionFlags matches claudeCliArgs tail for every known kind', false, e.message]);
}

try {
  // The deny list is derived, never hand-written: every write-capable tool the
  // readOnly scope does not name must appear in its disallowed value.
  const roDenied = toolNames(TOOL_SCOPES.readOnly.disallowed);
  for (const tool of WRITE_CAPABLE_TOOLS) {
    assert.ok(roDenied.includes(tool), `readOnly scope must explicitly deny ${tool}`);
  }
  assert.ok(roDenied.includes('Task'), 'readOnly scope must deny Task (ALWAYS_DENIED)');
  checks.push(['readOnly scope explicitly denies every write-capable tool', true]);
} catch (e) {
  checks.push(['readOnly scope explicitly denies every write-capable tool', false, e.message]);
}

for (const [name, ok, msg] of checks) {
  if (ok) pass(name);
  else fail(`${name}: ${msg}`);
}
