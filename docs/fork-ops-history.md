# Fork 操作史（fork ops history）

> 场景索引在 `modes/_custom.md`「按需文档索引」。内容为历史排查/修复快照 + 迁出的长规则，已脱敏（真实公司名去除）。

## §1 巨型残留目录根因与清理（原 [16316241]）

- 根因：`test-all.mjs` 在仓库根 mkdtempSync `.tmp-script-test-*` 近整仓夹具；被硬杀（taskkill/断电，finally 不执行）即残留；旧版 copyDirSync 只排除本次夹具 → 上次残留被复制进新夹具，逐次嵌套翻倍（曾积 98GB）。
- 已修（2026-09-13）：copyDirSync 跳过根目录所有 `.tmp-script-test-*` 前缀目录；注册 SIGINT/SIGTERM 清理。
- 再现残留 → 怀疑信号覆盖不到的终止方式，手动删；删含 .next 的深层残留时 Remove-Item 因长路径(>260)/只读失败，用 robocopy 空目录 /MIR 镜像后再删；safe-delete shim 拦批量删除 → 清 NODE_OPTIONS + CODEBUDDY_SAFE_DELETE_*（与打包同一做法）。

## §2 批量评估三连 bug（原 [25823730]，2026-09-15，commit 754ec88/cc10653/77cd38f）

- ① 预留号解析 `\d{3}` 硬编码：报告号过 #999 整批失败并泄漏哨兵（974 个）→ 提取为 `run-cli-support.mjs` 的 `parseReservationOutput`。
- ② 批量 worker 裸 `claude -p` 无工具授权：Bash 需审批致中文站提取第一步即死（80 worker/77 分钟/零产物），且全失败仍记 done → `claude-invocation.mjs` 导出 `permissionFlags(kind)` 供批量附加；弱门改 ok=0&&failed>0 发 error。
- ③ `pipeline-lock.mjs` 只信 pid 存活：Windows pid 复用致死锁永久免回收（pipeline.md.lock 被 30h 死进程占住）→ 超 DEFAULT_MAX_HOLD_MS（10min，env `CAREER_OPS_LOCK_MAX_HOLD_MS`）判 STALE；tracker 锁共用该 verdict。
- 排查：worker 真实死因在 `~/.claude/projects/<项目>/` 会话 transcript（每 worker 一份）；3000 端口常跑打包版（.dashboard-runtime 快照），当日修复需重打包才生效；验证修复起临时 `next dev -p 3100` 直发 /api/batch-evaluate。
- 遗留：批量 per-item reason 不落盘（观测缺口）、batch 路由缺工具 flag 守卫、`clis.ts:74` 注释指向不存在的测试文件。

## §3 体检 worker 端通路（原 [39876333]，ADR-0025/0027/0030/0031/0033/0035/0041）

- 批量体检 `POST /api/batch-checkup` 镜像 batch-evaluate：3 并发+池、上限 20、NDJSON、per-tracker# 台账门禁（checkupArtifactRowCountForTracker）、单 worker 30min kill；冲突=跳过不 replace；建议角标 suggestsCheckup + /api/pipeline/checkup-suggest 懒加载。
- **关键教训**：非 claude 无头 worker（opencode）遇任何权限 ask 即静默死亡（exit 0 零输出零日志）——external_directory/doom_loop 默认 ask、.env 读取为 ask。修复=仓库根 `opencode.json`（本地未跟踪）permission allow 两项 + read .env deny；**新 ask 类权限键出现需同样处理**。
- 诊断：opencode 日志 `~/.local/share/opencode/log/opencode.log`（run=<id>，grep creating instance/asking/permission=）；复现回路 `node local/batch-checkup-repro.mjs <tracker#...>`。
- 模型/环境坑：agnes-2.5-flash 有「研究完不落盘」的非确定性毛病（重跑可全过）；engine=opencode 配置在 `~/.career-ops-web/config.json`；opencode 无消息体持久化、只有日志（claude 的 transcript 在 ~/.claude/projects，两者不同）。

## §4 Fork 系统更新规则与锚点（ADR-0022，原 House Rules 迁入 + 原 [39635169] 补充）

- **更新规则权威**：本 fork（上游 santifer/career-ops，无上游写权限）系统更新一律 `git fetch upstream && git merge upstream/main`——三方合并自动融合 fork-local 锚点与本地提交，冲突显式暴露。**禁 `update-system.mjs apply`**（checkout 覆盖会抹掉锚点）；`check` 报 `system-files-changed` 属预期（fork 本有系统层差异），不执行 Re-apply to restore。
- 系统文件锚点位置：`scan.mjs` 三处 + `url-key.mjs` 尾部（FORK-LOCAL anchor）；`local/` 缺失时 warn + 降级为上游行为。
- tripwire `tests/local-scan-dedup.test.mjs`（gitignored，test-all 自动发现）每次 merge 后必跑，红 = 锚点被切断或 local/ 缺失。
- 加新站去重参数只改 `local/dedup-params.mjs`；扩展逻辑住 gitignored `local/`；文档 docs/adr/0022、local/README.md。

## §5 体检台账细节与 test-all 纪律（原 [44419701] 非重叠部分；编排权威 = _custom.md Custom Workflows「公司体检」）

