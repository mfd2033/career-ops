import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveLogoKey } from "@/lib/core/logo-cache-key.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 本地 logo 缓存读取器。**不向任何第三方发请求。**
//
// 曾经这里按公司名猜域名、去 Google favicon 服务抓图，成功与失败都落盘一次且永不
// 重试（失败写 0 字节哨兵）。代价在离线/被墙的机器上最刺眼：抓取失败同样是「永久
// miss」，40/45 个缓存 key 在几秒内被写死，之后网络恢复也不会再看一眼；同时每张没有
// logo 的公司卡都会在控制台留一条 resource-load-error。
//
// fork-local 决策（2026-11-12）：这个 fork 面向中文招聘，雇主名基本没有可猜的 ASCII
// 域名，外呼本身也换不来 logo。路由因此收窄为纯读缓存：命中就返回图片，否则 404，
// 客户端回落彩色字母组合（components/company-logo.tsx，默认连请求都不发）。
// 参数 → key 的判定全在 lib/core/logo-cache-key 的纯函数里，有测试兜住。
//
// 缓存文件里的 0 字节哨兵是历史遗留的「已知 miss」，与 404 同义，不再新写。

/** 404 也带缓存头：否则浏览器把 404 当不可缓存，每次进页面都把同一批死 logo 再问一遍。
 *  客户端 <img onError> 的字母兜底不受影响 —— 命中缓存的 404 依然会触发 error。 */
const NO_LOGO_HEADERS = { "Cache-Control": "public, max-age=604800" };

const noLogo = () => new Response("no logo", { status: 404, headers: NO_LOGO_HEADERS });

function cacheDir(): string {
  return path.join(careerOpsRoot(), ".career-ops-web", "logo-cache");
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const resolved = resolveLogoKey({ domain: sp.get("domain"), company: sp.get("company") });

  if (resolved.status === "bad-domain") return new Response("bad domain", { status: 400 });
  if (resolved.status === "bad-request") return new Response("need domain or company", { status: 400 });
  if (resolved.status === "not-found") return noLogo();

  // key 已由纯函数保证是安全文件名，这里再强制一次包含关系（纵深防御）：
  // 缓存路径永远不能解析到缓存目录之外。
  const root = path.resolve(cacheDir());
  const file = path.resolve(root, `${resolved.key}.png`);
  if (!file.startsWith(root + path.sep)) return new Response("bad key", { status: 400 });

  try {
    const buf = await fs.readFile(file);
    if (buf.byteLength > 0) {
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" },
      });
    }
  } catch {
    /* 未缓存 → 统一落到下面的 404 */
  }
  return noLogo();
}
