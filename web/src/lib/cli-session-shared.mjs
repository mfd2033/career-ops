// cli-session-shared.mjs — 会话恢复的纯逻辑部分（零 node 依赖）。
//
// 单独成文件的原因：client 组件（cli-session-button.tsx）要与后端 API 共用
// 「哪些引擎支持恢复 + 恢复 argv 怎么拼」这份事实，而 cli-session.mjs 顶层
// import 了 node:child_process（opencode 反查的子进程）——直接 import 会把
// node 内置模块拖进浏览器 chunk，next build 报
// "the chunking context does not support external modules"。
// 后端专属的部分（execFile 反查）留在 cli-session.mjs 并 re-export 这里。

/**
 * 各引擎「在交互终端恢复指定会话」的 argv（binPath 之后的部分）。
 * 来源：本机实测 `--help` + headless 闭环（2026-11-09）——
 *   - claude:     `-r, --resume [value]`（TUI）；headless -p 默认不持久化会话，
 *                 派发必须带 `--session-id <uuid>` 会话才落盘（/api/run 负责）。
 *   - qoder-cn:   `-r, --resume [id]`（TUI，与 claude 同形）；同样需要派发时
 *                 `--session-id`（同一次实测闭环验证）。
 *   - opencode:   `run -i -s <id>`（-i 交互分屏模式，-s 指定会话）
 * 恢复 cwd 必须与 headless run 相同（仓库根）：claude/qoder 的会话按项目目录存。
 */
export const SESSION_RESUME_ARGS = Object.freeze({
  claude: (sessionId) => ["--resume", sessionId],
  "qoder-cn": (sessionId) => ["-r", sessionId],
  opencode: (sessionId) => ["run", "-i", "-s", sessionId],
});

/** 该引擎是否支持恢复会话（前端按钮自守卫与后端 API 校验共用）。 */
export function canResumeSession(cliId) {
  return typeof cliId === "string" && Object.hasOwn(SESSION_RESUME_ARGS, cliId);
}

/**
 * 会话 id 的白名单校验：uuid（claude/qoder）与 `ses_<base62>`（opencode）都落在
 * `[A-Za-z0-9_-]` 内。它作为独立 argv 元素传给 spawn（不经 shell），本就无注入面；
 * 校验是第二道防线——wt/cmd 这类终端包装器对 `;`、空格等元字符有自己的二次解析。
 * @param {string} id
 * @returns {boolean}
 */
export function isValidSessionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

/**
 * 构造恢复 argv；引擎不支持或 id 非法时返回 null（调用方据此拒绝，不拼命令）。
 * @param {string} cliId
 * @param {string} binPath - resolveCli 解析出的引擎二进制绝对路径
 * @param {string} sessionId
 * @returns {string[] | null}
 */
export function sessionResumeArgv(cliId, binPath, sessionId) {
  if (!canResumeSession(cliId) || !isValidSessionId(sessionId) || typeof binPath !== "string" || !binPath) {
    return null;
  }
  return [binPath, ...SESSION_RESUME_ARGS[cliId](sessionId)];
}

/**
 * 「查看 CLI 会话」按钮的自守卫：什么时候给出这个入口。
 *
 * 纯逻辑放这里而不是组件里，好让 node --test 直接覆盖（组件里只剩委托）。
 *
 * - 排队中永不给：进程都没起，没有会话可恢复。
 * - 有 sessionId（claude/qoder-cn 的 init 帧、终态 opencode 的反查结果）→ 给。
 * - 运行中的 opencode 卡还没有 sessionId（它要等终态才 `session list` 反查），
 *   但派发时已埋 `--title career-ops-<runId>`，服务端可凭 runId 现场解析，
 *   所以只要有 runId 也给。其余引擎运行中缺 id 一律不给：那是 init 帧还没到，
 *   给了也点不开。
 *
 * @param {{status?: string, cliId?: string, sessionId?: string, runId?: string}} job
 * @returns {boolean}
 */
export function canViewSession(job) {
  const status = job?.status;
  if (status !== "running" && status !== "done" && status !== "error") return false;
  if (!canResumeSession(job.cliId)) return false;
  if (typeof job.sessionId === "string" && job.sessionId) return true;
  return status === "running" && job.cliId === "opencode" && isValidSessionId(job.runId);
}

/**
 * 从 claude 系 stream-json 的 `system/init` 帧提取 session_id。
 * 非 JSON、其他帧、缺字段、格式不合法一律 null——调用方拿 null 就当「无会话」，
 * 不重试、不猜（同一 run 只有一帧 init，提取不到就是引擎没给）。
 * @param {string} line - 子进程 stdout 的一行
 * @returns {string | null}
 */
export function extractClaudeSessionId(line) {
  let ev;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== "object") return null;
  if (ev.type !== "system" || ev.subtype !== "init") return null;
  const id = ev.session_id;
  return isValidSessionId(id) ? id : null;
}

/** opencode 派发时埋的会话标题前缀；反查凭完整标题精确匹配。 */
export const OPENCODE_TITLE_PREFIX = "career-ops-";

/** opencode 本次 run 的会话标题（派发 argv 与终态反查共用一个构造，杜绝漂移）。 */
export function opencodeRunTitle(runId) {
  return `${OPENCODE_TITLE_PREFIX}${runId}`;
}
