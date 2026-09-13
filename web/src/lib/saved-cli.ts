import {
  UNKNOWN_EMPLOYER_OPTIONS,
  UNKNOWN_EMPLOYER_DEFAULT,
  isUnknownEmployerPolicy,
  resolveUnknownEmployer,
} from "./unknown-employer.mjs";

export const CONFIG_KEY = "career-ops:config";

// Mirror the selected CLI/model onto the server (/api/config) so the BOSS直聘
// extension can reuse it without re-asking. Best-effort in the sense that it
// never throws — but it now REPORTS the outcome, because for `unknownEmployer`
// a lost write is invisible otherwise: the client store still shows the user's
// pick while every evaluation reads the server's old value (report #836).
// @returns {Promise<boolean>} true when the server accepted the write.
async function pushServerConfig(patch: Record<string, string>): Promise<boolean> {
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function readSavedCliId(): string | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const id = raw ? JSON.parse(raw).cliId : "";
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function persistCliId(cliId: string) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({ ...prev, mode: prev.mode || "cli", cliId }),
    );
    pushServerConfig({ cliId });
  } catch {
    /* quota / private mode */
  }
}

export function readSavedModel(): string | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const model = raw ? JSON.parse(raw).model : "";
    return typeof model === "string" && model ? model : null;
  } catch {
    return null;
  }
}

export function persistModel(model: string) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...prev, mode: prev.mode || "cli", model }));
    pushServerConfig({ model });
  } catch {
    /* quota / private mode */
  }
}

/** 未知雇主策略——词表与优先级规则都住在 unknown-employer.mjs（可被 node --test 直接钉住）。 */
export { UNKNOWN_EMPLOYER_OPTIONS };
export type UnknownEmployerPolicy = (typeof UNKNOWN_EMPLOYER_OPTIONS)[number];

/** 本地镜像值（配置页绘制 / 报告页历史 `?` 行回退显示用）。完整评估不读它。 */
export function readSavedUnknownEmployer(): UnknownEmployerPolicy {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const v: unknown = raw ? JSON.parse(raw).unknownEmployer : "";
    return resolveUnknownEmployer({ local: v });
  } catch {
    return UNKNOWN_EMPLOYER_DEFAULT;
  }
}

/**
 * 服务端（`/api/config` → `~/.career-ops-web/config.json`）持有的策略：**这正是完整评估
 * 实际读取的那个值**（worker 是 headless CLI，读不到 localStorage —— ADR-0004 D3）。
 * 读不到 / 不合法 / 请求失败 → null（未知），调用方保留本地镜像而不是误判为默认档。
 */
export async function readServerUnknownEmployer(): Promise<UnknownEmployerPolicy | null> {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return null;
    const data = (await res.json()) as { unknownEmployer?: unknown };
    return isUnknownEmployerPolicy(data.unknownEmployer)
      ? (data.unknownEmployer as UnknownEmployerPolicy)
      : null;
  } catch {
    return null;
  }
}

/** 只把服务端真值回写本地镜像（报告页回退显示口径与评估一致），不触发新的服务端写入。 */
export function mirrorUnknownEmployer(policy: UnknownEmployerPolicy) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...prev, mode: prev.mode || "cli", unknownEmployer: policy }));
  } catch {
    /* quota / private mode */
  }
}

/**
 * 持久化未知雇主策略到本地镜像 + 服务端 /api/config。
 *
 * 返回服务端是否确认写入 —— 调用方必须把这个 false 显示出来。丢写以前是纯静默的
 * （`catch(() => {})`）：配置页照样显示用户选的档位，而每次评估读到的都是服务端旧值。
 *
 * @returns {Promise<boolean>}
 */
export async function persistUnknownEmployer(policy: UnknownEmployerPolicy): Promise<boolean> {
  mirrorUnknownEmployer(policy);
  return pushServerConfig({ unknownEmployer: policy });
}

export const CONCURRENCY_POOL_DEFAULT = 4;

/**
 * 全局并发上限（服务端持真值）：写入 /api/config（~/.career-ops-web/config.json），
 * 由 global 并发池每次 dispatch 时读取、即时生效。CLI 评估引擎不读 localStorage，
 * 只读服务端配置，所以这里不写 localStorage（与 cliId/model 不同路）。
 */
export async function persistConcurrencyPool(n: number): Promise<boolean> {
  const value = Number.isInteger(n) && n >= 1 ? n : CONCURRENCY_POOL_DEFAULT;
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ concurrencyPool: value }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** 从服务端读取当前全局并发上限；失败回落默认 4。 */
export async function readSavedConcurrencyPool(): Promise<number> {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) return CONCURRENCY_POOL_DEFAULT;
    const d = (await r.json()) as { concurrencyPool?: unknown };
    const v = d.concurrencyPool;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : CONCURRENCY_POOL_DEFAULT;
  } catch {
    return CONCURRENCY_POOL_DEFAULT;
  }
}

export function pickSoleInstalled(
  clis: { id: string; installed?: boolean }[] | undefined,
): string | null {
  const installed = (clis || []).filter((c) => c.installed);
  return installed.length === 1 ? installed[0].id : null;
}

/** Saved Config cliId, or the only installed CLI (and persist that pick). */
export async function resolveCliId(): Promise<string | null> {
  const saved = readSavedCliId();
  if (saved) return saved;
  try {
    const r = await fetch("/api/clis");
    const d = (await r.json()) as { clis?: { id: string; installed?: boolean }[] };
    const sole = pickSoleInstalled(d.clis);
    if (!sole) return null;
    persistCliId(sole);
    return sole;
  } catch {
    return null;
  }
}
