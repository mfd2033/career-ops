"use strict";

// 渲染层唯一的外设入口（工单 04）：contextBridge 白名单，只暴露这几条通道。
// 渲染层没有 fs / node 权限，也永远不直接连 localhost:3000（ADR-0086 决策 7）。

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("tray", {
  // 面板
  snapshot: () => ipcRenderer.invoke("shell:snapshot"),
  onSnapshot: (callback) => subscribe("shell:snapshot", callback),
  restart: () => ipcRenderer.invoke("service:restart"),
  openDashboard: () => ipcRenderer.invoke("app:openDashboard"),
  // applied|responded|interview|offer → /pipeline?tab=X；followups → /followups
  openTab: (tab) => ipcRenderer.invoke("app:openTab", tab),
  showLogs: () => ipcRenderer.invoke("logs:show"),
  fit: (height) => ipcRenderer.invoke("window:fit", height),
  hide: () => ipcRenderer.invoke("app:hideFlyout"),
});

contextBridge.exposeInMainWorld("logs", {
  snapshot: () => ipcRenderer.invoke("logs:snapshot"),
  tail: (afterSeq) => ipcRenderer.invoke("logs:tail", afterSeq),
  openFolder: () => ipcRenderer.invoke("logs:openFolder"),
  clear: () => ipcRenderer.invoke("logs:clear"),
});
