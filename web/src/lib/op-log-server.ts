import { careerOpsRoot } from "@/lib/career-ops";
import { appendOpLog } from "@/lib/op-log-store.mjs";

// 操作日志的服务端埋点入口。路由只调 logOperation()，不直接碰文件路径，
// 也不写 try/catch —— 台账失败绝不能影响用户的操作本身（纪律见 op-log-store.mjs）。
//
// 分界线：这个写入链只记「既有台账没有记录的手工动作」（新增/编辑/删除行、黑名单、
// 管道增删、配置），以及「状态变更的精确时刻」。评估/体检/扫描这类自动任务已经在
// runs/index.jsonl 与 scan-runs.tsv 有唯一事实源，页面读取端直接聚合，不重复写。

export type OpLogMeta = { k: string; v: string };

export type OpLogWrite = {
  /** 默认 manual；自动任务不从这里写 */
  trigger?: "manual" | "auto";
  /** 必须命中 web/src/lib/op-log.mjs 的 OP_LOG_TYPES 白名单 */
  type: string;
  title?: string;
  meta?: OpLogMeta[];
  status?: "done" | "failed";
  durationSec?: number;
  href?: string;
  /** 与旧台账对齐的键（如 status:<#>:<日期>:<from>-><to>） */
  dedupeKey?: string;
  at?: number;
};

/** 追加一条操作记录；永不抛错、永不阻塞调用方的写入事务。 */
export function logOperation(entry: OpLogWrite): void {
  appendOpLog(careerOpsRoot(), entry);
}

/** 「#N 公司 · 岗位」——条目标题的统一写法，凑不出的部分不占位。 */
export function trackerLogTitle(num: string | number, company?: unknown, role?: unknown): string {
  const head = `#${String(num ?? "").trim()}`;
  const rest = [company, role]
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  return rest ? `${head} ${rest}` : head;
}
