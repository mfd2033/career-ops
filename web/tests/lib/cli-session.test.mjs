// cli-session.mjs 的单元测试（node --test）。
// 锁定：恢复 argv 形状、session id 白名单、init 帧提取、opencode 反查。
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_RESUME_ARGS,
  canViewSession,
  canResumeSession,
  isValidSessionId,
  sessionResumeArgv,
  extractClaudeSessionId,
  opencodeRunTitle,
  OPENCODE_TITLE_PREFIX,
  findOpencodeSessionByTitle,
} from "../../src/lib/cli-session.mjs";

describe("canResumeSession", () => {
  it("支持清单内的引擎", () => {
    for (const id of Object.keys(SESSION_RESUME_ARGS)) assert.equal(canResumeSession(id), true);
  });
  it("清单外 / 缺失返回 false", () => {
    assert.equal(canResumeSession("codex"), false);
    assert.equal(canResumeSession("gemini"), false);
    assert.equal(canResumeSession(undefined), false);
    assert.equal(canResumeSession(""), false);
    // Object.hasOwn 防原型链：constructor 这类键不算支持
    assert.equal(canResumeSession("constructor"), false);
  });
});

describe("canViewSession（按钮自守卫）", () => {
  const UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  const RUN_ID = "5b0f1e2a-9c3d-4e5f-8a1b-2c3d4e5f6a7b";

  it("终态 + 有 sessionId → 显示（原有行为不变）", () => {
    for (const status of ["done", "error"]) {
      assert.equal(canViewSession({ status, cliId: "claude", sessionId: UUID }), true);
      assert.equal(canViewSession({ status, cliId: "opencode", sessionId: "ses_e405af519ffeZanSoMNrAmtzc4" }), true);
    }
  });
  it("运行中 + 已有 sessionId（claude/qoder-cn 的 init 帧）→ 显示", () => {
    assert.equal(canViewSession({ status: "running", cliId: "claude", sessionId: UUID }), true);
    assert.equal(canViewSession({ status: "running", cliId: "qoder-cn", sessionId: UUID }), true);
  });
  it("运行中 opencode 无 sessionId 但有合法 runId → 显示（服务端按标题反查）", () => {
    assert.equal(canViewSession({ status: "running", cliId: "opencode", runId: RUN_ID }), true);
  });
  it("运行中 opencode 缺 runId / runId 非法 → 不显示", () => {
    assert.equal(canViewSession({ status: "running", cliId: "opencode" }), false);
    assert.equal(canViewSession({ status: "running", cliId: "opencode", runId: "short" }), false);
    assert.equal(canViewSession({ status: "running", cliId: "opencode", runId: "abc;rm -rf" }), false);
  });
  it("运行中但其他引擎缺 sessionId → 不显示（init 帧还没到，给了也点不开）", () => {
    assert.equal(canViewSession({ status: "running", cliId: "claude", runId: RUN_ID }), false);
    assert.equal(canViewSession({ status: "running", cliId: "qoder-cn", runId: RUN_ID }), false);
  });
  it("排队中永不给：进程都没起", () => {
    assert.equal(canViewSession({ status: "queued", cliId: "claude", sessionId: UUID }), false);
    assert.equal(canViewSession({ status: "queued", cliId: "opencode", runId: RUN_ID }), false);
  });
  it("引擎不支持 / 状态缺失 → 不显示", () => {
    assert.equal(canViewSession({ status: "done", cliId: "codex", sessionId: UUID }), false);
    assert.equal(canViewSession({ status: undefined, cliId: "claude", sessionId: UUID }), false);
    assert.equal(canViewSession({}), false);
    assert.equal(canViewSession(undefined), false);
  });
});

describe("isValidSessionId", () => {
  it("uuid 与 ses_ 前缀均通过", () => {
    assert.equal(isValidSessionId("a1b2c3d4-e5f6-7890-abcd-ef1234567890"), true);
    assert.equal(isValidSessionId("ses_e405af519ffeZanSoMNrAmtzc4"), true);
  });
  it("元字符 / 过短 / 过长 / 非字符串一律拒绝", () => {
    assert.equal(isValidSessionId("abc;rm -rf"), false); // 分号：终端包装器元字符
    assert.equal(isValidSessionId("short"), false); // < 8
    assert.equal(isValidSessionId("a".repeat(129)), false);
    assert.equal(isValidSessionId(undefined), false);
    assert.equal(isValidSessionId(123), false);
    assert.equal(isValidSessionId("空格 不行"), false);
  });
});

