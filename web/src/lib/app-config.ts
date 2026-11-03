// Server-side mirror of the web config the extension needs to "reuse the
// configured CLI + model": the config page keeps cliId/model in localStorage
// (saved-cli.ts), which a browser extension on a different origin CANNOT read.
// When the user picks a CLI/model there, saved-cli.ts POSTs the pair here; the
// extension (and the /api/config route) reads it back. Kept OUTSIDE the
// career-ops checkout so it survives across installs and never pollutes the
// user's data repo. Absent file → empty config (fallback picks sole installed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeCliDirs } from "./cli-dirs.mjs";
import { sanitizeSkillDirs } from "./skill-registry.mjs";

export type UnknownEmployerPolicy = "placeholder" | "agency";

export type AppConfig = {
  cliId?: string;
  model?: string;
  unknownEmployer?: UnknownEmployerPolicy;
  concurrencyPool?: number; // global CLI-concurrency cap; default 4 (see concurrency-pool.ts)
  /** ADR-0097：用户为某个引擎指定的安装目录（引擎 id → 绝对路径）。检测与派发
   * 都读它，所以它必须住服务端——派发是 headless 子进程，读不到 localStorage。 */
  cliDirs?: Record<string, string>;
  /** 用户手动指定的技能安装目录（绝对路径）：/api/skills 展示与体检派发共用同一
   * 扫描器，额外目录也必须住服务端，理由同上。 */
  skillDirs?: string[];
};

export const UNKNOWN_EMPLOYER_OPTIONS: readonly UnknownEmployerPolicy[] = ["placeholder", "agency"];

/** Persistent location for the salvageable web-level config (not the checkout). */
export function appConfigPath(): string {
  return path.join(os.homedir(), ".career-ops-web", "config.json");
}

export function readAppConfig(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(appConfigPath(), "utf8"));
    const out: AppConfig = {};
    if (typeof raw.cliId === "string" && raw.cliId) out.cliId = raw.cliId;
    if (typeof raw.model === "string" && raw.model) out.model = raw.model;
    // 未知雇主策略只认两个白名单枚举；其余值（含脏值）一律忽略。
    if (UNKNOWN_EMPLOYER_OPTIONS.includes(raw.unknownEmployer)) out.unknownEmployer = raw.unknownEmployer;
    // 并发上限必须是 >=1 的整数；脏值/越界一律忽略（池回落到默认 4）。
    if (typeof raw.concurrencyPool === "number" && Number.isInteger(raw.concurrencyPool) && raw.concurrencyPool >= 1) {
      out.concurrencyPool = raw.concurrencyPool;
    }
    // 指定目录表过纯函数清洗（非法键、非绝对路径都会消失）：一个不可解析的目录
    // 不该被带到派发路径上。`~` 按运行这个服务的用户 home 展开。
    const cliDirs = sanitizeCliDirs(raw.cliDirs, os.homedir());
    if (Object.keys(cliDirs).length > 0) out.cliDirs = cliDirs;
    // 手动指定的技能目录同样过纯函数清洗：默认清单里已有的、重复的、不可解析的
    // 一概丢弃，避免扫描时同一目录被算两次。
    const skillDirs = sanitizeSkillDirs(raw.skillDirs, os.homedir());
    if (skillDirs.length > 0) out.skillDirs = skillDirs;
    return out;
  } catch {
    return {};
  }
}

export function writeAppConfig(cfg: AppConfig): AppConfig {
  const dir = path.dirname(appConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(appConfigPath(), JSON.stringify(cfg, null, 2));
  return cfg;
}