import type { Metadata } from "next";
import { MethodologyDoc } from "@/components/methodology-doc";

// 评分方法论全文页。挂在根布局的 AppShell 里（自带侧栏），但不进 NAV_ITEMS：
// 它是报告的附属说明，唯一入口是报告页折叠区里的「完整方法论」。
export const metadata: Metadata = {
  title: "career-ops — scoring methodology",
};

export default function MethodologyPage() {
  return <MethodologyDoc />;
}
