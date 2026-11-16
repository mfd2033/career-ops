"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

// 数据变更桥（ADR-0101）：把 job-store 转发的 `co-data-changed` 窗口事件变成一次
// `router.refresh()`，让所有已打开的页面在别人写完 tracker 后（扩展改状态、另一
// 个标签页增删行）自动重取真值。挂全局（app-shell），自身不渲染任何节点、不持有
// 任何连接——连接是 job-store 那条 /api/events。
//
// 防抖 400ms：一次写入往往伴随好几条帧（status + tracker-add 等），且发起方自己
// 已经刷新过一次；窗口内的多条合并成一次重渲染，避免同批写入刷好几遍。
//
// 刷新是整体重取，不做局部打补丁：帧里只有 scope，没有行号——客户端不装配第二份
// tracker，页面拿到的永远是 `applications.md` 的当前内容（ADR-0101 被拒方案）。
const REFRESH_DEBOUNCE_MS = 400;

export function DataFreshnessBridge() {
  const router = useRouter();
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const onChanged = () => {
      // 已有定时器在飞：本次事件并入同一次刷新，不重排（保持最早的触发时刻）。
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        router.refresh();
      }, REFRESH_DEBOUNCE_MS);
    };
    window.addEventListener("co-data-changed", onChanged);
    return () => {
      window.removeEventListener("co-data-changed", onChanged);
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [router]);

  return null;
}
