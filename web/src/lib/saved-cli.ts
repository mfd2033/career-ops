import {
  UNKNOWN_EMPLOYER_OPTIONS,
  UNKNOWN_EMPLOYER_DEFAULT,
  isUnknownEmployerPolicy,
  resolveUnknownEmployer,
} from "./unknown-employer.mjs";
import { reconcileEnginePick } from "./model-ownership.mjs";

export const CONFIG_KEY = "career-ops:config";

// Mirror the selected CLI/model onto the server (/api/config) so the BOSS直聘
// extension can reuse it without re-asking. Best-effort in the sense that it
// never throws — but it now REPORTS the outcome, because for `unknownEmployer`
// a lost write is invisible otherwise: the client store still shows the user's
// pick while every evaluation reads the server's old value (report #836).
// @returns {Promise<boolean>} true when the server accepted the write.
/** ADR-0028 决议 3：导出给 config-form——cliId/model 的保存回执必须可见，
 *  静默丢写正是「以为存了 claude、实际派发了 opencode」的根因（#836 同教训）。 */
export async function pushServerConfig(patch: Record<string, string>): Promise<boolean> {
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

/** `/api/clis` 响应里 `persistCliId` 需要的那一小片：模型目录就是归属判定的证据。 */
export type CliCatalogRow = { id: string; model?: { options?: { id: string }[] } };

/**
 * 落盘选中的 CLI —— 同时校正 model（ADR-0073 决议 3）。
 *
 * 只 POST `{cliId}` 是那次 `claude + hy3` 事故的产地：`hy3` 是 CodeBuddy 目录里的模型，
 * 而「换了引擎没换模型」在以前这条路径上根本不会被发现。现在带上了 `clis` 目录作证据：
 * 判定为脏组合时一并 POST `model: ""`（`/api/config` 对空串就是删除该键）。
 *
 * @param {string} cliId
 * @param {CliCatalogRow[]} [clis] - 本机引擎目录；不传 = 没有证据，保守地不动 model
 */
export function persistCliId(cliId: string, clis?: CliCatalogRow[]) {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    const picked = reconcileEnginePick({
      cliId,
      model: typeof prev.model === "string" ? prev.model : "",
      modelCliId: typeof prev.modelCliId === "string" ? prev.modelCliId : "",
      clis: clis || [],
    });
    const patch: Record<string, string> = { cliId };
    if (picked.dropped) patch.model = "";
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        ...prev,
        mode: prev.mode || "cli",
        cliId,
        model: picked.model,
        modelCliId: picked.modelCliId,
      }),
    );
    void pushServerConfig(patch);
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

/**
 * 引擎模式的默认工具：本机安装的第一个可用 CLI。
 * `usable === false`（装了但 headless 探针无输出，ADR-0028）的先跳过；
 * 全部不可用时退回第一个 installed，至少让用户看到一个可选值；
 * 一个都没装才返回 null。以前只在「恰好装了一个」时给默认值，
 * 多装几个的场景下拉虽高亮但不持久化，派发端读到的是空配置。
 */
export function pickDefaultInstalled(
  clis: (CliCatalogRow & { installed?: boolean; usable?: boolean })[] | undefined,
): string | null {
  const list = clis || [];
  const firstUsable = list.find((c) => c.installed && c.usable !== false);
  const firstInstalled = list.find((c) => c.installed);
  const pick = firstUsable || firstInstalled;
  return pick ? pick.id : null;
}

/**
 * Saved Config cliId, or the first installed CLI (and persist that pick).
 *
 * 这条落盘通道只服务派发（ADR-0073 决议 2）：点「评估」是用户的显式动作，而服务端镜像
 * 必须与派发卡片显示的引擎一致 —— 配置页打开时不再走这里（见 config-form.applyClis）。
 * 传 `list` 是为了让 persistCliId 拿到模型目录做校正，别把别家的模型带上新引擎。
 */
export async function resolveCliId(): Promise<string | null> {
  const saved = readSavedCliId();
  if (saved) return saved;
  try {
    const r = await fetch("/api/clis");
    const d = (await r.json()) as {
      clis?: (CliCatalogRow & { installed?: boolean; usable?: boolean })[];
    };
    const list = d.clis || [];
    const pick = pickDefaultInstalled(list);
    if (!pick) return null;
    persistCliId(pick, list);
    return pick;
  } catch {
    return null;
  }
}
