# ADR-0084: 黑名单临时豁免——`Exempt until` 日期列 + 门禁命中记 done 而非 error

## 状态

Accepted (2026-10-17)

## 背景

`data/blacklist.md` 是用户层的「不投递公司清单」（opt-in，永不自动写入），此前是固定 4 列表格
`Company | Since | Scope | Reason`，被 `scan.mjs` 与 `auto-pipeline`/`oferta`/`apply` 门禁遵守，
且「永不改变任何评分」——它是门禁，不是信号。

两个真实问题促成本决策：

1. **无覆盖通道**：headless 运行（`/api/run`）里命中黑名单时，没有用户可以当场给出「确认覆盖」，
   按门禁规则 worker 只能硬停在 Block A 之前。想临时放行某家跑一次，唯一办法是手工删整条记录、
   跑完再凭记忆补回，极易遗漏导致该公司永久失去拦截。
2. **门禁命中被误记为 error**：2026-10-17 12:28 那次对已拉黑公司的评估，worker 正确停在门禁、
   没写报告，但落盘门禁（`persistRunOutcome`）把「干净退出 + 有输出 + 无新报告」判成
   `This evaluation didn't save a report` 的 error，并提示「重跑验证」——而重跑必然以同样的门禁停止告终。
   把「按设计拦截」显示成「失败待重试」，既误导又诱导无效重跑。

诊断过程中一度怀疑存在 D 盘/F 盘两份数据分叉，经证伪：`D:\workspace` 是指向 `F:\workspace` 的
目录联接（Junction），`career-ops` 只有一份物理数据，run 日志里的 `F:\` 路径即联接解析后的物理路径。
故本 ADR 不含任何跨盘路径处理。

## 决策

1. **新增第 5 列 `Exempt until`**：表头变为 `Company | Since | Scope | Exempt until | Reason`。
   - 空 = 强制拦截（默认，与旧行为一致）；填未来日期 = 该日期（含当天）前临时放行；
     日期一过 = 门禁自动恢复拦截，无需人工复位。
   - 采用**日期**而非「放行一次即失效」的计数标记：日期天然支持「这周再看看」的窗口式放行，
     且过期自愈不依赖额外状态机。
   - 豁免**不改任何评分**，沿用既有「门禁非信号」规则。
2. **生效范围只覆盖评估/申请门禁，不含扫描**：`oferta`/`auto-pipeline`/`apply` 读 `Exempt until` 并遵守；
   `scan.mjs` 保持严格——豁免期内该公司仍被扫描跳过，避免把已拉黑的刷屏岗重新灌回结果。
   但 `scan.mjs` 的表格解析器必须**容忍新列**（按表头名取列，不假设列数），不得因第 5 列报错。
3. **建议行与数据契约同步为 5 列**：`rejection-latency.mjs` 生成的可复制黑名单建议行补齐 `Exempt until`
   占位（默认空），`DATA_CONTRACT.md` 的 `data/blacklist.md` 条目更新为 5 列格式说明。
4. **门禁命中改记 done，复用体检 `alreadyCurrent` 范式**：
   - 门禁命中时，`modes/oferta.md`（及 auto-pipeline/apply 门禁）输出一行稳定机器标记
     `[[BLACKLIST-GATE]] company=<名>`——采用**确定性标记**而非启发式匹配 worker 正文，
     避免措辞漂移导致漏判（本 fork 不拉上游更新，改系统层 mode 文案安全）。
   - `run-cli-support.mjs` 新增纯函数 `detectBlacklistGate(stdoutTail)`；`persistRunOutcome` 收到
     `blacklistGate:true` 时返回 `{ ok:true, blockedByBlacklist:true, message:"命中黑名单，已按规则停止——门禁的正常结果，非失败" }`。
   - `route.ts` 的 evaluate 终态段：命中该分支时发 ℹ️ 说明文本 + `doneEvent()`，卡片显示「命中黑名单，按规则停止」，
     不再记 error、不再提示无谓重跑。未引入第三终态 `blocked`——`done`+说明足以表达语义，且不动
     `job-store`/运行账本/任务卡 UI 的状态枚举。

## 后果

- `data/blacklist.md` 的写路径从「agent 手工编辑」扩展到 web `/api/blacklist`（增删 + 设/清 `Exempt until`）；
  每次批量改写数据层前仍须先跑 `local\backup-data.cmd`（影子备份规程）。
- 一次「按设计拦截」的评估在账本里从 error 变为带说明的 done，`stats.mjs`/漏斗不再把门禁停止计入失败。
- 消费方对表格列数的假设被显式解除：任何按位置解析 `blacklist.md` 的代码都要改成按表头名取列。
- 回滚：删掉 `Exempt until` 列即回到 4 列世界（旧解析器忽略多余列即可）；`[[BLACKLIST-GATE]]` 标记与
  `detectBlacklistGate` 移除后，门禁命中退回「无报告 → error」的旧行为。
