import fs from "node:fs";
import path from "node:path";
import {
  careerOpsRoot,
  readApplications,
  readReportUrl,
  resolveReportPathFor,
  withCheckupStars,
} from "@/lib/career-ops";
import { reportFileIndex } from "@/lib/report-files.mjs";
import { buildReportStatusMap } from "@/lib/report-status-map.mjs";
import { createReportStatusStore } from "@/lib/report-status-store.mjs";
import { normalizeUrl } from "@/lib/core/url-key.mjs";

// Evaluated-position status for the BOSS直聘 extension. On load the extension
// fetches this once and builds its local Set of "already evaluated" badges.
//
// Returns the durable evaluated map over every tracker application that
// resolves to a real posting URL: key = normalizeUrl(URL) — the SAME canonical
// key the explore/inbox pages use, so a posting the extension sees is never
// mislabelled "unevaluated" (and one evaluated elsewhere is never missed).
//   { normalizedUrl: { score: string, reportNum: string, status?: string, checkupStar: number|null } }
// `reportNum` is the tracker application number `n`, also the /report/{n} route.
// `status` (ADR-0074) is the tracker row's RAW canonical state code (`Applied`,
// `SKIP`, … — templates/states.yml): the API carries no display language, the
// extension maps it to a Chinese label + lifecycle colour in its own dictionary.
// `checkupStar` (ADR-0074) is that row's latest company-checkup star, joined with
// the SAME `withCheckupStars` the pipeline list uses (one "latest" definition, no
// drift): display-only, never a scoring/filter/gate input (ADR-0064). null = 未体检.
// Assembly rules (first-app-wins, key normalisation) live in the pure
// report-status-map.mjs so they can be tested without a route.
//
// ADR-0098: the "read 816 reports and pull `**URL:**` out of each" walk now goes
// through report-status-store.mjs — tracker rows, the `reports/` listing and each
// report's URL are cached by file signature, and the reads are async. Before this
// the whole walk was synchronous (~850ms), so this route was the single biggest
// stall on the event loop; three concurrent requests serialised into 1–2.8s and
// took `/api/version` (the tray/extension probe) down with them.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** mtime+size 签名；文件缺失按「空」计（fresh checkout 也要能答）。 */
async function fileStamp(abs: string): Promise<string> {
  try {
    const st = await fs.promises.stat(abs);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

const store = createReportStatusStore({
  // 行的变化 = applications.md（谁被评估过）或体检台账（checkupStar）变了。
  appsSignature: async () => {
    const root = careerOpsRoot();
    const [apps, checkups] = await Promise.all([
      fileStamp(path.join(root, "data", "applications.md")),
      fileStamp(path.join(root, "data", "company-checkups.tsv")),
    ]);
    return `${apps}|${checkups}`;
  },
  listReports: async () => {
    try {
      return await fs.promises.readdir(path.join(careerOpsRoot(), "reports"));
    } catch {
      return []; // 无 reports/ 目录（数据仓与脚本分离）→ 空索引，不是错误
    }
  },
  numberIndex: reportFileIndex,
  reportPathOf: resolveReportPathFor,
  statFile: async (file) => {
    try {
      const st = await fs.promises.stat(file);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  },
  readUrl: readReportUrl,
  loadApps: async () => withCheckupStars(readApplications()),
  buildMap: (apps, urlByNum) =>
    buildReportStatusMap(apps, { urlOf: (app: { n: string }) => urlByNum[app.n], normalizeUrl }),
});

export async function GET() {
  return Response.json(await store.get());
}
