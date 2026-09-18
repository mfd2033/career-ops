# ADR-0042: 任务进度上报与展示（粗阶段 + 工具透传 + 批量逐项清单）

- **Status:** Accepted (2026-09-18)
- **Context:** 任务详情页（`web/src/app/jobs/[id]/page.tsx`）对运行中任务只显示「处理中」徽标（页头）和一个固定追加的「思考中…」spinner 行（215–219 行）——后者在 worker 跑完前不携带任何真实信息，对中断残留任务（`interruptedAt` 非空）还会永远转圈，是现存谎言。业务阶段发生在 claude worker 内部（跑 skill/mode），route 层默认看不见；前后端其实已有完整事件通道（`/api/run` → run-events 总线 → `/api/events` SSE → job-store `steps` 渲染，ADR-0020），但服务端从不发布业务进度——唯一先例是 PDF 渲染前的 "Rendering PDF…" status。约束：
  1. fork 政策（ADR-0022）禁止侵入 `modes/_shared.md` 等系统层做显式阶段标记（`<<phase:…>>`），否则每次 upstream merge 踩锚点。
  2. 诚实门禁哲学（批量评估/批量体检的 `ok=0&&failed>0→error` 同源）禁止伪进度条、ETA、编造的业务阶段。
  3. 批量 worker 是纯文本模式（`spawnHeadlessCli --print`），没有 stream-json 工具事件可透传。
  4. job-store 把 `steps` 持久化到 localStorage，无界增长有存储风险（本机有过 98GB 临时文件惨案，对无界增长敏感）。
  5. 非批量单任务统一走 `/api/run`（evaluate/checkup/pdf/research/fix-portal 六 kind 分派），改动集中一处。
- **Scope:** `web/src/app/api/run/route.ts`（粗阶段发布 + tool_use 透传）；`web/src/components/jobs/job-store.tsx`（步骤滚动窗口、中断冻结、阶段状态）；`web/src/app/jobs/[id]/page.tsx` 与 `web/src/components/jobs/worker-card.tsx`（阶段徽章/步骤清单 UI）；`web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/batch-checkup/route.ts`（item 事件同步写登记表）；新增 `web/src/lib/batch-items.mjs`（进程内逐项登记表，镜像 `checkup-live.mjs` 模式）+ `GET /api/batch-items`；`web/src/lib/i18n/clusters/jobs.ts`（文案，中英双份）。**不改动**：`modes/*` 系统层、concurrency-pool 通道与 `/api/active-runs`（扩展源任务卡片，另立项）、run ledger 落盘格式、ADR-0031 对账机制。

## Decision

1. **单任务阶段 = 三段粗阶段，全部是 route 层自己真实执行的节点**：`queued`（等并发池槽位）→ `running`（worker 已启动）→ `finalizing`（worker 结束后 route 自己做的事：pdf 渲染 / 体检产物校验落盘，各 kind 收尾段）→ 终态（done/error，无阶段）。零业务推断、零系统层改动。阶段事件复用现有 status 事件类型（新增专用 label 约定），job-store 端识别为阶段而非普通步骤。
2. **运行中段黑盒的缓解 = 透传 worker 原始工具调用**：route 解析 claude stream-json 的 `tool_use` 事件，把工具名与参数摘要**原样**转发为步骤行（「调用 WebFetch: company.com」「调用 Bash: log-checkup.mjs」）。不是业务推断、不撒谎——用户的「卡了还是在动」疑问由真实滚动的事件流直接消除。仅 claude 引擎有 stream-json；其他引擎无此数据源，如实降级为只有粗阶段。
3. **步骤音量 = 滚动窗口**：内存保留最近 50 条工具步骤，localStorage 持久化时截断到最近 20 条。不做同类折叠（实现复杂且刷新后折叠状态丢失）。
4. **不做百分比 / ETA / 伪进度条**：单任务时长方差极大（体检 2~30 分钟），任何估算都是编造。批量场景的 x/n 是确定性真计数，允许显示。
5. **批量详情页 = 计数行 + 逐项清单**：计数行「正在处理第 i/n 家」（来自批量已有 `[i/n]` status 事件）；逐项清单由 item 事件实时点亮（✅/⚠️/跳过/失败+reason，失败 reason 承接 ADR-0041 决议 6 的观测性改进）。**不透传 worker 文本**——纯文本模式下的中间输出混着报告草稿，刷屏且无消费价值。
6. **批量逐项真相源 = 服务端进程内登记表**（镜像 `checkup-live.mjs` 模式）+ `GET /api/batch-items?batchId=`：批量流没有 /api/run 意义上的 runId（NDJSON 响应体不携带标识），故由批量路由生成 `batchId`、经首个 `open` 事件下发，item 事件同步写入登记表，GET 按 batchId 查询（未知/已淘汰返回 404，与空清单区分）。实现期为覆盖「本页签流式累积丢失」的场景，前端采用 running 期间每 3s 轮询对账（本地累积优先合并），而非实现前预想的「拉一次」——语义更强，成本可忽略（单进程本地请求）。登记表生命周期与批量 run 一致，进程重启即消失——此刻正在跑的批量本也会死，语义自洽。不落盘 ledger（历史回看属后续可选项）。
7. **中断任务 = 冻结 + 标记**：`interruptedAt` 非空的 running 卡片在详情页冻结显示最后已知阶段 + 明显的「已中断」标记，spinner 停转。修复「死任务永远转圈」这个现存谎言。

