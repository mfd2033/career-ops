import fs from "node:fs";
import { ExplorerView } from "@/components/explore/explorer-view";
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
  return (
    <ExplorerView seed={seed} inboxSnapshot={readInbox()} appsSnapshot={readApplications()} rootExists={rootExists} tagVocab={tagVocab} />
  );
}
