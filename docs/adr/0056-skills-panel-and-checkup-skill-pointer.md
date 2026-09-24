# ADR-0056: 配置页技能面板 + 体检 prompt 技能指针——版本溯源缺口收口

## 状态

Accepted (2026-09-24)

## 背景

2026-09-23 溯源审计确认：web 端 kind=checkup worker 从不读 offer体检 的 SKILL.md（pointer prompt 只指向 `modes/_custom.md` → `docs/checkup-workflow.md`），报告页脚是 `run-prompts.mjs` 写死的「本报告由 career-ops 公司体检技能生成」，无版本号；台账 `data/company-checkups.tsv` 无 version 列。逐次回答「这份体检是哪个技能版本跑的」在数据上不可能，只能靠事后人肉判读（run 工具步 + 页脚指纹）。

技能副本同时散落多处且版本不一：`~/.trae-cn/skills` 与 `~/.claude/skills` 的 offer体检 = 1.2.0（version 字段 2026-09-22 才引入），`~/.skills-manager/skills` 中央库同 1.2.0，`~/.agents/skills/offer-checkup` 旧克隆连 version 字段都没有，`~/.config/opencode/skills` 另有一份。browser-skill 的 SKILL.md 无 version 字段。配置页已有的运行时检测体系（ADR-0015：检测一次 + 检测缓存 + 手动重检）只覆盖 CLI 运行时，不覆盖 agent 技能。

## 决策

1. **技能注册表 = 服务端目录扫描（单一事实源）**：新增纯 `.mjs` 库 `web/src/lib/skill-registry.mjs`（node --test 可锁，同 checkup-live / checkup-request 惯例），扫描固定目录清单（`%USERPROFILE%` 下：`.trae-cn/skills`、`.claude/skills`、`.skills-manager/skills`、`.config/opencode/skills`、`.agents/skills`，常量可扩展），每个直接子目录读 `SKILL.md` frontmatter 的 `name`/`version`。单目录缺失/失败跳过不致 500；frontmatter 无 version → `null`。不做二进制探测（不跑 `bsk --version`），不走 skills-manager-cli（bridge 未发布/桌面端漂移是额外故障面，且覆盖不到野副本）。
2. **展示 = 按技能聚合 + 聚焦白名单**：新增 `/api/skills` 路由返回扫描结果；配置页新增技能面板，按技能聚合——每技能一张卡片，展开列各副本「路径 + 版本 + 所属目录」，最高版本标当前。v1 白名单只渲染 `offer体检` 与 `browser-skill`（常量）；扫描器通用，白名单只控展示面，加技能改白名单不改扫描器。
3. **browser-skill 版本如实**：frontmatter 无 version → 版本列显示「未标注」，不硬造、不探测。
4. **缺失降级 = 徽标，不拦截**：技能未安装/副本缺失在面板以徽标如实呈现；体检派发不因技能缺失被拦——`docs/checkup-workflow.md` 第 8 条（提示安装、不硬失败、不自行仿写 7 维）语义不变。
5. **体检 prompt 技能指针 = 服务端解析绝对路径注入**：`/api/run` 派发 checkup 时用同一 skill-registry 解析 offer体检 的最高版本副本，把**绝对路径 + 版本号**写进第 1 条指令——指针在场时第 1 条变为「FIRST action: Read 该 SKILL.md，按技能正文与其 references/ 执行 7 维调研、评分与报告结构」，workflow 文档改在指针之后读（THEN 从句）；页脚按技能模板填版本号（`{{SKILL_VERSION}}` 占位；prompt 内的页脚句是模板 footer 的**服务端快照**，模板改文案需同步 `run-prompts.mjs` 的 footerLine）。版本号注入 prompt 前做白名单消毒（`[0-9A-Za-z.-]`，其余如实降级「未标注」——frontmatter 可被远端部署污染，不得借插值改写指令语义）。找不到可用副本 → 维持现行 prompt（固定页脚），行为与今天逐字节兼容。
6. **规则分层与冲突裁决**：技能正文负责调研方法、评分与报告结构；`docs/checkup-workflow.md` 12 条继续是安全与持久化铁律（落盘路径 `reports/checkups/`、台账 `log-checkup.mjs add` 只跑一次、零分影响、Untrusted Content 纪律）。**两者冲突时 workflow 优先**——尤其报告落盘路径用 workflow 的，不用技能自带 `reports/`（ADR-0025 决议 6 不动摇）；页脚文案以技能模板为准（版本号进页脚即本次目标）。prompt 注入的路径与版本是服务端生成的可信值；公司名维持「」数据纪律不变。
7. **版本持久化 = 仅页脚，无 gate 无台账列**：台账 schema 不动（`log-checkup.mjs` 的锁定测试不改），`persistRunOutcome` 不校验版本号。版本可溯靠产物：报告 HTML 页脚即证据。技能版本历史由 skills-manager 的 git 自动备份覆盖（已存在，本机仓库含 1.0.0→1.1.0→1.2.0 全史）。
8. **扫描时机 = 每次请求实时扫**：目录小、文件少（本机 <100 个 SKILL.md），毫秒级开销；v1 不做缓存、不做手动重检按钮。若将来成痛点，再套 ADR-0015 的检测缓存模式，不在本次范围。

## 后果

- 正面：版本溯源缺口收口——报告页脚与配置面板同源于 skill-registry，「有没有调技能」从人肉判读变成系统保证；技能升级后新体检自动带新版本号；面板一次回答「装没装、装在哪、哪个版本」三问。
- 代价：checkup prompt 多一条指令与一次技能文件读取（SKILL.md ~12KB + references，计入 25 次调用预算，余量充足）；worker 对技能正文的遵循度依赖模型档位（体检禁 Flash 档的既有纪律不变）；双规则源（技能正文 + workflow）需要第 6 条的优先级裁决，review 时要盯冲突。
- 已知留白：版本不进台账（无法直接统计各版本体检量，靠 grep 页脚）；未装 offer体检 时报告无版本号（如实降级）；面板不做安装/升级动作（那是 skills-manager 的职责）。

## 关联

ADR-0025（技能接入）、ADR-0027/0033/0035（pointer prompt 与派发前哨）、ADR-0030（产物门禁，本次不动）、ADR-0015（检测缓存模式，本次未套用）。
