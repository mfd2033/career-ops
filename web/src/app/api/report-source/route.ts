// GET /api/report-source?n=<报告号> — 把评估报告的 markdown 原文只读吐给扩展
// （ADR-0074：详情页的「读报告」改页内弹窗，正文要跨 origin 取回来）。
//
// 三条边界，动一条就不是这个端点了：
//   • 只读。不写盘、不改 tracker、不触发任何流程；GET + 数字参数，没有 body。
//   • 路径校验全部复用 readReport → findReportFile：报告链接包含校验
//     （containedRealpath）与 `{n}-RESERVED.md` 占位哨兵跳过都在那里，这里绝不
//     自己拼路径 —— 自己拼一次就等于把两道防护各绕开一次。
//   • 返回 text/markdown 而不是 JSON。正文本身就是要渲染的数据，包一层 JSON 只是
//     让消费方多做一次解码；扩展侧拿到的是纯文本，转义与渲染在它自己的沙箱里做。
//
// 与 /report/{n}（web 前端的渲染页）并存：那条给人看完整页（弹窗标题栏的「在 web
// 端打开」次要出口走它），这条给扩展取原文。两者都只读同一份报告文件。
import { readReport } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const n = new URL(req.url).searchParams.get("n") ?? "";
  if (!/^\d+$/.test(n)) {
    return Response.json({ error: "a numeric report number is required" }, { status: 400 });
  }
  const report = readReport(n);
  if (!report) {
    // 404 的两种成因（没有这一号 / 报告文件缺失或读失败）在只读端点上不需要区分：
    // 对扩展而言都是「这份报告现在读不出来」，文案由扩展侧统一给。
    return Response.json({ error: "no readable report for this number" }, { status: 404 });
  }
  return new Response(report.content, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // 报告随时会被重新评估覆盖，缓存一个旧正文比多读一次盘更糟。
      "cache-control": "no-store",
    },
  });
}
