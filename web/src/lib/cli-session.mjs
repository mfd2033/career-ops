// cli-session.mjs — 会话恢复的后端专属部分（opencode 的子进程反查）。
//
// 纯逻辑（恢复 argv、session_id 提取、id 校验）在 cli-session-shared.mjs：
// client 组件要与后端共用那份事实，而本文件顶层 import node:child_process，
// 直接进浏览器 chunk 会炸 next build。这里 re-export shared，既有 import
// 路径（route.ts、tests）保持不变。

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { isValidSessionId, OPENCODE_TITLE_PREFIX } from "./cli-session-shared.mjs";

export {
  SESSION_RESUME_ARGS,
  canViewSession,
  canResumeSession,
  isValidSessionId,
  sessionResumeArgv,
  extractClaudeSessionId,
  OPENCODE_TITLE_PREFIX,
  opencodeRunTitle,
} from "./cli-session-shared.mjs";

const execFile = promisify(execFileCb);

/**
 * 恢复窗口的启动器脚本内容（纯 ASCII：控制台代码页不一定是 UTF-8，中文会乱码）。
 *
 * 为什么需要它：`cmd start` 用 `%COMSPEC% /K` 打开 .cmd，窗口默认不会关；直接把
 * 程序交给 start 又会在失败时一闪而过、错误看不到。启动器把两边都顾上：
 *   - 成功（退出码 0）→ `exit` 关掉窗口，不留下多余的 cmd 提示符；
 *   - 失败（非 0）→ 打印退出码并 `pause`，把 CLI 的报错留在屏幕上。
 * `call %*` 让参数按原样（含带空格的路径）传下去；不在括号块里取 errorlevel，
 * 避免延迟展开的坑。
 */
export const SESSION_LAUNCHER_CMD = [
  "@echo off",
  "rem career-ops: resume a CLI session in this window; keep it open on failure.",
  "call %*",
  "if not errorlevel 1 exit",
  "echo.",
  "echo [career-ops] session resume failed - exit code %errorlevel%",
  "pause",
].join("\r\n") + "\r\n";

/**
 * 终态后反查 opencode 会话 id：`<bin> session list --format json` 输出
 * [{id,title,updated,created,projectId,directory}, …]，凭埋进派发 argv 的
 * title（career-ops-<runId>，cli-session-shared.mjs 的 opencodeRunTitle）精确
 * 匹配。找不到（老版本无此子命令、未登录、无输出）返回 null——台账行就没有
 * sessionId，按钮不显示，与「无数据不占位」同口径。
 * @param {{binPath: string, title: string, execFileFn?: typeof execFile, timeoutMs?: number}} args
 * @returns {Promise<string | null>}
 */
export async function findOpencodeSessionByTitle({ binPath, title, execFileFn = execFile, timeoutMs = 15_000 }) {
  if (typeof binPath !== "string" || !binPath || typeof title !== "string" || !title) return null;
  try {
    const { stdout } = await execFileFn(binPath, ["session", "list", "--format", "json"], { timeout: timeoutMs });
    const sessions = JSON.parse(stdout);
    if (!Array.isArray(sessions)) return null;
    const hit = sessions.find((s) => s && s.title === title && isValidSessionId(s.id));
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}
