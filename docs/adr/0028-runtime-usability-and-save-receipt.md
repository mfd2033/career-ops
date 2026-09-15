# ADR-0028: runtime「已安装」与「可用」分离 + 配置保存回执

- **Status:** Accepted (2026-09-15)
- **Context:** 「体检这家」诊断（见 2026-09-15 会话）暴露两个系统性缺陷：① 本机 opencode CLI headless 完全无功能（`--version`/`run` 均 exit 0 但零输出），而 doctor 与 web 的 auto-detect 只探测「二进制存在」就标 installed=true，用户据此选它派发 worker 必然空手而归；② 配置页的 cliId/model 保存（`persistCliId`/`persistModel`）把服务端镜像写入失败**静默吞掉**——用户以为存的是 claude，实际点击浏览器里残留的是 opencode（对比：unknownEmployer 的持久化在 #836 后已强制回执）。决议于 2026-09-15 确认（用户：「都做」）。

## Decision

1. **「已安装（installed）」与「可用（usable）」分离。** installed 语义不变（二进制存在）；新增 usable = installed 且 `--version` 探针在 15s 超时内返回**非空 stdout**。`/api/clis` 每项暴露 `usable` 字段；配置页对 `installed && !usable` 的 runtime 显示「装了但不可用（headless 无输出）」且不作为默认选中候选。
2. **探针纪律：只跑 `--version`。** 最便宜、无副作用；不尝试 `run` 探针（贵、可能有真实副作用）。非零退出、超时、零输出 → unusable。探测结果进既有检测缓存（两层：浏览器侧缓存 + 服务端进程内缓存），仅在手动重检时刷新——首次检测的延迟代价一次性支付。
3. **配置保存回执（#836 模式推广）。** `persistCliId`/`persistModel` 改为返回服务端写入结果（`Promise<boolean>`）；config-form 对 cliId/model 的保存结果必须向用户显示成功/失败——丢写不可见即缺陷。localStorage 写失败（quota/隐私模式）同样报告。
4. **`.env` 的 `CAREER_OPS_CLI` 与 web cliId 的关系保持现状**（web 链路不读它，诊断已确认）；doctor 侧对它的展示不变。本 ADR 不改双源语义。

## Consequences

- 首次检测变慢（8 个 runtime 串行/并行各跑一次 `--version`）——由检测缓存消化，日常调用零新增开销；缓存失效（手动重检）时用户可感知的一次性等待。
- 「装了但坏了」的 runtime 从「静默选了必败」变为「配置页可见 + 不作默认」——但**不禁止**显式选择它（用户可能想先修 CLI）。
- cliId/model 的服务端镜像缺失从「无声」变为「有报错」，用户能立即发现保存未生效并重试——本次诊断的直接教训。
- doctor 增加一条 headless 可用性检查行，与环境类失败的可见性纪律一致。
