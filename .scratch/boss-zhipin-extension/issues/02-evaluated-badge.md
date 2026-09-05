# 02: BOSS 已评估职位打标

**What to build:**

用户浏览 BOSS 直聘列表/详情时，凡此前已评估过的职位（tracker/报告里已有对应记录）立即显示「已评估」徽章并带评分，一眼看出哪些看过了、结果如何，不再靠记忆分辨。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] 新增已评估查询 API：给定一批归一 URL，返回 `{ url: { score, reportNum } }`；判定 key 与探索/管道页同一 `normalizeUrl`，避免「已评估却被标为未评估」
- [ ] content script 在 BOSS 列表职位卡片上注入「已评估」徽章（含评分），样式清晰不影响点击浏览
- [ ] BOSS 是 SPA 动态渲染，徽章注入需经 MutationObserver 跟随新增列表节点，滚动加载出的新职位也能打标
- [ ] 徽章携带跳转所需信息（报告号），供报告跳转工单直接复用