- `data/company-checkups.tsv` 唯一机器通道 `lib/log-checkup.mjs` 守护写入：星级 0.5 步进；risks 8 因子闭集 social-zero / social-mismatch / scale-mismatch / entity-confusion / arbitration / review-negative / tactics / media-negative；tracker# 允许 `?` 空键；append-only。
- `lib/log-checkup.mjs` 已登记 `config/local-paths.txt`（fork 专属系统层文件，否则 validate-system-paths-coverage 报缺口）。
- 消费方：web pipeline 星级徽章（`web/src/lib/company-checkups.mjs` 读取镜像）+ `analyze-patterns.mjs` checkupAnalysis（? 键只进星级分布）。
- test-all 纪律：discovered 套件禁止调用 `finish()`（连注释里出现该字样都会被裸正则误杀）；本机已知 24 个既有测试失败（opencode CLI/Playwright MCP/bash 套件等环境原因）。
- 脱敏记录：首个真实体检 #917 ★1.5 高危（同名双主体 + 宣称与工商不符）——公司名已从记录中去除。

## §6 test-all 运行纪律（2026-09-14，原 House Rules 迁入）

- `node test-all.mjs` 前必须在**同一条 shell 命令内**先清 safe-delete shim：`Get-ChildItem Env: | Where-Object Name -like "*SAFE_DELETE*" | ForEach-Object { Remove-Item "Env:$($_.Name)" }; $env:NODE_OPTIONS=$null`，再跑 test-all（IDE 每条新命令都重新注入，单独清一次无效）。
- 不清的后果：结尾临时目录清理被 shim 拦截（批量确认/ETIMEDOUT），崩在打印汇总前且退出码 1，酷似回归实为环境。
- 基线：2026-09-15 起本机全绿（5544 passed / 0 failed）——再出现 ❌ 即真回归。

## §7 接入 Qoder CN 为可派发运行时（ADR-0052，2026-09-23，工单 #6-#10）

- **接的是 CN 版二进制 `qoderclicn`**（用户指定），不是国际版 `qodercli`；id `qoder-cn`、标签「Qoder (CN)」、官网 `https://qoder.com.cn/`。可执行文件在 `%USERPROFILE%\.qodersec\bin`，PATH 与 npm global 都查不到 → `CliSpec.binDirs`（厂商目录，PATH 之后兜底）；`detectClis` 与 `resolveCli` 共用同一份目录列表（只改一处会造成「列表里已安装、派发时找不到」的静默分叉）。
- **stream-json 逐行与 Claude 同形**（`system/init`、`assistant` + `tool_use`、`stream_event`、`result`），`parseClaudeEvent` 可直接复用；差异集中在 `qoder-invocation.mjs`：`-p` 是无值布尔（prompt 走位置参数）、**不认 `--verbose`**（Claude 的 stream-json 反而要求它）、权限模式取值 `accept_edits`（下划线）、工具 flag 用连字符。
- **权限面（实测教训）**：Qoder 的工具集是 Claude 的**超集**（29 个内置工具）。`--disallowed-tools Bash` 下 `Monitor` 仍能把 `echo` 跑通并回报 stdout；把 `Monitor` 等 18 个 Qoder 自有工具显式加进 deny 后才真正堵住执行路径。逗号拼接的 allow 与 deny 都被正确解析，deny 压过 allow。
- **不申报用量**：`result.usage` 全为 0、`total_cost_usd: 0`，真实消耗只出现在逐轮 `message_delta.usage.credits`。解析器屏蔽 tokens/costUsd，run 路由也不再发 `tokens: 0`（不报比报 0 诚实）。
- **模型清单动态化**：`qoderclicn --list-models` 是权威（本机 14 个），失败（未登录/离线）返回空清单 + 配置页提示，不写静态副本；缓存 60s，手动重检强制失效。已知无害坑：`--model` 传无效名字**不会失败**，CLI 只写一句 stderr 并回落到 `auto`——所以一份会过期的静态清单会静默换掉模型。
- 未登录表现：任务走 `result.is_error` + `result:"Not logged in · Please run /login"`（现成的人话错误通道），`--list-models` 则 stderr 报登录提示、stdout 为空。不给 Qoder 加 `stderrIsFatal`：cwd 在仓库根时 stderr 会出现 7 行 `Skill conflict:` 噪声，通用致命正则不匹配它们。
- 验证口径：单测 + typecheck + **dev 真跑**已过（34 个 tool 事件实时到达、台账 20 条步骤、`/api/runs/history` 可回看）。「打包版真跑一条并落报告」留给 #10，且**必须用确认在招的职位**——首次真跑那条第 2026-08-25 的 ACS 链接被 Qoder 自己按 Liveness Gate 判为下线（活板 66 个在招 req 中 0 命中、详情接口 403、页面渲染为空），它如实不产报告，route 的门禁也如实判 error。
- 未清事项：批量评估与 `cv-ingest`/`assistant`/`apply-prefill`/`explore-ai` 四个路由仍各自手写 `isClaude ? [工具 flag] : spec.args(prompt)`；统一它们属 #2507/#10 那条线。
