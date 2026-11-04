# ADR-0098: web 路由的事件循环预算——重活异步化 + 签名缓存

- **Status:** Accepted (2026-11-04)
- **Context:** 本地 web 服务是**单进程单事件循环**（Next standalone，一个端口）。托盘壳用 2500ms 探 `/api/version`、5000ms 拉业务接口（`tray-shell/src/service.cjs`），浏览器扩展用 6s 探同一接口（ADR-0063 修订三）。只要有一条路由把事件循环占住几秒，**所有**探针都会超时——服务明明活着，两边却各自判「异常/未检测到」。
  实测（2026-11-04，`127.0.0.1:3000`，816 行 tracker / 824 份报告）：

  | 场景 | 该请求耗时 | 期间 `/api/version` |
  |---|---|---|
  | 空载 | 19ms | 3ms |
  | 1 个 `/api/report-status` | 850ms | 654ms |
  | 3 个并发 `/api/report-status` | 1003 / 1871 / 2806ms（**串行**） | 2610ms |
  | `/api/clis?refresh=1` | 4816ms（模型目录冷时 17821ms） | 4615ms |

  `launcher.log` 里 16:51:23 与 22:35:23 两条 `业务数据降级：/api/active-runs … 5002ms` 就是同一现象在托盘侧的投影。
  同步成本拆解（同一次测量）：`realpath(root)`×816 = 241ms、`realpath(报告)`×800 = 243ms、读全部报告 6.3MB = 143ms、`stat` 824 份 = 35ms、解析 `applications.md` = 6ms。
  请求路径上的**同步子进程**清单：`/api/version` 的 `execSync("git rev-parse")`；`clis.ts` 每引擎一次 `spawnSync(--version)`（15s 超时）、`opencode-models`/`qoder-models` 的 `execFileSync`、`workbuddyBundledCliDirs` 的 `reg query /s`；黑名单写入路径 `execFileSync("cmd.exe", backup-data.cmd)`（60s 超时）。
- **Scope:** `web/src/app/api/version/route.ts`、`web/src/app/api/report-status/route.ts`、`web/src/lib/career-ops.ts`（报告路径解析）、`web/src/app/api/tracker/route.ts` + `web/src/lib/tracker-api.ts`、`web/src/lib/clis.ts`、`web/src/lib/cli-bin-dirs.mjs`、`web/src/lib/opencode-models.mjs`、`web/src/lib/qoder-models.mjs`、`web/src/lib/blacklist-store.ts`、`web/src/app/api/clis/*`、测试。**不动**：`/api/version` 的响应契约（扩展与托盘按字段读）、评分/派发/权限模型、`report-status-map.mjs` 的装配规则（ADR-0074 契约不变）、端口与探测区间（ADR-0063）。

## Decision

1. **预算是一条硬约束，不是优化目标。** 任何请求处理器的**连续同步工作 ≤ 50ms**；探针路由（`/api/version`、`/api/active-runs`）稳态 **≤ 5ms 且零 I/O、零子进程**。判据是「重请求在飞时 `/api/version` 仍能在几十毫秒内答复」，不是「接口本身快」。
2. **探针路径禁止子进程。** `/api/version` 的 git sha、`VERSION`、`package.json`、`build-info.json` 全部进程内 memo：打包版读 build-info（本来一次），dev 首次算一次 sha，此后纯内存。sha 在进程生命周期内可能过期（用户切了分支），这是刻意取舍：探针回答的是「这是哪个正在运行的服务」，不是「工作树现在是哪个 commit」。
3. **请求路径禁止同步子进程。** `execSync` / `spawnSync` / `execFileSync` 一律改 `execFile` + Promise，多个探测器用 `Promise.all` 并发跑（它们互不依赖）；失败/超时各自降级，ADR-0028 的 `installed ≠ usable` 语义原样保留。唯一例外：**验收测试**可以同步 spawn。
4. **批量读盘走签名缓存，不走 TTL。** 缓存键 = `mtimeMs + size`（目录 = `readdir` 清单拼成的字符串签名）。语义是「输入文件没变 → 结果没变」，所以文件一变立刻失效、没变就一直命中；TTL 会同时带来两种错——文件变了还返回旧值，以及没变也白算。缓存只在进程内，重启即空。
5. **并发合流。** 同一 key 的在飞请求共享同一个 Promise：`/api/tracker` 的并发查询只 spawn 一次子进程；`/api/report-status` 的并发请求只构建一次索引。写路径成功后主动失效相关缓存（写后 mtime 本来就会变，主动失效只是让下一次读不必等一次 stat 判空）。
6. **进程级常量只算一次。** `realpath(root)` 是常量，`careerOpsRoot()` 已 memo，realpath 也 memo；它是 `containedRealpath()` 的一半成本（另一半是每个候选文件自己的 realpath）。
7. **`/api/report-status` 的报告解析走两级缓存。** 一级：`reports/` 目录 → `报告号 → 文件名` 索引（目录签名失效）；二级：单个报告的 URL（路径 + `mtimeMs` + `size` 失效）。稳态成本 = 一次 `applications.md` 解析 + 824 次 `stat`（约 40ms），冷启动成本保留（约 850ms）但**异步**，不再整段占住循环。
8. **诊断口径写进 ADR，不写进接口。** 验证方法固定为「并发 3 个重请求时采样 `/api/version`」；不为此给 `/api/version` 加 loop-lag 字段——探针超时时本来就取不到字段，能取到时也不需要它。

## Alternatives considered

