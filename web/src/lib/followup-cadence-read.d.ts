// followup-cadence-read.mjs 的类型声明（房规 ADR-0050：纯模块 + 同族 d.ts）。

/** 解析结果：core 输出里的三块载荷；缺失键补 null（entries 归一为空数组）。 */
export type CadenceRead = {
  metadata: unknown;
  entries: unknown[];
  cadenceConfig: unknown;
};

/** 解析 core 的 JSON stdout：从第一个 `{` 起；不可解析（非字符串 / 无 `{` / 坏 JSON）→ null。 */
export function parseCadenceStdout(stdout: unknown): CadenceRead | null;
