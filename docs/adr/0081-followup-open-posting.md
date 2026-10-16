# ADR-0081: 「记录跟进」窗口增加「打开职位」——复制话术 → 打开职位 → 粘贴 → 发送闭环

## 状态

Accepted (2026-10-16)

## 背景

需求（用户 2026-10-16，原话）：「需要在记录跟进窗口再增加打开职位功能，可以跳转到职位详情页，复制话术->打开职位->粘贴话术->发送，闭环」。

现状（ADR-0080 落地后）：「生成话术」区能按轮次选话术、一键复制到剪贴板；但复制完用户还要自己翻出那条原始职位链接——复制与打开之间断了一环，闭环没合上。

三处决策已由用户收敛（AskUserQuestion，2026-10-16）：

1. **跳转目标 = 原始职位链接（外站）**，新标签页打开；报告里没有 http 链接时按钮**置灰并给提示**（不隐藏）。
2. **两个独立按钮**（「复制话术」与「打开职位」分开点），不合并成一步（不自动连带打开）。
3. **按钮放在 GenerateScriptPanel 内**，与「复制话术」并排（不放弹窗 footer）。

既有事实与约束：

1. **URL 抽取已有单点实现**：`readApplicationUrl(app)`（`web/src/lib/career-ops.ts`）——读该行报告的 `**URL:**` 头，仅当是 http(s) 绝对链接才返回，否则 `undefined`。原服务于批量重评估流程，本需求复用同一实现，不另写一份报告头解析（同 ADR-0080 决策 4「同一份 entry 不另起装配」的纪律）。
2. **CadenceEntry 没有 url 字段**，只有 `reportPath`；`followup-cadence.mjs` 也不输出 url。
3. **payload 已有单点**：`GET /api/followups/scripts?num=N`（ADR-0080）本就是「面板展开时一次请求拿齐渲染数据」的入口，扩一个 `postingUrl` 字段即可，面板无需第二次请求。
4. **伦理红线**：只复制、只打开链接，**绝不代发、绝不提交、绝不预填**——`AGENTS.md` 的边界在本次同样不是建议而是设计约束。
5. **零写面**：本增量不写任何文件（不改 tracker、不写 `data/follow-ups.md`），与 ADR-0080 同一条边界。

## 决策

1. **文案与链接同源**：扩展现有 payload `FollowupScriptsPayload` 增加 `postingUrl: string | null`；服务端在 `readFollowupScripts(row)` 里用 `readApplicationUrl(findApplication(String(row.num)))` 解析，取不到 / 非 http(s) / 行不存在 → `null`。fail-closed 分支（无 row / 文件缺失 / 解析零条 / 路由 catch）一律 `postingUrl: null`。
2. **按钮位于面板内、与「复制话术」并排**：动作行右端收成一组两颗按钮，顺序按用户陈述的闭环顺序——左「复制话术」（品牌色，原样式不变）、右「打开职位」（次级描边 + `lucide-react` 的 `ExternalLink`）。
3. **有 URL = 真链接**：`postingUrl` 非空时渲染 `<a href={postingUrl} target="_blank" rel="noopener noreferrer">`——外站新标签页打开，不做任何自动粘贴 / 提交。
4. **无 URL = 置灰按钮 + 提示**（决策 1）：渲染 `<button disabled>`，包在带 `title` 的 `<span>` 里（`disabled` 元素不派发指针事件，title 挂在可悬停的父 span 上才稳定显示）。提示说明「该行报告里没有职位链接」；不隐藏。
5. **渲染时机**：动作行（两颗按钮）只在 `payload.available && script` 分支内渲染——与「复制话术」同一处。话术不可用时面板保持 ADR-0080 的安静收场（一句「暂不可用」），不单摆一个没有话术可复制的按钮。
6. **文案进 i18n**：新增两个键落 `web/src/lib/i18n/clusters/followups.ts`（en+zh）：`followups.scriptOpenJob`（按钮文案）与 `followups.scriptOpenJobHint`（无链接时的 title）。数据（URL）不进 i18n。
7. **不新增纯逻辑模块**：URL 解析复用既有 `readApplicationUrl`（报告头 `**URL:**`，http(s)-only）；导航就绪性由既有纯模块 `openableUrl` 的同款契约（`web/tests/lib/openable-url.test.mjs`）描述。本次没有新的可测纯逻辑面，验证靠 `npm run build`（类型）+ Playwright 端到端（有 URL 开新标签页 / 无 URL 置灰）。