describe("sessionResumeArgv", () => {
  const BIN = "D:\\node_global\\claude.exe";
  it("claude → --resume", () => {
    assert.deepEqual(sessionResumeArgv("claude", BIN, "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), [
      BIN,
      "--resume",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ]);
  });
  it("qoder-cn → -r", () => {
    assert.deepEqual(sessionResumeArgv("qoder-cn", BIN, "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), [
      BIN,
      "-r",
      "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    ]);
  });
  it("opencode → run -i -s（交互式继续该会话）", () => {
    assert.deepEqual(sessionResumeArgv("opencode", BIN, "ses_e405af519ffeZanSoMNrAmtzc4"), [
      BIN,
      "run",
      "-i",
      "-s",
      "ses_e405af519ffeZanSoMNrAmtzc4",
    ]);
  });
  it("不支持的引擎 / 非法 id / 空 binPath 一律 null", () => {
    assert.equal(sessionResumeArgv("codex", BIN, "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), null);
    assert.equal(sessionResumeArgv("claude", BIN, "short"), null);
    assert.equal(sessionResumeArgv("claude", "", "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), null);
    assert.equal(sessionResumeArgv("claude", undefined, "a1b2c3d4-e5f6-7890-abcd-ef1234567890"), null);
  });
});

describe("extractClaudeSessionId", () => {
  const initFrame = JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    tools: ["Bash"],
  });
  it("init 帧提取 session_id", () => {
    assert.equal(extractClaudeSessionId(initFrame), "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
  });
  it("assistant / result / stream_event 帧返回 null", () => {
    assert.equal(extractClaudeSessionId(JSON.stringify({ type: "assistant", session_id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" })), null);
    assert.equal(extractClaudeSessionId(JSON.stringify({ type: "result", subtype: "success" })), null);
  });
  it("init 帧缺 session_id / 格式非法返回 null", () => {
    assert.equal(extractClaudeSessionId(JSON.stringify({ type: "system", subtype: "init" })), null);
    assert.equal(extractClaudeSessionId(JSON.stringify({ type: "system", subtype: "init", session_id: "xx" })), null);
    assert.equal(extractClaudeSessionId(JSON.stringify({ type: "system", subtype: "init", session_id: 42 })), null);
  });
  it("坏 JSON / 空行 / 标量返回 null", () => {
    assert.equal(extractClaudeSessionId("not json"), null);
    assert.equal(extractClaudeSessionId(""), null);
    assert.equal(extractClaudeSessionId("null"), null);
    assert.equal(extractClaudeSessionId("42"), null);
  });
});

describe("opencodeRunTitle", () => {
  it("前缀 + runId，两端共用一个构造", () => {
    assert.equal(opencodeRunTitle("abc-123"), `${OPENCODE_TITLE_PREFIX}abc-123`);
    assert.match(opencodeRunTitle("abc-123"), /^career-ops-abc-123$/);
  });
});

describe("findOpencodeSessionByTitle", () => {
  const BIN = "D:\\node_global\\opencode.exe";
  const sessions = [
    { id: "ses_aaaaaaaaaaaaaaaaaaaaaaaa", title: "别的会话", created: 1 },
    { id: "ses_bbbbbbbbbbbbbbbbbbbbbbbb", title: "career-ops-run-1", created: 2 },
  ];
  it("title 精确命中返回会话 id", async () => {
    const execFileFn = async () => ({ stdout: JSON.stringify(sessions) });
    assert.equal(await findOpencodeSessionByTitle({ binPath: BIN, title: "career-ops-run-1", execFileFn }), "ses_bbbbbbbbbbbbbbbbbbbbbbbb");
  });
  it("找不到 / id 非法返回 null", async () => {
    const execFileFn = async () => ({ stdout: JSON.stringify(sessions) });
    assert.equal(await findOpencodeSessionByTitle({ binPath: BIN, title: "career-ops-run-9", execFileFn }), null);
    const bad = [{ id: "bad;id", title: "career-ops-run-1" }];
    assert.equal(await findOpencodeSessionByTitle({ binPath: BIN, title: "career-ops-run-1", execFileFn: async () => ({ stdout: JSON.stringify(bad) }) }), null);
  });
  it("非 JSON / 非数组 / 子进程失败返回 null，不抛", async () => {
    assert.equal(await findOpencodeSessionByTitle({ binPath: BIN, title: "x", execFileFn: async () => ({ stdout: "boom" }) }), null);
    assert.equal(await findOpencodeSessionByTitle({ binPath: BIN, title: "x", execFileFn: async () => ({ stdout: '{"a":1}' }) }), null);
    assert.equal(await findOpencodeSessionByTitle({ binPath: BIN, title: "x", execFileFn: async () => { throw new Error("spawn fail"); } }), null);
  });
  it("空参守卫", async () => {
    assert.equal(await findOpencodeSessionByTitle({ binPath: "", title: "x" }), null);
    assert.equal(await findOpencodeSessionByTitle({ binPath: BIN, title: "" }), null);
  });
});
