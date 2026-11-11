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

/**
 * 配置类写入的统一埋点：cv / profile / portals / cadence / skills / quick-config
 * 这些入口形态相同——改某个用户层文件的某几个键。title 只放文件名，meta 只放键名，
 * 绝不记值：值里可能有本机绝对路径、邮箱或密钥明文，日志不是装它们的地方。
 */
export function logConfigWrite(
  type: string,
  options: { title?: string; fields?: string[]; meta?: OpLogMeta[] } = {},
): void {
  const meta = [...(options.meta ?? [])];
  const fields = (options.fields ?? []).map((f) => String(f ?? "").trim()).filter(Boolean).slice(0, 12);
  if (fields.length > 0) meta.push({ k: "fields", v: fields.join(", ") });
  logOperation({ trigger: "manual", type, title: options.title, meta, status: "done" });
}

/**
 * tracker 行的写入埋点，POST /api/tracker（新增）与 PUT /api/tracker/upsert
 * （按 URL 去重后可能更新既有行）共用——两套标题格式漂移过，构造只留一处。
 * `parsed` 是 tracker-add.mjs --json 的输出；没有输出就不记（没写成功的猜测没有价值），
 * 有输出但凑不出数字行号时仍然记标题，只是不给跳转（#N 不是数字就没有对应页面）。
 */
export function logTrackerRowWrite(parsed: unknown, type: "tracker-add" | "tracker-upsert"): void {
  const added = (parsed ?? null) as Record<string, unknown> | null;
  if (!added) return;
  const num = String(added.num ?? "").trim();
  logOperation({
    trigger: "manual",
    type,
    title: trackerLogTitle(num, added.company, added.role),
    // duplicate 也是「用户试过」的事实，回看时能解释为什么当天没多出一行。
    meta: added.verdict ? [{ k: "verdict", v: String(added.verdict) }] : [],
    status: "done",
    href: /^\d+$/.test(num) ? `/pipeline?q=${num}` : undefined,
  });
}
