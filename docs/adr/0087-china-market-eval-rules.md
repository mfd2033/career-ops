# ADR-0087: 中国市场评估口径的落点与生效边界（Kaneo CO-51）

## 状态

Accepted (2026-10-21)

## 背景

Kaneo CO-51 要求补全中国市场模式。核查后任务前提已经部分过时：`modes/zh/` 目录随上游 v1.27.0 进入仓库，
`_shared.md` 的「中国大陆市场」表已有 11 行概念（五险一金、个税、年终奖、期权、试用期、竞业限制、
校招社招、996、税前税后、落户）。真正缺的是 CO-51 点名的四条：13/16 薪总包折算、统招本科硬门槛、
国企外包/驻场识别、央企/上市/专精特新分层。

补这四条之前必须先定两件比内容本身更要紧的事：规则写进哪个文件，以及写完到底哪条路径会读到它。

既有事实与约束：

1. **两条评估路径读不同的文件。** web `/api/run` 与批量评估的 worker 提示词（`web/src/lib/run-prompts.mjs`）
   把模式文件写死成根目录 `modes/oferta.md`，而 `modes/oferta.md` 的 `_shared.md` 引用也是同目录根版。
   `modes/zh/*` 只有在 agent 被显式告知走 zh 模式时才被读。本期 `config/profile.yml` 没有
   `language.modes_dir`，因此 web 端点的评估一次都没走过 `modes/zh`。
2. **`modes/oferta.md` 唯一认的用户层挂点。** 它在算综合分时明确要求读取
   `modes/_custom.md` 的 Scoring Rules 段（缺省则用块分均值）。这是既有的、稳定的扩展点；
   `_custom.md` 属于用户层，永不被上游覆盖。
3. **`modes/zh/_shared.md` 属于系统层。** 按 DATA_CONTRACT 与 ADR-0022，它跟随
   `git merge upstream/main`，本地改动是合并冲突面；但市场语义（中国评估规则）归它而不归通用 `modes/_shared.md`，
   写进根文件会污染所有市场的评估口径。
4. **候选人学历为大专**（`cv.md` 教育经历：郑州大学｜大专｜2008–2010，工作经历自 2010 年起）。
   中国 JD 里「统招本科及以上」出现频率极高，但相当比例岗位实际接受「大专 + 长期同岗经验」。
5. **`modes/_profile.md` 的 deal-breaker 是「不做外包」**，而中国语境下「外包」包含两种完全不同的用工形态。

## 决策

1. **落点：正文归市场层，出口借用户层，不复制规则。**
   四条口径的正文写进 `modes/zh/_shared.md`；`modes/_custom.md` 新建 `## Scoring Rules` 段，
   只放一行指针（评估中国大陆岗位时按 `modes/zh/_shared.md` 的中国市场口径判定）与一行优先级，
   不复制任何规则正文。优先级：`modes/_profile.md`（用户层）> 中国口径 > 通用规则。

2. **生效边界：本期不修 web 路径，缺口显式登记。**
   `run-prompts.mjs` 不认识 `language.modes_dir` 是既有缺陷，修它要动系统层代码 + 补测试，
   与「只补规则」的范围不符。本期以 Kaneo CO-65 跟踪该缺口；本 ADR 把「它是已知缺口、不是遗漏」写死，
   省掉下次重新推导的成本——下次有人问「为什么补了中国口径但 web 评估没变化」，答案在这里。

3. **学历口径：默认经验补位，只有「不可替代」措辞才 hard_stop。**
   JD 写「统招本科」默认降 0.3–0.5 分并输出抵消策略；仅当出现「仅限全日制统招本科」「必须」「学历为硬性要求，
   不可替代」这类措辞才升为 `hard_stop`。措辞边界写成三档表 + 关键词清单，保证同一份 JD 换个人判落到同一档。

