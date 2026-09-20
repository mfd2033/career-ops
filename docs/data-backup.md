# 数据层影子备份（fork-local，2026-09-20 启用）

## 为什么存在

主仓库的 `.gitignore` 把所有个人数据排除在版本控制之外（`data/*`、`reports/*.md`、
`cv.md`、`config/profile.yml`、`modes/_custom.md`、`portals.yml`、`interview-prep/`、
`writing-samples/`、`todo-list/`）。这个分离对 GitHub 推送是正确的，但它意味着**664 条投递记录、
700+ 份评估报告、简历与个性化配置只存在于这一块磁盘上，没有任何历史**——误删、
改坏、批量流程写坏（如 #256 列错位事故）都无法回滚。

影子备份用第二个 git 账本专门给数据层记历史，与主仓库完全互不干扰。

## 架构：账本与文件分家

git 的"账本"（`--git-dir`）和"被记账的文件"（`--work-tree`）可以分离：

```
D:\workspace\career-ops\          主仓库：一个 .git，只记系统层代码（不变）
D:\career-ops-data-history\       影子账本：裸仓库，只记数据层，永不配 remote
local\backup-data.cmd             一键快照（脚本内路径清单 = 备份白名单）
local\restore-data.cmd            按快照恢复单个文件
```

关键性质：

- **永不推送**：影子账本没有也不允许有 remote。数据（简历、薪资目标、投递记录、
  猎头机构名）是保密信息，只在本机。任何"把它推到 GitHub/NAS"的动作必须由用户
  明确发起，agent 不得代做。
- **字节级忠实**：账本的 `info/attributes` 写了 `* -text`，禁用换行归一化；
  快照 blob 与磁盘文件 SHA-256 一致（2026-09-20 对 `data/applications.md` 与
  `cv.md` 做过恢复演练验证）。
- **主仓库无感知**：账本项目之外，项目内零新增隐藏文件，`git status` 不受影响。

## 白名单（备份范围）

以 `local\backup-data.cmd` 里的 `git add -Af --` 路径清单为准：

```
data/  reports/  interview-prep/  writing-samples/  todo-list/
cv.md  portals.yml  modes/_custom.md  modes/_profile.md  config/profile.yml
```

**新增数据目录时必须同步改这份清单**（`-Af` 的显式路径就是唯一权威白名单；
影子账本刻意不使用 exclude 规则，因为项目内各层 `.gitignore` 会穿透进来把
`data/*` 等挡掉——这是配置时踩过的坑，勿改回 exclude 方案）。

## Agent 操作规程（重要）

1. **危险操作前必须先快照**：任何将批量改写数据层的操作——`merge-tracker.mjs
   --migrate-via`、直接编辑 `data/applications.md`、`set-status.mjs --force`、
   批量重命名/归档 `reports/`、`dedup-tracker.mjs` 等——执行**之前**先跑
   `local\backup-data.cmd`。跑砸了才有得恢复。
2. **每轮会话收尾建议快照**：本轮动了 tracker/报告/个性化文件时，收尾提醒用户
   跑一次（或直接代跑，命令无副作用、无变化时自动跳过）。
3. **恢复永远先落到新文件**：`local\restore-data.cmd <rev> <路径> <新文件>`，
   diff 确认后再手工替换。禁止 `checkout` 直接覆盖工作区文件。
4. 影子账本对主仓库的所有 git 操作（commit/push/merge）透明，不要在主仓库
   的提交信息里引用它。

## 常用命令

```bat
:: 快照（无变化自动跳过）
local\backup-data.cmd

:: 看历史 / 某文件的历史
git --git-dir=D:\career-ops-data-history log --oneline
git --git-dir=D:\career-ops-data-history log --oneline -- data/applications.md

:: 恢复到临时文件比对
local\restore-data.cmd HEAD~3 data/applications.md restored-app.md

:: 确认账本健康（应输出 tracked 文件数、无报错）
git --git-dir=D:\career-ops-data-history fsck
```

## 局限

账本与数据同盘——防误删/误改满分，防整块盘物理损坏为零。异地化（把
`D:\career-ops-data-history` 文件夹定期拷到第二块盘/NAS）是用户决策，尚未配置。
