"use client";

import { useEffect, useRef, useState } from "react";
import { checkupReportHref, checkupReportNum } from "@/lib/checkup-report-link.mjs";

// 工作器体检卡的报告入口：先按 run 自身判定号（纯函数），再问服务端这份 HTML
// 是否真的存在（HEAD /api/checkup-report）。
//
// 为什么不复用 /api/report-status 或台账行：那两个索引带的是 star 与报告号，
// 都不含「html 列是否指向一个真实文件」；体检台账的 html 列才是唯一事实源，而
// 它只在服务端可读。走同一路由的 HEAD 判断，等于沿用该路由既有的前缀与越界
// 校验，不另造一套存在性规则。
//
// 结果按 URL 缓存在模块级：N 张卡共用一次请求。worker 收尾（co-job-done）时
// 失效重探——体检 HTML 正是在 run 结束时才落盘，挂载那一刻必然还不存在。
// 首次探测失败后再等一拍重试一次，盖住「done 事件先于文件写完」的窄窗口；
// 仍失败就认「没有报告」，不做无限轮询。
const cache = new Map<string, Promise<boolean>>();
const RETRY_MS = 2000;
const MAX_RETRIES = 1;

function probe(url: string): Promise<boolean> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url, { method: "HEAD", cache: "no-store" })
      .then((r) => r.ok)
      .catch(() => false);
    cache.set(url, p);
  }
  return p;
}

export function useCheckupReport(job: {
  kind?: string;
  input?: string;
  status?: string;
} | null): { num: string; href: string } | null {
  const num = checkupReportNum(job);
  const href = num ? checkupReportHref(num) : null;
  const [available, setAvailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const retries = useRef(0);

  useEffect(() => {
    if (!href) {
      setAvailable(false);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    retries.current = 0;
    setAvailable(false);
    const attempt = () => {
      probe(href).then((found) => {
        if (!live) return;
        if (found) {
          setAvailable(true);
          return;
        }
        if (retries.current < MAX_RETRIES) {
          retries.current += 1;
          // 重探必须绕过缓存：缓存里存的是「刚才不存在」。
          cache.delete(href);
          timer = setTimeout(attempt, RETRY_MS);
        }
      });
    };
    attempt();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [href, revision]);

  useEffect(() => {
    const onSettled = () => {
      if (href) cache.delete(href);
      setRevision((r) => r + 1);
    };
    window.addEventListener("co-job-done", onSettled);
    return () => window.removeEventListener("co-job-done", onSettled);
  }, [href]);

  return num && href && available ? { num, href } : null;
}