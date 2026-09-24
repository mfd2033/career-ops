# ADR-0057: Pipeline 收件箱批量删除（动真格，删 pipeline.md 行）

- **Status:** Accepted (2026-09-24)
- **Context:** `/pipeline` 页面的 `InboxTriage` 组件已有「批量跳过」能力——把 URL 存入 localStorage 的 `hidden` 数组，从视图中隐藏。但 `data/pipeline.md` 里的原始 URL 行**并没有被移除**。已跳过的 URL 仍占据 Pending 段的篇幅、`scan` 和 `reconcile-pipeline` 脚本仍会遇到它们（normalizeUrl 去重可以挡住一部分，但清理不干净的历史残留会让文件持续膨胀）。用户在「我确定这些残次岗永远不评了」的场景下，需要一个动作真删数据源，让文件瘦身、视野干净。

现有批量操作按钮（批量保存 / 批量跳过 / 清空）全在前端 localStorage 层，**零后端改动**（ADR-0010 决议 4）。这是本功能和 ADR-0010 的核心分水岭——「跳过」是 triage 层，「删除」是数据层。

## Decision

1. **删除 = 从 `data/pipeline.md` Pending 段真删行**，不再走 localStorage `hidden`。Processed 段不动。操作对象严格限定为 `- [ ] URL | 公司 | 职位 | 地点 | note: 来源` 格式的待处理条目（`reconcile-pipeline.mjs` 同一解析器），不触碰注释、空行、Processed 段的已消费行。
   - 理由：和现有「跳过」语义清晰分层——「跳过」= 我不想现在看到，「删除」= 我不想这辈子评这条。两者并存，用户在不同场景选用不同工具。
   - 代价：删除后无 undo（见决议 4 安全网讨论）。

2. **独立后端接口 `POST /api/pipeline/remove`**，不复用 `reconcile-pipeline.mjs`。请求体 `{ urls: string[] }`，响应 `{ removed: number, notFound: number }`。
   - 理由：`reconcile-pipeline` 的职责是「已消费 → 移到 Processed」，有 tracker/batch-state 写回依赖；用户主动删除是一条独立的丢弃路径，两者数据契约正交。独立接口避免 reconcile 被塞入"硬删"语义导致未来维护混乱。
   - 代价：Pipeline 解析逻辑与 reconcile 会有少量重叠（按段匹配 + normalizeUrl 比较 + 行过滤），抽取共享函数或各写一份都可接受，范围小。

3. **加 `pipeline-lock` 锁**（复用 `pipeline-lock.mjs`）。读 pipeline.md → 解析 Pending 段 → normalizeUrl 匹配 → 过滤掉目标行 → 写回。锁确保和 scan / evaluate / reconcile 的并发安全。
   - 理由：pipeline.md 是 CLI scan 和 Web 批量评分的共同数据源，无锁写入会在并发下丢失行。
   - 代价：写操作短暂阻塞；与 reconcile 的串行行为一致。

4. **安全网 = UI 二次确认，仅此而已**。删除前弹窗预览：「将删除 N 条」+ 公司名列表（前 5 条 + "等 N 条"），用户点「确认删除」才执行。不归档、不写备份文件、不加撤销 API。git 历史兜底。
   - 理由：用户明确不要归档层（与 ADR 早期选项分歧时用户拍板 "仅 UI 二次确认"）。pipeline.md 在 git 仓库里，可通过版本控制恢复误删。轻量实现优先。
   - 代价：误删恢复需要 git 操作，非 Web UI 内完成。

5. **前端入口**：`InboxTriage` 的批量操作栏（已有「批量跳过 / 批量保存」按钮的那条）加一个「删除」按钮。只有当 `selected.size > 0` 时出现，和现有槽位同风格。触发确认弹窗 → 调 API → 成功后 `router.refresh()` 让列表更新、清空 `selected`。
   - 理由：沿用量变到质变的交互——用户已习惯全选 + 批量操作的模式，只是从「隐藏」升级为「真删」。
   - 代价：批量操作栏从 3 按钮增至 4 按钮（保存到 Shortlist / 跳过 / 删除 / 清除），需注意按钮文案权重，「删除」应最靠后或用更重的色调（如红色文字）与「跳过」区分。

## Alternatives considered

- **把删除当作 reconcile + 标记为用户丢弃**：代码复用好，但 reconcile 的职责边界会模糊——它消费 batch-state.tsv 和 tracker 来判断"已处理"，用户删除走的是另一条信号（用户主观决策）。混入会让 reconcile 的语义从"已消费"膨胀为"已消费 或 用户丢弃"，未来难拆。弃用。
- **pipeline.md 每行加稳定行 ID**：和 scan.mjs / 各写入端联动成本高；pipeline.md 本身是 markdown，ID 也会让注释和空行处理复杂化。normalizeUrl 匹配已足够精确（`reconcile-pipeline` 和 `merge-tracker` 都用这套）。弃用。
- **前端直接改文件无锁**：开发速度快，但并发下 scan 脚本追加新 URL 时可能丢失前端的删除。不可接受。
- **软删除（归档到独立文件）**：用户明确拒绝。理由是归档文件本身会成为新的技术债，"我删就是真删，git 兜底够了"。

## Consequences

- Pipeline 收件箱拥有两个分层的清理工具：「跳过」（轻量 triage，localStorage 隐藏）和「删除」（重量真删，pipeline.md 行移除）。
- 新增后端 API `/api/pipeline/remove`（Node/Next.js Route Handler），新增 `pipeline-remove.mjs` 或直接内联在 Route Handler 中的 pipeline 解析函数。
- Web 前端 `InboxTriage` 批量操作栏新增「删除」按钮 + 确认弹窗。
- i18n：新增约 6-8 键（zh/en 对称）：`inbox.deleteSelected`、`inbox.confirmDelete.title`、`inbox.confirmDelete.body`、`inbox.confirmDelete.confirm`、`inbox.confirmDelete.cancel`、`inbox.deleteN` 等。
- **不触碰**：Processed 段、`reconcile-pipeline.mjs`、scan.mjs 追加逻辑、localStorage hidden 机制（全部保留，继续工作）。

## 实现拆分（供 to-tickets 参考）

1. 后端：`web/src/app/api/pipeline/remove/route.ts` — 收 urls、加 pipeline-lock、解析 Pending 段、normalizeUrl 过滤、写回、返回统计
2. 后端：共享 pipeline 解析器（从 reconcile-pipeline 抽取或内联，范围小）
3. 前端：确认弹窗组件（`Dialog` / `AlertDialog`）
4. 前端：`InboxTriage` 批量操作栏加「删除」按钮 → 弹窗 → 调 API → refresh
5. i18n：zh/en Cluster 添加相关键
6. 测试：后端 pipeline-remove 逻辑的单元测试（mock pipeline.md），前端按钮 + 弹窗的交互测试
