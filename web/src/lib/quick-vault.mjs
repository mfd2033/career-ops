// quick-vault.mjs — 快评密钥库核心纯逻辑（ADR-0083）。
//
// 一把密钥 = 一份完整配置束（密钥束）：名称 + provider + 模型 + 端点 + 密钥串，
// 捆绑切换；库里恰有一把「使用中」，点选即切换、切换即生效（绕开保存条）。
//
// 落盘唯一入口是 gitignore 的 data/quick-eval.json（v2 形状），原子写
// （临时文件 + rename）。v1 单密钥文件在首次读取时自动迁移：旧密钥成为名为
// 「默认」的使用中密钥，旧文件改名 .v1.bak 留回滚窗口，迁移只发生一次（幂等）。
//
// 安全不变量（自 v1 延伸）：明文密钥永不离开服务端——vaultView 只回打码串
// （前 6 + 后 4，不可还原），编辑时密钥字段留空 = 保持原密钥不变。
//
// 本文件刻意不依赖构建/路径别名，node --test 可直接 import（单测同规格）。

import fs from "node:fs";
import path from "node:path";

const CONFIG_REL = path.join("data", "quick-eval.json");

export const VAULT_VERSION = 2;

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** 打码串：前 6 + … + 后 4；过短的密钥只露前 3，绝不接近全量回显。 */
export function maskKey(key) {
  const k = String(key || "");
  if (!k) return "";
  if (k.length <= 10) return k.slice(0, 3) + "…";
  return `${k.slice(0, 6)}…${k.slice(-4)}`;
}