## Alternatives considered

- **显式阶段上报（改 mode/skill 文件输出 `<<phase:…>>` 标记）**：最精确（可到体检单因子），但侵入 `modes/_shared.md` 等系统层，每次 upstream merge 有 ADR-0022 锚点 tripwire；否。
- **包装层推断（tool_use → 业务阶段标签映射，如「正在体检因子3」）**：比原始透传更「好看」，但映射是启发式猜测，claude 换工具顺序即失准——「正在体检因子3」是把猜测当事实，与不编造哲学冲突；否。
- **同类工具折叠 / 全量保留步骤**：折叠实现复杂、刷新状态丢失；全量有 localStorage 膨胀风险；均否，滚动窗口已覆盖「最近在干嘛」需求。
- **批量清单仅客户端累积**：刷新即丢，体验有洞；服务端登记表成本低（现成蓝本），收益确定。
- **历史任务步骤回放**：run ledger 只记终态，回放需改落盘格式，超出本次范围；后续可选。

## Consequences

- 「思考中…」兜底行退役为最后兜底（仅无任何阶段/步骤信息时出现）；详情页运行中可见：阶段徽章 + 已耗时 + 最近工具调用滚动，且中断任务不再转圈。
- 批量详情页可回答「哪几家已出、哪几家没出、失败为什么」，且刷新后清单可恢复。
- 非 claude 引擎的单任务只有粗阶段、无工具步骤——如实降级，不做假步骤。
- tool_use 透传增加 `/api/events` 流量（每次工具调用一条事件）；滚动窗口保证前端与 localStorage 成本有界。
- 扩展源（浏览器插件派发）任务卡片走 concurrency-pool/`/api/active-runs` 通道，本次不含，仍是固定「处理中」；动面（PoolTaskMeta 加字段）已在 Scope 外显式排除。
- `/api/run` 需要为 stream-json 模式解析 `tool_use` 子事件：现有 `spec.parseEvent` 只处理传输层状态，需扩一层（不动各 CLI spec 的既有语义）。

## References

- ADR-0020（worker 事件多路复用，事件通道蓝本）、ADR-0022（fork 锚点层——显式阶段上报被否的直接原因）、ADR-0025/0030（体检通路与产物门禁，`finalizing` 段语义）、ADR-0041（批量体检，item 事件与诚实汇总语义来源）。
- `web/src/app/api/run/route.ts`（单任务编排 + renderPdf 先例）、`web/src/app/api/batch-evaluate/route.ts` / `web/src/app/api/batch-checkup/route.ts`（NDJSON item 事件源）、`web/src/lib/checkup-live.mjs`（登记表蓝本）、`web/src/components/jobs/job-store.tsx`（steps 渲染与 localStorage 持久化）、`web/src/app/jobs/[id]/page.tsx`（「思考中…」兜底行所在）。
- 术语表：`docs/glossary-job-progress.md`。
