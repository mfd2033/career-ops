import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readApplications, readInbox } from "@/lib/career-ops";
import { getNormalizeTextKey } from "@/lib/core/text-key";
import type { DiscoveredOffer } from "@/lib/explore";
import { collectWhatsNew, resolveOfferLimit } from "@/lib/whats-new.mjs";
import { normalizeUrl, rowToOfferOrNull } from "@/lib/whats-new-filter.mjs";
import { buildTitleFilterExplained } from "@/lib/core/title-keywords.mjs";
import * as yaml from "js-yaml";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The SUPPLY loop, ZERO tokens: "new matches this week" = roles surfaced by past
// free scans (data/scan-history.tsv) in the last N days that the user hasn't
// evaluated yet. No scan runs here — it reads the history a past scan already
// wrote, so the home stays instant + free (directly answers the #1 token-cost
// complaint). cols: url, first_seen, portal, title, company, status, location,
// …, salary (append-only col 13 — read back into the offer's salaryText so a
// fresh browser match shows comp on the card).
//
// 标题门（与探索页同一份判定）：台账行的 status 只记采集当时的门判（浏览器路
// 被毙的行落为 skipped_title），但词表是活的——用户在规则弹窗里改了
// portals.yml 的 title_filter 后，旧扫描里放行的行就成了当前词表下的该毙行。
// 所以这里用**当前**词表编译门（buildTitleFilterExplained，与探索页结果区和两
// 路采集 driver 同一份实现），在 rowToOfferOrNull 里重判每一条：被毙的岗位不
// 进今日页「本周新匹配」，count 同步真实——探索页 view=fresh 同读这个接口，
// 两张页面的口径由同一份编译保证一致。portals.yml 缺失/损坏 → 门关（全部放
// 行），与「空 positive 是无约束」的口径一致，绝不因配置问题清空整个回路。
// Company matching keys come from the CORE (see lib/core/text-key.ts), never a
// local reimplementation. The previous ASCII-only key deleted every non-Latin
// letter, so "Škoda" collided with "Koda" — suppressing a real offer as
// "already evaluated" — and "日本電産" keyed to the empty string (#2666).

export async function GET(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const days = Math.min(30, Math.max(1, Number(searchParams.get("days")) || 7));
  // Home only needs enough offers for its cards; Explore's “See all” hand-off
  // asks for more. Both stay finite — `count` is always complete, so the true
  // total is free while the rendered list keeps a ceiling (see MAX_OFFER_LIMIT).
  const offerLimit = resolveOfferLimit(searchParams.get("limit"));
  const cutoff = Date.now() - days * 86_400_000;
  let rows: string[];
  try {
    rows = fs.readFileSync(path.join(careerOpsRoot(), "data", "scan-history.tsv"), "utf8").split("\n");
  } catch {
    return Response.json({ offers: [], count: 0 });
  }

  // Already-evaluated postings → don't resurface as "new". Keyed TWO ways so
  // neither gap leaks: by company (a scan row with a company name matches a
  // tracker row whose URL column is absent) and by URL (a scan row with an
  // empty company column — browser-mode boards like 智联/BOSS record no
  // company — still matches the tracker row for the exact posting). Both sides
  // go through the same canonical key (normalizeTextKey / normalizeUrl), so
  // name case/punct and scheme/host/trailing-slash drift cannot hide an
  // evaluated posting. NOTE: normalizeUrl strips only campaign params (utm_*,
  // gh_src, …); a posting URL that grew a non-campaign param (e.g. zhipin's
  // securityId=…) after evaluation keys differently and is only caught by the
  // company dimension — acceptable, since browser-board rows carry no company
  // and their scan URL is the clean base link recorded at discovery time.
  //
  // Already-pending postings → ALSO don't resurface. A browser-mode scan
  // writes the same discovery to both scan-history.tsv (a "first seen this
  // week" row) and pipeline.md (a pending `- [ ]` inbox row), so without this
  // third dimension the supply loop re-offers postings the user already
  // queued — "已在管道中" cards under "本周新匹配" (#pipeline-leak). Done
  // inbox rows are excluded here: a processed posting is handled by the
  // evaluated dimensions above, not by this one.
  const normalizeTextKey = await getNormalizeTextKey();
  const norm = (s: string) => normalizeTextKey(s, " ");
  const apps = readApplications();
  const evaluated = new Set(apps.map((a) => norm(a.company)).filter(Boolean));
  const evaluatedUrls = new Set(apps.map((a) => normalizeUrl(a.url)).filter(Boolean));
  const pipelineUrls = new Set(readInbox().filter((j) => !j.done).map((j) => normalizeUrl(j.url)).filter(Boolean));
  // 当前词表 → 编译门。读不到 portals.yml（不存在/坏 YAML）时 titleFilter 保持
  // undefined，门不编译——「没配置」是合法状态，不能让今日页清零。
  let titleFilter: { positive?: unknown; negative?: unknown } | undefined;
  try {
    const doc = yaml.load(fs.readFileSync(path.join(careerOpsRoot(), "portals.yml"), "utf8")) as
      | { title_filter?: { positive?: unknown; negative?: unknown } }
      | null;
    titleFilter = doc?.title_filter;
  } catch {
    /* portals 缺失或坏：门关，回路照常返回全部未处置行 */
  }
  const titleGate = titleFilter ? buildTitleFilterExplained(titleFilter) : null;
  // rowToOfferOrNull is a plain .mjs export (no type annotations) whose return
  // shape is exactly DiscoveredOffer — the tracked fields line up 1:1.
  const toOffer = (c: string[]): DiscoveredOffer | null =>
    rowToOfferOrNull({ norm, evaluated, evaluatedUrls, pipelineUrls, titleGate }, c) as DiscoveredOffer | null;

  const { offers, count } = collectWhatsNew(rows, { cutoff, toOffer, offerLimit });
  return Response.json({ offers, count });
}
