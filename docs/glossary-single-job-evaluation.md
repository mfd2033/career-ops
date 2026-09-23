# Glossary — 扩展单职位评估

协同阅读：`docs/adr/0051-extension-single-eval-via-run.md`、`docs/glossary-browser-extension.md`、`docs/glossary-job-progress.md`

## 链路与归属

- **单职位评估（single job evaluation）**：扩展上一次只评一个职位的动作，判据是「一个职位 = 单任务」——走 `POST /api/run`（`kind=evaluate`），在 `/jobs` 归属为 `evaluate` 卡。不指网页粘贴 URL 评估，虽然后者是它的形状模板。
- **批量路（batch path）**：同一次动作评 N≥2 个职位，走 `POST /api/batch-evaluate`，在 `/jobs` 归属为一个批量父卡 + 逐项子卡。popup 的多选评估永远是它。
- **回落批量路（batch fallback）**：扩展探测到服务端没有 `single-eval-inline-jd` 能力位时，单职位评估退回走批量路。这是新旧错配下的兼容通道，不是降级提示。
- **归属（card ownership）**：一次评估在 `/jobs` 里被记成哪一类工作单元。本 ADR 的动机就是这个字段，不是持久化语义。

## 事件与进度

- **能力位（capability flag）**：`/api/version` 的 `capabilities` 数组元素，build 期常量。与 `/api/config` 区分开——后者是用户可变存储，拿它做版本协商会把用户设置变成协议。
- **总线订阅（bus subscription）**：扩展 background 持有的一条 `GET /api/events` 长连接，按 `runId` 过滤自己派发的那次评估。与网页 job-store 共用同一通道，每客户端一条。
- **最小映射（minimal mapping）**：`status`/`text`/`done`/`error` 映回扩展既有 `stage` 形状、`tool` 事件丢弃的映射策略。逐工具步骤归 `/jobs/{id}`（那里从台账重建），不归 popup。
- **合成结论行（synthesized item）**：单任务总线没有 `item` 事件，扩展侧从累积 text 抓最后一条 `VERDICT:` 造出来喂 popup 的一行。它不是服务端事件，只是显示层适配。

## 数据写入

- **反推 num（derived report number）**：route 从 `reports/` 前后差集解析出 worker 自己 reserve 的报告号，用于 reconcile。与批量的「预分配号段」相对——后者派发前就已知，反推是终结时才知道。
- **入管归档（pipeline reconcile）**：把已评估的职位从 `data/pipeline.md` 待评段移到已处理段。单任务链路此前缺失这一步，是「评估过的职位退回收件箱」的根因。
- **早亮的徽章（early badge）**：单任务由 worker 自 merge tracker，tracker 行因此在 run 结束前存在，3s 轮询可能先于完成信号点亮徽章。这是已接受的时序差异，不是竞态 bug。
_Avoid_: 重复评估（早亮徽章不等于重复评估，后者指同一职位被起两个 worker）