## 被拒方案

- **站内 `/pipeline/{num}` 跳转**（否决）：决策 1 明确要原始职位链接（外站）——闭环的下一跳是「粘贴话术发送」，必须在真实职位页上；站内报告页没有可粘贴的对话框，`web/src/app/jobs/[id]` 更是后台评估任务页、不是职位页。
- **合并成单按钮「复制并打开」**（否决）：决策 2 要保持两个独立按钮。合并会把「只想复制、不想开页」和「只想看一眼、不想覆盖剪贴板」两种意图焊死，也会让复制与打开的成功/失败耦合。
- **按钮放弹窗 footer**（否决）：决策 3 明确放面板内、与「复制话术」并排；footer 是弹窗级动作（取消 / 记录），面板动作混进去会搞乱「记录跟进」的主次。
- **无 URL 时隐藏按钮**（否决）：决策 1 要置灰 + 提示。隐藏让用户不知道自己少了一环，也分不清是数据缺失还是功能没做。
- **在引擎（followup-cadence.mjs）侧新增 url 字段**（否决）：URL 不是 cadence 判定的一部分（判定只看日期 / 状态 / 沉默 / 已读），把报告读盘塞进零 LLM 引擎是职责越界；且面板本就有一次 `/api/followups/scripts` 请求，扩字段零新增请求。
- **客户端直接读报告文件取 URL**（否决）：浏览器拿不到仓库文件；必须经 server helper（同 ADR-0080 拒掉的客户端读 `templates/`）。
- **`window.open` 受拦截时脚本兜底**（否决，v1 不做）：`<a target="_blank">` 是浏览器原生新标签页语义，不受弹窗拦截影响；不需要脚本兜底。
- **顺带回填「已打开」到备注 / `follow-ups.md`**（否决）：同 ADR-0080，静默替用户记录动作是替用户说话的写路径；用户「不联动」的边界不变。

## 后果

- 正面：复制 → 打开 → 粘贴 → 发送四步在同一块面板里，闭环合上；payload 扩一个字段、UI 加一颗按钮，写面零新增。
- 代价：`FollowupScriptsPayload` 契约扩一个字段（fail-closed 分支也要带 `postingUrl: null`）；面板动作行由 1 颗按钮变 2 颗，窄屏需沿用既有 `flex-wrap` / `shrink-0` 纪律避免挤出弹窗。
- 已知边界：「打开职位」在话术不可用时不同时出现（决策 5）——闭环里没有话术就没有可粘贴的东西，此时打开职位是半个动作；报告缺 `**URL:**` 头的行按钮置灰，是真数据缺口，不是缺陷。
- 回滚：撤 UI 增量 + 去掉 payload 字段即回到 ADR-0080 现状；纯增量，无数据迁移。

## References

- 任务：用户 2026-10-16 需求（复制话术 → 打开职位 → 粘贴 → 发送闭环）
- 复用边界：ADR-0080（生成话术面板与 `/api/followups/scripts` payload）；ADR-0075（LogDialog 单一弹窗）
- URL 抽取单点：`web/src/lib/career-ops.ts` 的 `readApplicationUrl`；导航就绪性契约：`web/src/lib/inbox-url.mjs` 的 `openableUrl`（`web/tests/lib/openable-url.test.mjs`）
- 用户决策（2026-10-16，AskUserQuestion）：外站原始链接 + 新标签页；无 URL 置灰不隐藏；两个独立按钮；按钮放面板内并排
