# ADR-0022: fork 系统层锚点化 + git merge 同步，弃用 update-system apply

- **Status:** Accepted (2026-09-14)
- **Supersedes:** 无（首次成文；实际取代的是「直接改系统层文件 + 依赖 update-system #2337 守卫」的默认做法）
- **Context:** 本仓库是 santifer/career-ops 的 fork，只能拉上游、无上游写权限。fork 对系统层（scan.mjs / url-key.mjs）有一批必要修复（CN 招聘站反爬参数纳入去重键、pipeline.md 写入点去重兜底），而 `update-system.mjs apply` 的同步方式是「从上游 checkout 覆盖工作区」——纯覆盖、不做合并，每次更新都会把本地修复抹掉（d9d7cf4 就面临这个问题）。原方案「保留大块 diff + tripwire 测试 + 更新后 cherry-pick 重放」可防数据丢失，但每次更新都是一次手工防守，且系统层 diff 越积越大、与上游的冲突面随之增长。

## Decision

三条，均为 2026-09-14 与用户逐条确认：

1. **更新流程切换**：本 fork 的系统更新一律 `git fetch upstream && git merge upstream/main`（三方合并，本地提交自动融合，冲突显式暴露），**彻底弃用 `update-system.mjs apply`**。`check` 报 `system-files-changed` 属预期（fork 本就有系统层差异），按已 dismiss 处理。备份/回滚走 git（reflog / revert），不用 update-system 的 backup 分支。
2. **系统层只留锚点，逻辑外置**：`scan.mjs` / `url-key.mjs` 里只保留合计约 15 行的 `FORK-LOCAL anchor`（一处 `await import('./local/…')` + 一行调用 + 尾部 `export { TRACKING_PARAMS }` + 参数注入 try/catch），全部逻辑住进 gitignored 的 `local/`（`scan-dedup.mjs`、`dedup-params.mjs`）。以后加新站去重参数**只改 `local/dedup-params.mjs`**，零 git 操作、零冲突面。锚点降级语义统一：`local/` 缺失（换机器 clone）→ 打一行 warn 后按上游原行为运行，不阻塞主链路。
3. **fork-local 测试 gitignored**：锚点与 local/ 层的回归测试命名为 `tests/local-*.test.mjs` / `web/tests/lib/local-*.test.mjs` 并 gitignore——test-all.mjs 按目录扫描发现（不看 git 状态），照常自动运行；同时躲过 apply 对 `tests/` 的 tracked-prune 与上游 merge 冲突。revert d9d7cf4 后其 CN 站用例在 `tests/local-scan-dedup.test.mjs` 以 tripwire 形态重建。

## Alternatives（为何不选）

- **保留 d9d7cf4 + tripwire/cherry-pick 防守**：能防丢失但每次更新都是手工动作，系统层 diff 持续膨胀，冲突面只增不减。
- **revert 后忍（不改键，靠写入点兜底吸收）**：pipeline.md 膨胀可堵，但 CN 站每轮扫描都重新「发现」同一批职位，scan-history 持续长重复行、扫描噪音大。
- **`--experimental-loader` 运行时替换模块**：不改系统文件但脆弱——漏一条调用路径（插件、CLI、test-all）就静默失效，正是 2026-09-14 事故的同款失败模式。
- **`config/local-paths.txt` 声明 scan.mjs/url-key.mjs**：被 update-system 明确拒绝（「the system layer ships it」），设计上禁止冻结系统文件。

## Consequences

- **系统层分歧压缩到 ~15 行锚点**：上游改 `DEDUP_STRIP_PARAMS`、`TRACKING_PARAMS` 数组、`appendToPipeline` 主体时，三方合并自动通过；只有上游重构锚点所在函数时才显式冲突，按本 ADR 重接。
- **web/扩展侧不加载 fork-local 参数**（浏览器无 fs）：`web/src/lib/core/url-key.mjs` 与扩展 core 副本只覆盖核心清单（CN 参数本就在其中，来自更早的扩展 parity 提交）。将来经 `local/dedup-params.mjs` 新增的参数对 web/扩展侧不生效，需另行硬编码——已知取舍，parity 测试只锁核心清单。当前 `extraTrackingParams` 为空，两侧行为一致。
- **新鲜 clone 降级可见**：clone 后没有 gitignored 的 `local/`，锚点 warn + 上游行为，tripwire 测试红——README（`local/README.md`）与 ADR-0022 是恢复指引。`config/local-paths.txt` 声明 `local/` 作为误跑 apply 的保险。
- **上游收录仍是正解**：锚点化解决「本地不被覆盖」，但不解决「上游缺这个修复」。若上游采纳（issue/PR，无需写权限——fork PR 是标准流程），`local/scan-dedup.mjs` 的去重扩展可整体删除，仅保留空配置层。
- **revert 链**：`d9d7cf4`（统一键）→ `01131d9`（写入点去重）的外置重建分别由 `local/scan-dedup.mjs` 的 `forkStripParam` 与 `localDedupeOffers` 承载；行为与本 ADR 之前的 fork 状态逐字节等价（测试验证）。