/** 本地日期的 YYYY-MM-DD（addedAt 展示用，不做时区矫饰）。 */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 密钥 id：时间戳 36 进制 + 随机尾。本地单文件，碰撞概率可忽略。 */
export function genKeyId(now = Date.now()) {
  return `k${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyVault() {
  return { version: VAULT_VERSION, keys: [], activeId: null };
}

/** 动作层共用的错误：带稳定 code 供路由映射 HTTP 状态，消息绝不含密钥。 */
export class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** 单条密钥束的消毒：字段全部收敛为字符串；没有密钥串的不算一把密钥 → null。 */
function normalizeKey(raw) {
  if (!raw || typeof raw !== "object") return null;
  const key = str(raw.key);
  if (!key) return null;
  return {
    id: str(raw.id) || genKeyId(),
    name: str(raw.name),
    provider: str(raw.provider),
    model: str(raw.model),
    baseUrl: str(raw.baseUrl),
    key,
    addedAt: str(raw.addedAt) || today(),
    lastTest: raw.lastTest === "ok" || raw.lastTest === "fail" ? raw.lastTest : "",
  };
}

/** 库整体的消毒：丢坏条目、去重 id；activeId 悬空时回落第一把（或 null）。 */
export function normalizeVault(raw) {
  const keys = [];
  const seen = new Set();
  for (const k of Array.isArray(raw?.keys) ? raw.keys : []) {
    const nk = normalizeKey(k);
    if (nk && !seen.has(nk.id)) {
      seen.add(nk.id);
      keys.push(nk);
    }
  }
  let activeId = str(raw?.activeId);
  if (!keys.some((k) => k.id === activeId)) activeId = keys.length ? keys[0].id : null;
  return { version: VAULT_VERSION, keys, activeId };
}

/** v1 形状：没有 version、顶层带非空 apiKey 的单配置对象。 */
function isV1(raw) {
  return Boolean(raw) && typeof raw === "object" && raw.version === undefined && str(raw.apiKey) !== "";
}

/** v1 → v2：旧密钥成为第一把名为「默认」的密钥并置为使用中。 */
export function migrateV1(v1) {
  return normalizeVault({
    version: VAULT_VERSION,
    keys: [
      {
        id: genKeyId(),
        name: "默认",
        provider: v1.provider,
        model: v1.model,
        baseUrl: v1.baseUrl,
        key: v1.apiKey,
        addedAt: today(),
      },
    ],
    activeId: null,
  });
}

/**
 * 读库。文件不存在/JSON 损坏 → 空库（configured=false，绝不抛）。
 * 读到 v1 → 内存里完成迁移：先把旧文件改名 .v1.bak（回滚窗口），再原子写 v2。
 * 写盘失败（只读盘等）不影响本次返回：迁移会在下次启动重试。
 */
export function readVault(root) {
  const file = path.join(root, CONFIG_REL);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return emptyVault();
  }
  if (isV1(raw)) {
    const vault = migrateV1(raw);
    try {
      fs.renameSync(file, `${file}.v1.bak`);
      writeVault(root, vault);
    } catch {
      /* 迁移落盘失败：内存里仍可用，下次读取重试迁移 */
    }
    return vault;
  }
  if (raw && raw.version === VAULT_VERSION) return normalizeVault(raw);
  // 未知 version（未来的 v3 被旧代码读到等）→ 按空库处理而不是猜形状。
  return emptyVault();
}

/** 原子写：临时文件 + rename。旧 writeQuickConfig 注释写「原子写」实为直写，此处修正。 */
export function writeVault(root, vault) {
  const file = path.join(root, CONFIG_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(vault, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export function activeKey(vault) {
  return vault.keys.find((k) => k.id === vault.activeId) || null;
}

/** 密钥束 → quick-eval 执行路径认识的旧配置形状。 */
export function toQuickConfig(k) {
  if (!k) return null;
  return { provider: k.provider, model: k.model, baseUrl: k.baseUrl, apiKey: k.key };
}

/** 对外库视图：只有打码串，没有任何形态的明文密钥（ADR-0083 决议 3）。 */
export function vaultView(vault) {
  return {
    configured: Boolean(activeKey(vault)),
    activeId: vault.activeId,
    keys: vault.keys.map((k) => ({
      id: k.id,
      name: k.name,
      provider: k.provider,
      model: k.model,
      baseUrl: k.baseUrl,
      masked: maskKey(k.key),
      addedAt: k.addedAt,
      lastTest: k.lastTest,
    })),
  };
}

// ── 库动作（纯函数：返回新 vault，不改入参） ────────────────────────────

/** 存入新密钥：不自动启用——除非库里原本没有使用中密钥（与迁移语义一致）。 */
export function vaultAdd(vault, fields) {
  const nk = normalizeKey({ ...fields, id: genKeyId(), addedAt: today() });
  if (!nk) throw new VaultError("keyRequired", "一把密钥至少要有密钥串");
  const next = { version: VAULT_VERSION, keys: [...vault.keys, nk], activeId: vault.activeId };
  if (!next.activeId) next.activeId = nk.id;
  return { vault: next, key: nk };
}

/** 更新密钥束：字段 undefined = 不动；密钥留空 = 保持原密钥不变（决议 3）。 */
export function vaultUpdate(vault, id, fields) {
  const cur = vault.keys.find((k) => k.id === id);
  if (!cur) throw new VaultError("keyNotFound", "库里没有这把密钥");
  const updated = { ...cur };
  for (const f of ["name", "provider", "model", "baseUrl"]) {
    if (fields[f] !== undefined) updated[f] = str(fields[f]);
  }
  const newKey = str(fields.key);
  if (newKey) {
    updated.key = newKey;
    // 换绑新密钥后上次测试结果不再描述当前这束配置，清掉免得误导（工单 04 依赖此语义）。
    updated.lastTest = "";
  }
  const keys = vault.keys.map((k) => (k.id === id ? updated : k));
  return { vault: { ...vault, keys }, key: updated };
}

/** 删除：物理删掉密钥串；删的是使用中那把 → 自动切剩余第一把（或 null）。 */
export function vaultRemove(vault, id) {
  const cur = vault.keys.find((k) => k.id === id);
  if (!cur) throw new VaultError("keyNotFound", "库里没有这把密钥");
  const keys = vault.keys.filter((k) => k.id !== id);
  let activeId = vault.activeId;
  const removedActive = activeId === id;
  if (removedActive) activeId = keys.length ? keys[0].id : null;
  return { vault: { ...vault, keys, activeId }, removedActive };
}

/** 切换使用中：点选即生效的落盘动作。id 不存在直接报错，绝不静默造一把。 */
export function vaultActivate(vault, id) {
  if (!vault.keys.some((k) => k.id === id)) throw new VaultError("keyNotFound", "库里没有这把密钥");
  return { ...vault, activeId: id };
}

/** 记录一次连接测试结果（工单 04 的执行端调用）。 */
export function vaultSetTest(vault, id, ok) {
  if (!vault.keys.some((k) => k.id === id)) throw new VaultError("keyNotFound", "库里没有这把密钥");
  const keys = vault.keys.map((k) => (k.id === id ? { ...k, lastTest: ok ? "ok" : "fail" } : k));
  return { ...vault, keys };
}

/**
 * 连接测试失败分类（ADR-0083 工单 04）：纯函数，界面文案按类别给可操作步骤。
 * 只吃状态码/是否超时/是否网络异常，绝不接触密钥内容。
 */
export function classifyProbeFailure({ status = 0, aborted = false } = {}) {
  if (aborted) return "timeout";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "notFound";
  if (status >= 400) return "http";
  return "network";
}

/**
 * action 分发：PUT body → 新 vault + 附加结果。路由只做 HTTP 壳，
 * 语义全部收在这（可被 node --test 直接锁死）。写路径唯一：无 action
 * 即 unknownAction——旧的「单密钥整体覆盖」过渡桥已随密钥库 UI 收口删除。
 */
export function applyVaultAction(vault, body) {
  const action = str(body?.action);
  switch (action) {
    case "add":
      return vaultAdd(vault, body);
    case "update": {
      const id = str(body?.id);
      if (!id) throw new VaultError("idRequired", "缺少密钥 id");
      return vaultUpdate(vault, id, body);
    }
    case "remove": {
      const id = str(body?.id);
      if (!id) throw new VaultError("idRequired", "缺少密钥 id");
      return vaultRemove(vault, id);
    }
    case "activate": {
      const id = str(body?.id);
      if (!id) throw new VaultError("idRequired", "缺少密钥 id");
      return { vault: vaultActivate(vault, id) };
    }
    default:
      throw new VaultError("unknownAction", "不认识的动作");
  }
}
