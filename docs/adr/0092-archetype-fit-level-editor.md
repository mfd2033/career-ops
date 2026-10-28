# ADR-0092: 原型编辑器暴露 level 与 fit 分层

- 状态：采纳（2026-10-28）
- 决策人：用户（求职意向卡两框填同名内容，看着像重复配置项，引出「原型到底该暴露什么」的重新斟酌）
- 关系：扩展 ADR-0091 决议 1（「只暴露名字」）与决议 3（按名 reconcile 语义）；其余全部沿 ADR-0091——空名单删键三态、文本级 merge、保存守卫、播种口径均不变

## 背景

ADR-0091 落地后，求职意向卡有「目标职位」与「原型」两个文本框。实际形态是：两个框都只编辑**名字列表**（每行一个），唯一区别是写入 `target_roles.primary` 还是 `target_roles.archetypes`。原型的独有画像信息——`level`（职级）与 `fit`（匹配度分层，评估打分依据）——网页不提供任何编辑入口，新名字一律补 `fit: "primary"`，`level` 留空。

后果：当用户两边填同样的名字时（当前本机即如此），卡片看起来就是同一个配置写了两遍；而 fit 分层（primary=梦想 / secondary=合适 / adjacent=够得着，triage 按 4–5 / 3 / 拉伸打分）这个真正有价值的分层能力，用户只能手编 profile.yml 才用得上。

## 决策

1. **原型区从 textarea 变结构化行**（job-target-settings.tsx）：每个原型一行三个控件——名称（文本）、等级（文本，YAML 里本就是自由文本，不强制枚举）、匹配度（三选下拉：梦想/合适/够得着 → primary/secondary/adjacent）。行尾删除按钮，底部「添加一行」。目标职位框保持现状不动。
2. **PATCH 形态扩展：`archetypes: (string | {name, level?, fit?})[]`**。字符串条目仍被接受（等价 `{name}`，向后兼容旧调用方与既有测试）。对账规则在 ADR-0091 决议 3 基础上扩展：
   - 名字仍存在：提交里带了**合法枚举** fit → 覆盖磁盘值；fit 缺失/非法 → 沿用磁盘旧值。level 非空字符串 → 覆盖；空/缺失 → 沿用。未知键照旧原样保留。
   - 新名字：用提交的 level/fit；fit 缺失或非法 → 缺省 `"primary"`；level 空 → 不带（沿 ADR-0091「细节留给手编」缺省）。
3. **fit 枚举封闭为 `primary | secondary | adjacent`**。手编 YAML 塞了枚举外值（如 `stretch`）时：UI 下拉追加一个原样显示该值的「自定义」选项并保持选中，保存原样回传；服务端按「未提供」处理（沿用磁盘旧值）——**不静默改写、不静默丢弃**。
4. **i18n 文案随能力重写**：目标职位框说明收敛为「搜索/扫描用的职位名」；原型框说明改为「评估打分用的方向画像，可标等级与想要程度」。en/zh 同步。
5. **GET 预填返回完整对象**：route 本来就返回 `{name, level?, fit?}[]`（extractArchetypes 整条对象），前端此前自己扔掉了 level/fit——只需前端改，API 读路径零改动。

## 范围（不动）

- 播种口径（primary + archetypes.name 合并）、parity 测试照旧。
- 不写 `modes/_profile.md`；不动 explore 页。
- 空原型名单 = 删键、undefined = 不动、按名归一对账、unknown keys 保留——全沿 ADR-0091。
- 服务端写路径（mergeYamlPatch 对象块渲染）不变——提交的仍是整条对象列表，只是对象内容多了显式 level/fit。

## 后果

- 求职意向卡成为 archetypes level/fit 的 web 编辑口；两框能力真正分化：目标职位 = 检索词，原型 = 打分画像。重复感消除。
- profile.yml 手改的 level/fit 在卡片保存时：UI 显示什么就存什么（UI 未暴露的字段/未知键保留）。名字被删的条目随名单整体替换移除（沿 ADR-0091 既有行为）。
- 等级输入是自由文本，不校验语义（如「资深」vs「Senior」的混用由用户自担）——与 profile.yml 手编形态一致，不做规范化。

## 关键文件

`web/src/lib/profile-patch.mjs`（reconcileArchetypes 扩展 + patchToProfile 对象条目）、`web/src/app/api/profile/route.ts`（POST 类型注释与守卫）、`web/src/components/job-target-settings.tsx`（结构化行）、`web/src/lib/i18n/clusters/config.ts`。测试：`web/tests/lib/job-target-archetypes.test.mjs` 扩展（对象条目覆盖/沿用/非法 fit 回退/等价门）。
