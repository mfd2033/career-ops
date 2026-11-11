# 操作台账（/logs 的数据来源）

`/logs` 页面有两类记录：自动任务的运行记录，和你在页面上手动做过的动作。前者来自既有台账，后者来自这份操作台账。本文只讲后者：它有哪些入口、为什么记、新增入口怎么接。

## 文件在哪

`.career-ops-web/op-log.jsonl`，一行一条 JSON，追加写。

不放在 `data/` 是因为它属于纯运行产物，删掉不影响任何业务数据，重建条件只是「以后发生的动作再记一遍」。用户层（`data/`）的每个 TSV 都要在 `DATA_CONTRACT.md` 登记列定义与唯一写入者，台账不该占那个位置。

## 什么记，什么不记

**手动动作记**。你点某个按钮、改某个字段、删某一行，这些动作在别的事实源里查不到，不记就丢了。

**自动任务不记**。评估、批量体检、扫描、CV 定制已经在 `runs/index.jsonl`（运行记录）、`data/scan-runs.tsv`（扫描计数）、`data/status-log.tsv`（状态变更）各有一份唯一事实源。页面读取端把两路聚合，这里再记一遍会让同一件事出现两条。

判断方式：这次写入对应用户的一次明确意图就记；不是的话，在门禁的豁免表里写清理由。

## 入口 → 类型对照

| 入口 | 类型 | 记什么 |
|---|---|---|
| `POST /api/cv` | `cv-save` | 写回 `cv.md` |
| `POST /api/profile` | `profile-save` | 改了哪些键（值不记） |
| `POST /api/followups/cadence` | `cadence-save` | 改了哪些键（值不记） |
| `POST /api/portals` | `portals-save` | 字段名 + 新增词条数 |
| `POST /api/portals/title-filter` | `portals-save` | 字段名 + 保留/排除词条数（与上一行共用类型，靠 `fields` 区分） |
| `POST /api/skills` | `skill-dirs` | 自定义目录数 |
| `POST /api/memory` | `memory-write` | 写入结果（`verdict`，去重时也记） |
| `PUT /api/quick-config` | `quick-key` | 动作（add/update/remove/activate），不记密钥 |
| `POST /api/config` | `config` | 应用配置 |
| `POST/DELETE/PATCH /api/blacklist` | `blacklist` | 黑名单变更 |
| `POST /api/tracker` | `tracker-add` | `#N 公司 · 岗位` + 去重结论 |
| `PUT /api/tracker/upsert` | `tracker-upsert` | 同上 |
| `PATCH /api/tracker/[id]` | `tracker-edit` / `status-change` | 行号、公司岗位；状态变更另外记 from→to |
| `POST /api/tracker/delete` | `tracker-delete` | 被删行 |
| `POST /api/status` | `status-change` | 状态与时刻 |
| `POST/DELETE /api/followups/override` | `followup-pin` | 钉住/取消钉住、日期 |
| `POST/DELETE /api/followups/log` | `follow-up` / `follow-up-delete` | 跟进记录增删 |
| `POST /api/explore/add` | `pipeline-add` | 加进管道的岗位 |
| `POST /api/pipeline/remove` | `pipeline-remove` | 移出管道 |

类型白名单在 `web/src/lib/op-log.mjs`（`OP_LOG_TYPES`），同时定义该类型属于手动还是自动。白名单之外的字符串会被静默丢弃，这是故意的：台账的类型必须可枚举，不能变成自由日志。

## meta 只放键名

`logConfigWrite` 的 meta 只记「改了哪几个键」和数量，不记值。`cv.md`、`config/profile.yml`、`portals.yml` 的值里有本机绝对路径、邮箱、密钥明文，台账只用于回看索引，不保存数据本身。

这条纪律的实现拆在 `web/src/lib/core/op-log-meta.mjs`（纯函数），由 `web/tests/lib/op-log-meta.test.mjs` 盯着：字段封顶 12 个、空项丢弃、只输出键名。

## 新增入口的步骤

1. 判断属于手动还是自动。自动的到此为止。
2. 手动的在路由里调 `logConfigWrite`（配置类写文件）、`logOperation`（单条动作）或 `logTrackerRowWrite`（tracker 行）。这些 helper 永不抛错，台账写失败不影响用户的操作本身。
3. 新类型加进 `web/src/lib/op-log.mjs` 的白名单，并在 `web/src/lib/i18n/clusters/logs.ts` 补中英文案。
4. 想让它关联到某个页面，传 `href`。

## 门禁

`web/tests/lib/api-write-routes-log.test.mjs` 扫 `web/src/app/api/**/route.ts`：出现写盘调用（`atomicWriteWithBackup`、`writeFileSync`、`runTrackerScript` 等）却没有埋点调用的路由，测试直接失败。

确实不该记的，加进该文件的 `EXEMPT` 表，写明写的是哪个文件、为什么不用记。表里的失效条目（路由已删、已补埋点、已不再写盘）同样红灯，因为豁免表会变旧，旧了就没法信。目前 9 条豁免，全是运行产物、临时文件或已有唯一事实源的派生物。

## 冒烟

不想开浏览器时，用脚本把入口整体过一遍：

```bash
node local/dev-web.mjs -p 3101                        # 一个终端
node local/oplog-smoke.mjs --base http://localhost:3101
```

脚本用真实 HTTP 打 8 个手动入口（同一值回写或可逆操作），核对台账里确实多出对应类型，然后按 sha256 逐字节还原所有被动过的文件，最后删掉本次新产生的 `.bak-*` 和台账本身。

跑之前先执行 `local\backup-data.cmd` 存一份影子账本，这是脚本自身快照之外的第二道恢复点。还原失败时脚本保留快照目录并报错，不会继续往下走。

## 已知盲区

CLI/agent 侧直跑不经过 Web 的写入链路，目前不留台账：`tracker-add.mjs`、`tracker-edit.mjs`、`tracker.mjs delete`、`merge-tracker.mjs`。CLI 发起的评估也不进 `runs/index.jsonl`。补这一块要处理跨进程锁与路径解析，成本和收益还没算平，暂列待办。
