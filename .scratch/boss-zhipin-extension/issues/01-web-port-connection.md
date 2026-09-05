# 01: 扩展识别并连接本地 web 服务

**What to build:**

扩展加载进 Edge（或 Chrome）后，无需任何配置即可自动找到本地 web dashboard 的端口并确认连通；同时后端对「本扩展」发起的本地请求放行并允许跨源。这是所有后续能力（打标、评估、跳报告）的底座：没有这条「扩展 ⇄ 本地 web」的信任链路，其余工单都无从谈起。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 后端对 loopback 且 Origin 等于固定扩展 ID 的 `chrome-extension://{id}` 请求放行，返回对应 `Access-Control-Allow-Origin` 头；其余跨站请求维持 403 不变
- [ ] 扩展 `manifest.json` 用固定 `key` 生成稳定扩展 ID，且该 ID 与后端放行白名单一致（开发/生产一致）
- [ ] 扩展 background 自动探测 `localhost:3000-3040` 的 `/api/version` 命中 web 端口并缓存；失活时能重新探测
- [ ] 扩展 popup 显示已连接状态（如「已连接 localhost:3088」）；未探测到 web 服务时给出明确提示，不静默失败