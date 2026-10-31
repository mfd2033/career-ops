import fs from "node:fs";
import { ExplorerView, type EvaluationRow } from "@/components/explore/explorer-view";
import { seedExploreFilters } from "@/lib/core/portals";
import { readInbox, readApplications, readTagVocab, careerOpsRoot } from "@/lib/career-ops";
import { DEFAULT_FILTERS } from "@/lib/explore";

// Read live data at request time so a bare checkout (or `next build` with no
// CAREER_OPS_ROOT) never fails — discovery seeds are best-effort.
export const dynamic = "force-dynamic";

export default function ExplorePage() {
  let seed: { filters: typeof DEFAULT_FILTERS; seededFrom: string[] } = { filters: DEFAULT_FILTERS, seededFrom: [] };
  try {
    seed = seedExploreFilters();
  } catch {
    /* bare checkout → defaults */
  }
  let rootExists = false;
  try {
    rootExists = fs.existsSync(careerOpsRoot());
  } catch {
    /* ignore */
  }
  // 结果标签的词典（与收件箱关键词条同一份词表，ADR-0068 决议 2）：服务端装配、
  // 客户端匹配。裸 checkout 或读盘失败 → 空词表，标签条整条不渲染。
  let tagVocab: { vocab: string[]; exclude: string[] } = { vocab: [], exclude: [] };
  try {
    tagVocab = readTagVocab();
  } catch {
    /* 词表不可用：结果区不带标签 */
  }
  // 客户端只需要两样东西来富化结果集：收件箱的 URL 集合，和追踪表的 n/公司/岗位/URL
  // （见 ExplorerView 的 enriched memo）。此前整份 Application/InboxJob 都进了 RSC 载荷，
  // 743 行追踪表的 notes/report/score 等字段把 /explore 的 HTML 顶到 ~460KB——刷新时
  // 浏览器要先下载、解析这块对页面毫无作用的数据。这里只投影需要的列。
  let inboxUrls: string[] = [];
  let appsSnapshot: EvaluationRow[] = [];
  try {
    inboxUrls = readInbox().map((j) => j.url);
  } catch {
    /* 裸 checkout：空收件箱 */
  }
  try {
    appsSnapshot = readApplications().map(({ n, company, role, url }) => ({ n, company, role, url }));
  } catch {
    /* 裸 checkout：空追踪表 */
  }
  return (
    <ExplorerView seed={seed} inboxUrls={inboxUrls} appsSnapshot={appsSnapshot} rootExists={rootExists} tagVocab={tagVocab} />
  );
}