- **把扩展/托盘的超时调大。** 只把症状推远：17.8s 的同步探测面前，任何「合理」的超时都会红；而调大意味着用户等更久才收到同一个错误。ADR-0063 修订三已把「区分服务忙与没起」做完，这一层是它的前提。否决。
- **给 web 起 cluster / 多进程。** Next standalone 是单端口单进程；多进程要解决端口分发与内存缓存跨进程一致（本 ADR 的缓存全在进程内），复杂度与收益不成比例，且托盘/扩展的健康判定仍会被任意一个 worker 拖住。否决。
- **把重活丢给 `worker_threads`。** 结构上更彻底，但要重做缓存的跨线程所有权与错误传递；目前没有真正的 CPU-bound 热点（824 份报告解析 + 读盘 143ms，I/O 占大头），异步 I/O + 签名缓存已能把稳态压到 50ms 内。留作以后 CPU 热点出现时的下一个手段。
- **给 `/api/tracker` 加 TTL 缓存。** 会出现「用户刚改完，列表还是旧的」——tracker 是用户正在写的文件，这正是 `force-dynamic` 注释要防的事。签名缓存既新鲜又快，否决 TTL。
- **`/api/report-status` 改推（SSE/WebSocket）。** 扩展需要的是加载时的一次性快照，推送要引入连接保活与重连状态机；而按签名缓存后普通 GET 已经是毫秒级。否决。
- **去掉报告的 `containedRealpath` 校验换速度。** 文件名字来自 `readdir` 不含 `..`，但 `reports/` 里可能有符号链接指向仓库外，那是这条链路的越界面。改为「URL 结果按 path+mtime+size 缓存」，realpath 只在真正重算时付一次，校验强度不减。否决删校验。
- **保留 `execSync(git rev-parse)`，理由「它只跑几十毫秒」。** 它跑在**探针**上，且是探针唯一的子进程；机器一忙（正是要诊断的那种时刻）它会从 30ms 涨到几百毫秒，把探针自己变成不可信。否决。

## 实施后实测（2026-11-04，`node local/dev-web.mjs -p 3101`，同一压测口径）

| 场景 | 改造前 | 改造后（dev 服务器） |
|---|---|---|
| `/api/report-status` 单请求 | 850ms（连续占用） | 首次 ~460ms（冷）/ 稳态 62–75ms |
| 3 个并发 `/api/report-status` | 1003 / 1871 / 2806ms | 68 / 69 / 68ms（共享一次构建） |
| 上述期间 `/api/version` | 654ms / 2610ms | 9–17ms |
| `/api/tracker`（文件未变） | 411ms（每次 spawn） | 10–15ms；4 个并发 38ms |
| `/api/clis?refresh=1` | 4816ms（冷 17821ms） | ~3100ms（并发探测，取最慢者） |
| 上述期间 `/api/version` | 4615ms | 最大 182ms（Next dev 首次编译）/ 其余 11–40ms |
| `/api/version` 单独 | 19ms（每次 git + 读 4 文件） | 稳态 9–13ms（纯内存） |

报告索引本身的分段成本（node 直测，752 份报告）：并发 `stat` 25ms，串行 `stat` 55ms，`buildReportStatusMap` <1ms。
注：dev 服务器的稳态 62–75ms 里含 Turbopack 与 Next 自身的开销；打包版实测会低于此值。

## Consequences

- `/api/report-status`：冷请求仍约 850ms（读 6.3MB 报告），但异步执行；稳态约 40ms。扩展首次加载的「已评估」标记不再可能触发自身的 6s 超时。
- `/api/tracker`：文件未变的重复查询不再 spawn 子进程（411ms → ~0）；文件一变立即重建；并发同参数请求共享一次 child run。
- `/api/clis`：`refresh=1` 从 4.8s（冷 17.8s）降到「最慢单个探测器」的量级，且不占住循环——期间 `/api/version`、托盘业务接口、扩展探测都能正常答复。
- 黑名单写入的 shadow backup 不再同步阻塞（60s 超时的同步 spawn 曾是写入期间最长的黑洞）。
- 缓存全部进程内：外部工具改文件 → mtime 变 → 下次读重建；`mtimeMs+size` 完全相同的改写（人为回拨 mtime 且字节数一致）会漏判，接受——这不是本服务的写入路径能产生的状态。
- 报告 URL 缓存的失效粒度是单文件：补一份报告只重算那一份，不会因为一份新报告把 824 份全部重读。
- 代价：新增一层缓存代码与它的失效规则，必须在改这几个读取方时同步想清楚「我改的是不是缓存键的一部分」。`report-status-map.mjs` 的装配规则不动，缓存只包住「取 URL」这一层，所以 ADR-0074 的接口契约与测试不受影响。

## References

- ADR-0063 修订三（端口固定 3000、探测三态；本 ADR 是它「治根」的后续）
- ADR-0050（工具栏连接状态徽章：探针超时不等于服务没起）
- ADR-0015（检测结果进程内缓存 + 手动重检，本 ADR 决议 3 让检测本身不再阻塞）
- ADR-0028（`installed ≠ usable`：`--version` 探针语义不变，只是改成异步）
- ADR-0074（`/api/report-status` 的契约：键归一化、首行胜出、`checkupStar` 只展示）
- `web/src/app/api/version/route.ts`、`web/src/app/api/report-status/route.ts`、`web/src/app/api/tracker/route.ts`、`web/src/lib/clis.ts`、`web/src/lib/cli-bin-dirs.mjs`、`web/src/lib/blacklist-store.ts`
- 测试：`web/tests/lib/report-status-index.test.mjs`、`web/tests/lib/tracker-query-cache.test.mjs`、`web/tests/lib/clis-*.test.mjs`（既有检测用例改为异步调用）
