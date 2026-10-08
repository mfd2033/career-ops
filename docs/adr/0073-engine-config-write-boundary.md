# ADR-0073: 引擎配置的写入边界——页面打开不落盘、跨引擎脏模型双侧守卫、mode 单一真值源

## 状态

Accepted (2026-10-08)

## 背景

2026-10-08 一次职位评估（11:07，猎聘）失败，账本记的运行引擎是 `claude + hy3`，而用户从未配置过 Claude Code，本机一直用 CodeBuddy + `hy3`。复盘查出两个独立的配置层缺陷，外加一个长期存在的界面缺陷：

1. **`cliId` 会被无人操作改写**。配置页在「本浏览器没存过 cliId」时，把「本机安装的第一个可用 CLI」（`KNOWN` 顺序里就是 claude，实测 `/api/clis` 返回 claude installed+usable 排第一）当作默认值**立刻 POST 到服务端镜像** `~/.career-ops-web/config.json`（`applyClis` → `persistCliId`，注释写明「只高亮不落盘时派发端读到空配置」）。于是「打开一次页面」= 改写服务端引擎。
2. **`model` 不跟着 `cliId` 走**。`persistCliId` 只 POST `{cliId}`，服务端那个键保留旧值 `hy3`（`hy3` 是 CodeBuddy 目录里的模型，见 `clis.ts` `MODELS.codebuddy`）。组合 `claude + hy3` 只能由这条路径产出：`save()` 走不通，因为它 POST `{cliId, model}`，空 model 会被路由删掉键。派发端 `withModelFlag` 又不校验模型是否属于该 CLI，直接拼 `--model hy3`；Claude CLI 报 `[claude-code:unrecognized_model]`，加上它依赖的本地代理（cc-switch，`127.0.0.1:15721`）当时没在监听，最终报 `API Error: Connection refused`。扩展派发的单职位评估读的正是服务端这一对（`extension/background.js` `resolveEvalConfig`），所以脏组合被原样跑了出去。
3. **配置页每次打开都停在「快评」档**。`mode` 被 `save()` 的 key 分支写进了快评存储 `career-ops:quickeval`（`{ mode, provider, model, baseUrl }`），而恢复顺序是先读主配置（`if (v.mode === "cli") setMode("cli")`）、**后**读快评存储（`if (q.mode) setMode(q.mode)`）——快评赢。且用户切回 CLI 档点保存走的是另一个分支，只写主配置、**不碰快评存储**，那个 `mode:"key"` 永远留着 → 无法自救，与 156 行上方「key/manual 尚未接线，绝不恢复进死面板」的注释直接矛盾。

约束：

- 服务端镜像是 headless worker 与浏览器扩展的唯一引擎真值源（`unknown-employer.mjs` 头部把同一件事讲清楚了：localStorage 页面画得出，worker 读不到）。清空镜像的 `cliId` 会让扩展回落自己的 `installed.length === 1` 逻辑，本机装了 4 个 CLI → 直接派发失败。所以「不自动落盘」不能等于「没有值」。
- 模型目录有两类真值：静态表（`MODELS`，claude/codex/gemini/…/codebuddy）与运行时读自 CLI 的动态表（opencode、qoder-cn，ADR-0052/0053）。动态表只在检测时可得，而检测要 spawn 探针；派发路径不能为守卫付这个代价。
- ADR-0043 决议 2：账本记「派发那一刻的请求值」，绝不记实际加载值。守卫改变请求值时，账本必须跟着变，否则会谎报一个从未生效的模型。
- ADR-0054：三个派发路由的 worker argv 一律经 `resolveWorkerInvocation`，路由不得自拼 flag。守卫不能把这个契约再拆成两份。

## 决策

