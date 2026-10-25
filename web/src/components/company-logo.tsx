"use client";

import { useEffect, useState } from "react";
import { companyInitials, monogramHue } from "@/lib/company";
import { cn } from "@/lib/cn";

const CONFIG_KEY = "career-ops:config";

// A small company mark: the real favicon on a white tile when logos are enabled
// and resolvable, otherwise a deterministic colored monogram. The monogram is
// the always-rendered base layer (SSR-safe + offline floor); the logo fades in
// on top once loaded, and any failure (404/offline/disabled) just leaves the
// monogram showing. See lib/company.ts + /api/logo.
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
      setEnabled(v?.logos !== false); // default ON unless explicitly disabled
    } catch {
      setEnabled(true);
    }
  }, []);

  const hue = monogramHue(name);
  const radius = Math.max(4, Math.round(size * 0.28));
  // Use a caller-supplied image directly (bundled portal logos) when given; otherwise
  // resolve by NAME via /api/logo. Either way a failure leaves the monogram showing.
  const logoSrc = src ?? `/api/logo?company=${encodeURIComponent(name)}`;
  const showImg = enabled && !failed && (!!src || !!name?.trim());

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
