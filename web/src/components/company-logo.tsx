"use client";

import { useEffect, useState } from "react";
import { companyInitials, monogramHue } from "@/lib/company";
import { cn } from "@/lib/cn";

const CONFIG_KEY = "career-ops:config";

// A small company mark: a logo image on a white tile when one is available,
// otherwise a deterministic colored monogram. The monogram is the always-rendered
// base layer (SSR-safe + offline floor); the image fades in on top once loaded,
// and any failure (404/disabled) just leaves the monogram showing.
//
// fork-local（2026-11-12）：/api/logo 已不再外呼，只读磁盘缓存。因此按公司名取图
// 这条路默认关闭 —— 中文雇主名基本没有可猜的域名，开着只会每张卡换一个 404 和一条
// 控制台报错。传了 `src`（本地打包的门户 logo）不受这个开关影响，永远显示。
export function CompanyLogo({
  name,
  src,
  size = 20,
  className,
  imgPadding,
  bareTile,
}: {
  name: string;
  // 直接指定图片地址（如本地打包的招聘门户 logo /portals/x.png），绕过 /api/logo 的
  // 远程抓取；离线可用、零网络。未提供时仍按 name 走 /api/logo?company= 解析。
  src?: string;
  size?: number;
  className?: string;
  // logo <img> 在瓦片内的内边距。默认约 size*0.1（给方形 logo 留白呼吸）；
  // 传 0 可让 logo 铺满整个圆角瓦片（如需「充满空间」的场景）。
  imgPadding?: number;
  // true 时去掉 logo 背后的白色垫子，透明处透出卡片底色（避免品牌色块 logo 四周
  // 露出一圈白）；同时在真实 logo 加载后淡出字母兜底，避免彩色兜底从透明
  // 处透出。仅适合自带满版色块的品牌 logo（如招聘门户），普通白底公司 logo 不适用。
  bareTile?: boolean;
}) {
  const [enabled, setEnabled] = useState(false); // monogram-only until config known
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      const v = raw ? JSON.parse(raw) : null;
      // 默认关：按名查图不再外呼，开着只是多问一次本地缓存、多一条 404。
      setEnabled(v?.logos === true);
    } catch {
      setEnabled(false);
    }
  }, []);

  const hue = monogramHue(name);
  const radius = Math.max(4, Math.round(size * 0.28));
  // 调用方给了明确地址（本地打包的门户 logo）就直接用，不受开关限制；
  // 否则按名字走 /api/logo 的本地缓存。任一失败都留着字母组合。
  const logoSrc = src ?? `/api/logo?company=${encodeURIComponent(name)}`;
  const showImg = !failed && (!!src || (enabled && !!name?.trim()));

  return (
    <span
      className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-black/5 dark:ring-white/10", className)}
      style={{ width: size, height: size, borderRadius: radius }}
      aria-hidden="true"
    >
      <span
        className="absolute inset-0 flex items-center justify-center font-semibold leading-none text-white"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 55% 48%), hsl(${(hue + 28) % 360} 52% 38%))`,
          fontSize: Math.round(size * 0.42),
          letterSpacing: "-0.02em",
          opacity: bareTile && loaded ? 0 : 1,
          transition: "opacity 200ms",
        }}
      >
        {companyInitials(name)}
      </span>
      {showImg && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoSrc}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn("absolute inset-0 h-full w-full object-contain transition-opacity duration-200", bareTile ? "bg-transparent" : "bg-white")}
          style={{ opacity: loaded ? 1 : 0, padding: imgPadding ?? Math.max(1, Math.round(size * 0.1)) }}
        />
      )}
    </span>
  );
}
