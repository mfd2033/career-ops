# ADR-0091: 求职意向卡统一管理 target_roles.primary 与 archetypes

- 状态：采纳（2026-10-28）
- 决策人：用户（探索页关键词双词困惑排查引出）
- 关系：修订 ADR 同名的「web 写口不得覆盖 archetypes」保护性约束（api/profile/route.ts 头注释、DATA_CONTRACT user-layer 条目）；沿用 profile-merge.mjs 文本级手术（#649/#704/#920/#958 数据丢失守卫）与 deal-breakers → `_profile.md` 同步先例的形态，但**不**新增 `_profile.md` 写回

## 背景

`config/profile.yml` 的 `target_roles` 有两个同级字段：`primary`（字符串列表）与 `archetypes`（`{name, level, fit}` 对象列表）。探索页/扫描的关键词播种口径是**两者名字合并**（`web/src/lib/core/portals.ts` seedExploreFilters ↔ 核心 `providers/_profile-keywords.mjs`，有 parity 测试守卫），但配置页「求职意向」卡只编辑 `primary`——`archetypes` 对它是只读保护字段（route.ts 头注释明言 never clobber）。

后果是双源不同步且用户不可见：本机 profile 里 `primary: [软件项目经理]` 而 `archetypes` 还有「技术经理」，探索页关键词框就出现「软件项目经理 技术经理」两个词，配置页却解释不了第二个词从哪来。排查确认「技术经理」是 2026-10-22 定位会话手写的，不是任何自动化流程产生。

**不改播种口径**：archetypes 并入关键词是与核心刻意同口径的设计，改口径等于改整个定位语义。

## 决策

1. **求职意向卡新增「原型（Archetypes）」编辑区**（工单 03）：第二个每行一个名字的文本框，只暴露名字；`level`/`fit` 是评估画像细节，不在 UI 编辑但**保存时原样保留**（见决议 3）。i18n en/zh 各补一组 `config.jobTargetArchetype*` 键。
2. **API 扩展 ProfilePatch：`archetypes?: string[]`**（工单 02）。`undefined` = 不动；空数组 = 删 `target_roles.archetypes` 键（复用 mergeYamlPatch 的 null 删除语义，不留歧义空值）；非空 = 名单整体替换（数组整体替换语义，与 primary/deal_breakers 一致）。GET 预填返回 `{name, level?, fit?}[]`。
3. **按名字 reconcile，保留既有画像字段**（工单 02，纯函数 `reconcileArchetypes`）：以新名单的顺序为输出顺序；名字仍存在 → 整个旧条目对象原样保留（level/fit/未知键都不丢）；新名字 → `{name, fit: "primary"}`（level 留空交由用户在 profile.yml 手工补）；重名去重取首次出现。
4. **profile-merge.mjs 的 `writeList` 扩展支持对象块条目**（工单 01）：现在它对每个元素只调 `renderScalar`，对象会渲染成 `[object Object]`。扩展为：对象条目渲染成 YAML 块映射（`- name: X` 起行、后续键对齐缩进、值走 renderScalar），标量条目行为不变；既有标量列表的回归锁全部保持。
5. **一次保存同时携带 roles 与 archetypes**：求职意在一起的 PATCH 里发两个名单，单次原子写（temp + rename），不拆两次请求。
6. **保存守卫不放松**：仍走 confirm-gated setProfile 通路；profile.yml 非法 YAML 时 409 拒写；mergeYamlPatch 报 skipped 时 409 拒写。对象块渲染错误导致的 shape 冲突同样落到 skipped，宁可拒绝不猜。

## 范围（不动）

- **不改播种口径**：`seedExploreFilters` 与 `providers/_profile-keywords.mjs` 保持 primary + archetypes.name 合并，parity 测试一字不动。
- **不写 `modes/_profile.md`**：其「Your Target Roles」表是主题轴散文画像（含 What they buy 等叙述），名字列表同步不进去；deal-breakers 的节替换先例不外推。
- **不做芯片/徽章级 UI**：与卡片现有形态一致用每行一个的文本框，不引新组件风格。
- **不动 explore 页**：关键词框的播种与临时 portals.yml 通路照旧。

## 后果

- 求职意向卡成为 target_roles 两半的唯一 web 编辑口：探索页关键词框里每个词都能在配置页指出来源并就地修改。
- 「never clobber archetypes」收窄为「**除了求职意向卡显式提交的 archetypes 名单**」：保护目的（表单保存不冲掉手写画像）由 reconcile 保留 level/fit 实现，而非禁止写入。
- 用户在 profile.yml 手工加的 archetypes 条目（含注释、自定义字段）在下次卡片保存时：名字保留则块原样保留、名字删除则随名单整体替换被移除——item 级注释会随块替换丢失（与 primary 的既有行为一致，writeList 头注释已言明）。

## 关键文件

`web/src/lib/profile-patch.mjs`（archetypes 映射 + reconcileArchetypes）、`web/src/lib/core/profile-merge.mjs`（writeList 对象块）、`web/src/app/api/profile/route.ts`（GET 预填 / POST reconcile + 发写）、`web/src/components/job-target-settings.tsx`、`web/src/lib/i18n/clusters/config.ts`。测试：`web/tests/lib/profile-merge.test.mjs`、`web/tests/lib/profile-patch.test.mjs`、`web/tests/lib/job-target-archetypes.test.mjs`（reconcile 纯函数）。