4. **用工形态：把「外包」拆成两种，分别对应硬卡与只标记。**
   人力外包 / 劳务派遣 / 客户驻场 → `hard_stop`（与 `_profile.md` 的 deal-breaker 一致，
   也与「不做外包」的字面一致）；有自有产品的乙方交付公司（签约主体即用人主体，如候选人待过的音视频显控厂商）
   → 只标记不拒投，Comp 走「外包/乙方」可信度档。判定依据是合同/用工主体，不是品牌名或 JD 措辞。

## 被拒方案

- **只写 `modes/zh/_shared.md`**（否决）：语义归属正确，但 web 与批量评估都读不到，等于写了一部不生效的规则。
- **只写 `modes/_custom.md`**（否决）：能生效，但把中国市场概念挂在「自定义规则」名下，与 `modes/zh` 体系
  平行出两套口径，日后必然分叉。
- **写进根 `modes/_shared.md`**（否决）：能生效，但污染通用市场规则，且根文件同样是上游系统层，
  冲突面不比 `modes/zh` 小，还多一层「哪条规则只对中国成立」的隐式语境。
- **把规则正文同时抄进 `_custom.md`**（否决）：双写必然漂移，改一处忘一处只是时间问题。
- **本期顺手改 `run-prompts.mjs` 让 evaluate 读 `modes_dir`**（否决）：范围与风险都超出「补规则」，
  且会让本期变成「规则 + 引擎 + 测试」三件事混在一张票里，出问题难定位。另立 CO-65。
- **学历一律 hard_stop**（否决）：会排掉大量「写归写、实际重经验」的中小企业与乙方产品岗，
  而候选人恰恰是有 16 年连续经验的大专背景。
- **新增评分类加权（如央企 +0.2）**（否决）：与「每个分数都要能追溯到证据」的可审计原则相背。
- **新建独立词汇表文件**（否决）：`modes/de`、`modes/fr`、`modes/ja` 均无独立词汇表，术语历来活在
  `_shared.md` 的表里；新开一个文件只会多一处要记着读的地方。

## 后果

- 正面：中国口径写在语义归属正确的位置，同时通过 `_custom.md` 拿到一条今天真能生效的出口；
  规则正文只有一份，改一处即全域生效；四条概念各有可审计的判定依据，不做黑箱加权。
- 代价一：`modes/zh/_shared.md` 是上游系统层，每次 `git merge upstream/main` 都可能在该段产生冲突，
  需按 ADR-0022 的 fork 规则重新叠加。
- 代价二：`_custom.md` 里的指针是「路径 + 段名」约定，`modes/zh/_shared.md` 若被重命名或该段标题被改，
  指针会静默失效（与 `oferta.md` 依赖 `Scoring Rules` 段名同理，属既有风险，不是本期新增）。
- 已知缺口：web / 批量评估仍不读 `modes_dir`（CO-65）。在 CO-65 完成前，从 web 端点发起的评估
  只通过 `_custom.md` 的指针间接吃到中国口径，读到的 `_shared.md` 仍是根目录英文版；两者的实际差异体现在
  Block A/D/G 的判定口径上，属于「部分生效」而非「完全生效」。
- 回滚：本期只改两个 markdown 文件 + 新增本 ADR，删掉 `Scoring Rules` 段即回到原状，无数据迁移。

## References

- 需求来源：Kaneo CO-51（工作区 Nono工作室 / 项目 CareerOps），「中国市场模式 modes/zh」
- 跟踪票：Kaneo CO-65「评估引擎按 language.modes_dir 选模式文件（web 路径吃不到 modes/zh 口径）」
- 工单目录：`.scratch/zh-market-rules/`（README + 6 张票）
- 生效出口：`modes/oferta.md` 综合分段落（读取 `modes/_custom.md` → Scoring Rules）
- 系统层与用户层边界：`DATA_CONTRACT.md`；fork 合并规则：ADR-0022、`docs/fork-ops-history.md` §4
- 用户层 deal-breaker：`modes/_profile.md`「Your Deal-Breakers」
- 候选人学历事实：`cv.md` 教育经历
