# Glossary — 任务进度上报与展示

协同阅读：`docs/adr/0042-job-progress-display.md`

## 阶段与步骤

- **粗阶段（phase）**：route 层自己真实执行的编排段——`queued`（排队等并发池槽位）/ `running`（worker 已启动）/ `finalizing`（收尾）；终态无阶段。不是 worker 内部的业务阶段——本功能刻意不定义业务阶段（ADR-0042 被否的方案 B/A 均源于此）。
  _Avoid_: 业务阶段、进度百分比（本功能明确不做）
- **收尾段（finalizing）**：worker 结束后 route 自己做的事——pdf 渲染、体检产物校验落盘。各 kind 的收尾动作不同，但都是 route 可见的真实节点。
- **工具步骤（tool step）**：worker 原样透传的工具调用条目（「调用 WebFetch: company.com」）。仅 claude 引擎有（stream-json 数据源），其他引擎如实没有。
  _Avoid_: 阶段（工具步骤不是阶段）、操作日志
- **原始透传（verbatim forwarding）**：只转发工具名与参数摘要，不翻译、不映射业务语义。与「包装层推断」的区别就在这——推断会把猜测当事实。
- **滚动窗口（rolling window）**：步骤条目只保留最近 50 条（内存）/ 20 条（localStorage 持久化截断）。防刷屏也防爆存储。
- **已中断（interrupted）**：`interruptedAt` 非空的残留 running 卡片（关机/崩溃产物）。详情页冻结显示最后已知阶段 + 中断标记，spinner 停转。

## 批量进度

- **逐项清单（item list）**：batch NDJSON `item` 事件点亮的每家公司结论清单（✅/⚠️/跳过/失败+reason）。失败 reason 承接 ADR-0041 决议 6。
- **批量登记表（batch item registry）**：服务端进程内逐项状态表（`web/src/lib/batch-items.mjs`，镜像 `checkup-live.mjs` 模式），`GET /api/batch-items` 供前端刷新后恢复清单。生命周期与批量 run 一致：进程重启即消失（此刻批量本也会死）。
- **计数行**：批量详情页的「正在处理第 i/n 家」，来自批量已有的 `[i/n]` status 事件。批量允许真计数；单任务禁止伪 %/ETA（时长方差大，估算是编造）。
- **黑盒运行段**：批量 worker 纯文本模式（`--print`）无 stream-json 工具事件，运行中内部不可见——缓解手段是逐项清单实时点亮，而非透传 worker 文本（混报告草稿，刷屏无消费价值）。

## 显示纪律

- **诚实降级（honest degradation）**：没有的数据源就不显示对应 UI——非 claude 引擎无工具步骤、扩展源卡片本次无阶段、中断任务不假装在跑。宁可少显示，不可编造。
- **兜底行（thinking fallback）**：「思考中…」spinner 从固定追加退役为最后兜底：仅当任务 running 且无任何阶段/步骤信息可显示时才出现。
