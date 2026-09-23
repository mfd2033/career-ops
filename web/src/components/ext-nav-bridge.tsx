"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";

// 扩展 → web 端的前端路由跳转（ADR-0055 修订）。
//
// 招聘站页面（BOSS/猎聘/智联）上点击「已评估」徽章时，扩展 SW 不再把 web 端整页重载，
// 而是经 web-bridge.js（localhost 页面的 content script）投一条 __careerExt:nav 进来，
// 这里用 router.push 做客户端跳转——不刷新页面，正在编辑的 CV 草稿、pipeline 筛选与
// 滚动位置都留着。跳转后回 __careerExt:nav-ack，扩展据此知道有人接：收不到 ack 的
// web 端（旧版本 / 尚未 hydrate）会由扩展回退成整页导航，功能不会因此消失。
//
// 只认 /report/{数字}：窗口消息对页面内任何脚本可见，路由目标必须白名单化——Next 文档
// 也明确禁止把未消毒的 URL 交给 router.push（javascript: 之类会在本页上下文执行）。
const NAV_TAG = "__careerExt:nav";
const NAV_ACK_TAG = "__careerExt:nav-ack";
const REPORT_PATH_RE = /^\/report\/[0-9]{1,6}$/;

/** 挂在根 layout：徽章可能在任何页面被点击，监听器必须在全局。 */
export function ExtNavBridge() {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data as { tag?: unknown; id?: unknown; path?: unknown } | null;
      if (!d || d.tag !== NAV_TAG || typeof d.path !== "string") return;
      // 不认识的目标不应答：让扩展走整页导航回退，去它自己拼好的那个 URL。
      if (!REPORT_PATH_RE.test(d.path)) return;
      // 已经在目标报告上就不 push——省一次多余的历史记录（扩展侧通常已幂等，
      // 这里只是兜住「页面自己先跳过去」的竞态）。
      if (d.path !== pathnameRef.current) router.push(d.path);
      window.postMessage({ tag: NAV_ACK_TAG, id: d.id, ok: true }, "*");
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [router]);

  return null;
}