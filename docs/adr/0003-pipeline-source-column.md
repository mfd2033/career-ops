# ADR-0003：管道页「来源」列——URL 域名反推展示职位来源

- 状态：已接受（Accepted）
- 日期：2026-09-06
- 相关：`web/src/components/pipeline-view.tsx`、`web/src/lib/source-label.mjs`、`data/applications.md`

## 背景

web 端求职管道页（`/pipeline`）的 tracker 表只展示 公司/角色/分数/状态/日期，
用户要求增加「来源」列，明确每个职位来自哪个平台（BOSS直聘、猎聘等），
便于观察渠道构成与投放是否集中在单一平台。

## 决策

1. **落点**：`/pipeline` tracker 表的最后一列（日期之后）。纯展示，不参与排序/筛选。
2. **数据来源**：由职位 URL 的域名反推平台，**不迁移数据**。
   `Application`（tracker 行）已有 `url` 字段，无 `source` 字段；发现来源写入
   `data/pipeline.md`/`scan-history.tsv`，并未进入 tracker，故不引入 tracker 格式变更。
3. **识别规则**：域名后缀匹配
   `zhipin.com→BOSS直聘`、`liepin.com→猎聘`、`zhaopin.com→智联招聘`、`lagou.com→拉勾`、
   `greenhouse.io→Greenhouse`、`lever.co→Lever`、`ashbyhq.com→Ashby`、
   `myworkdayjobs.com→Workday`。识别不出 → 显示占位符「—」。
4. **空 URL 不回退读 report**：全表仅 1 条当事人判定为空（#31，superseded 死行），
   已按 Q7 决策删除该行。不为 1 条存量行引入 report 头部读取的额外 I/O。
5. **实现**：独立 client-safe 模块 `web/src/lib/source-label.mjs` 暴露 `sourceLabel(url)`，
   与 `explore.ts` 的 `BROWSER_LABEL`/`ATS_LABEL`（来源 ID→标签）是两套正交映射，互不耦合。

## 明确不做

- 不改 tracker 列结构，不为来源新增字段写入 `data/applications.md`。
- 不为来源列加排序/筛选（求职漏斗无此诉求）。
- 不通用回退读 report `**URL：**` 头部补来源。

## 影响

- 前端新增一列，表 `min-w` 不变，横向可滚动区域自动容纳。
- 现有数据零迁移，存量行按 URL 即显来源。