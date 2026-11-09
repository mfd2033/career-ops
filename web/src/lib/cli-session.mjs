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