1. **`mode` 单一真值源 = `career-ops:config`**。快评存储只存 `provider / model / baseUrl`，既不写 `mode` 也不读 `mode`；主配置恢复接受 `"cli"` 与 `"key"`（`"manual"` 面板仍是 disabled，旧值回落 `"cli"`）。key 分支保存时把 `mode` 合并写进主配置，不覆盖 `cliId/model`。旧浏览器里残留的 `mode:"key"` 在下一次任意保存时被自然清除（快评存储整对象重写）。
2. **打开配置页不再写服务端**。`applyClis` 只把本机默认显示在下拉里（`savedCliId` 为空即「当前使用」不点亮），并在引擎卡上如实标注「未保存」，要求显式点保存。回执头不能整块藏掉（「重新检测」入口挂在那里）：未保存时它仍显示本机默认，但标签从「当前使用」换成「本机默认（未保存）」。派发路径（`job-store` → `resolveCliId`）保留落盘：点「评估」是用户的显式动作，而服务端镜像必须与派发卡片显示的引擎一致，否则扩展与后续 run 会读到一个没人认领的引擎。
3. **`persistCliId` 落盘 `cliId` 时一并校正 `model`**。判定用共享纯函数 `modelBelongsToOtherCli(model, ownIds, otherIds)`：模型 id 明确属于别家引擎目录 → 同时清掉本地与服务端的 `model`（POST 空串即删除键），本地 `modelCliId` 一并清空；保守档（不动）有两种：两边都不认识这个 id（用户自填 slug），以及**本引擎根本没目录可参考**——静态表刻意留空的 qoder-cn、目录读自用户配置的 opencode，以及检测响应里没这一行。误丢的代价是把用户选的模型静静换成引擎默认，比漏过一个脏模型更难发现，所以守卫只在有明确证据时动手。
4. **派发侧第二道守卫，三路由同源**。`clis.ts` 导出 `dropCrossEngineModel(cliId, model)`（把静态 `MODELS` 压成目录表交给 `dropForeignModel`，不 spawn 探针；`own` 为空即不判定，所以 qoder-cn / opencode 的运行时目录不会被静态表误杀），`/api/run`、`/api/batch-evaluate`、`/api/batch-checkup` 在拼 argv 之前清洗一次，清洗后的值同时用于 `withModelFlag`、并发池快照与运行账本，不静默降级。告知方式按通路各自的诚实口径：单任务有事件总线，发一条 status 点名「已忽略不属于此引擎的模型 X，改用该引擎默认」；批量两条没有等价的单条 status 通道（既有 NDJSON 是逐项事件），丢弃由「引擎行只显运行时、不显模型」表达（ADR-0043 决议 4 的缺失口径），不新造事件类型。
5. **不新增配置真值源**，`/api/config` 的键集合不变（`cliId/model/unknownEmployer/concurrencyPool`）；`modelCliId` 继续只是本地字段，服务端没有它，因此守卫不依赖它。

## 后果

- 「你没动过配置但引擎变了」这条路径被堵死：唯一还能改写服务端 `cliId` 的两处（保存按钮、派发时兜底）都对应一次用户动作，且都带着模型校正。
- 跨引擎脏模型不可能再进 argv：配置页漏一层（旧 localStorage、别的浏览器、清了站点数据），服务端守卫兜住；扩展读到脏镜像，同样兜住。代价是守卫只认目录表里看得见的证据：`own` 为空即不判定，所以 qoder-cn / opencode 运行时读到的真实目录不会被静态表误杀，而「只存在于别家动态表」那一类脏组合会漏过去 —— 漏过去的结果只是引擎自己报一句模型不存在，不会像现在这样拼出一个谁都没配置过的组合。
- 账本的 `model` 语义微调：仍是「派发那一刻的请求值」，只是那个请求值现在是守卫清洗后的值；被丢时记 `undefined`（界面按 ADR-0043 决议 4 显示运行时、不显示模型），不谎报。
- 配置页打开落在哪个档位，从此只由主配置决定；快评面板的 provider/model/baseUrl 不受影响。
- 回滚：本 ADR 六点各自单点可回退（`model-ownership.mjs` + `clis.ts` 一个导出 + 三路由一行 + `saved-cli.ts`/`config-form.tsx` 各自局部），存储格式未变，老数据可读。
