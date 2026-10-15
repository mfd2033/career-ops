# ADR-0076: 扁平定制简历文件名改为 ≤20 字符的「cv-{报告号}-{职位}」短名

## 状态

Accepted (2026-10-15)

## 背景

需求（2026-10-15）：扁平布局的定制简历文件名太长——`output/cv-{候选人}-{公司}-{日期}.pdf`（如 `cv-jane-doe-globex-2026-06-05.pdf`，动辄 30+ 字符），要求改成「20 个字符以内，包含职位名和报告号」。当天一轮 grill（6 问）拍定全部边界，本文是收敛结果。

既有事实与约束（grill 前核对过）：

1. **两条写入路径、同一约定**：web 后端 `resolvePdfPaths()`（`web/src/lib/pdf-paths.mjs`）自动拼名，agent 不给文件名（#2172/#2185）；CLI/batch 由 `modes/pdf.md` Step 18/21 与 `batch/batch-prompt.md` 指引 agent 给 `generate-pdf.mjs` 传同样的扁平路径。bundle 布局（`cv/tailored/vNNN/cv.pdf`）不是本约定。
2. **解析已与文件名解耦**：web `resolveCvPdf` 先按报告号查 `data/pdf-index.tsv`（权威），公司 slug 模糊回退只服务无号/旧文件；Go TUI `PDFManifest.Lookup` 同口径，`d`/`D` 重生成直接用清单里记录的路径（`dashboard/main.go` `runGeneratePDF`）。直接读名字形状的只有：Go 查看器正则 `reRelPDFPath`（把 `output/cv-*.pdf` 链接化）与 web 公司 slug 回退。
3. **报告号是唯一键**：`pdf-index.tsv`、`mark-pdf-ready.mjs`、`merge-tracker.mjs`、dashboard 全按号解析；同一报告重生成 → 同名覆盖，是期望行为。
4. **公司名不可靠**：中文公司名 slug 后为空（历史缺陷 `cv--…` 双破折号），公司本就不适合作为短名成分；职位名（tracker Role 列）才是稳定可读段。

## 决策

1. **格式**：扁平 PDF = `cv-{报告号}-{职位}.pdf`。报告号取报告链接的号原样（`042`/`1080`，不补零不改宽）；职位取 tracker 行的 Role 列原值（CLI 侧同源为报告标题 `—` 后段，二者不一致以 tracker 为准）；Role 为空 → `cv-{报告号}.pdf`。
2. **长度口径**：整个文件名含 `.pdf` ≤ 20 字符（Unicode 码点，汉字算 1）；`cv-` 前缀、分隔符、`.pdf` 都占额度。CLI 扁平布局的伴生 HTML 用同基名（`cv-{报告号}-{职位}.html`）；web 运行的 HTML 是 scratch（`.career-ops-web/pdf-tmp/cv-web-{号}.html`，渲染后即删，只进 pdf-index 的 html 列），不受本规则约束。
3. **职位归一**：NFKC → 整段丢弃括号注记（全/半角括号段）→ 小写 → 非字母/数字连续段转 `-` → 去首尾 `-`；汉字及其他文字保留原文。
4. **超限收缩**：从尾部逐词（`-` 分段）丢弃；只剩一段仍超 → 段内按码点硬截断。
5. **无报告号的一次性 CV**：短名严格绑定报告号；`generate-pdf.mjs` 无 `--report` 时（CLI one-off）整套保持旧格式（`output/cv-{候选人}-{公司}-{日期}.pdf` 与伴生 `output/cv-{候选人}-{公司}.html`）。
6. **作用域**：web 后端 + `modes/pdf.md`（CLI/batch 指引）+ 扁平伴生 HTML；bundle 布局与 LaTeX（`modes/latex*.md`）/Canva 旁路不动。
7. **存量文件一律不动**：旧格式文件继续由公司 slug 回退服务；新文件靠报告号索引解析。`cv-` 前缀刻意保留——Go 查看器正则 `output/cv-…\.pdf` 与旧回退都不必改。
8. **双写入口同规**：JS 实现（`cvShortStem`）与 `modes/pdf.md` 的算法描述必须同规，由单测 + test-all 文档断言门住。

## 被拒方案

- **`{报告号}-{职位}.pdf`（去 `cv-` 前缀）**：Go 查看器正则失配；`output/` 与求职信 PDF 同目录时失去家族标识。
- **`{职位}-{报告号}.pdf`**：前缀问题同上；目录排序不按号。
- **20 不含扩展名 / 只约束「号-职位」段**：口径松，磁盘上的真实长度仍会到 24–27。
- **缩写词典（Senior→sr、Engineer→eng…）**：多一张要维护的词典；丢词 + 硬截断已确定性收敛。
- **无号降级用 `cv-{职位}.pdf` / `cv-{职位}-{MMDD}.pdf`**：同一职位不同公司会静默互相覆盖。
- **存量批量改名**：数据层批量操作（须先 `local\backup-data.cmd` 并同步 pdf-index 与报告头 `**PDF:**`），收益只是目录观感，风险不成比例。
- **把公司 slug 回退整体下线**：无报告的旧 CV 会失联；回退只服务旧文件，无害。
- **LaTeX/Canva 一并统一**：它们无报告号关联，会引入第二套降级规则；另案。

## 后果

- 正面：扁平 PDF 名一眼可读可辨（号 + 职位）；解析路径零改动（报告号索引权威）；Go 查看器与旧回退保持兼容；web 命名逻辑顺带去掉了 profile.yml 读取与公司 slug 解析两段死代码。
- 代价一：职位名被迫收缩（英文长职位尤甚），信息量从文件名转由「号 → pdf-index」承载。
- 代价二：命名规则此后有 JS 实现与 `modes/pdf.md` 文档两份——必须同规，靠单测与文档断言门住。
- 已知边界：旧文件与无号 CV 仍是长名（刻意）；≤20 依赖报告号 ≤6 位（现实上限 4 位）。
- 回滚：单点纯函数 + 一处调用 + 文档；旧名回归即恢复。

## References

- 双写路径与后端命名：#2172、#2185；`web/src/lib/pdf-paths.mjs`、`web/src/app/api/run/route.ts`、`web/src/components/generate-pdf-button.tsx`
- 报告号索引与解析：`data/pdf-index.tsv`、`web/src/lib/cv-pdf-resolve.mjs`、`dashboard/internal/data/pdf.go`（`ResolvePDFs` 优先级）
- Go 查看器与重生成：`dashboard/internal/ui/screens/viewer.go`（`reRelPDFPath`）、`dashboard/main.go`（`runGeneratePDF` 用清单记录路径）
- CLI 指引：`modes/pdf.md` Step 18/21、`batch/batch-prompt.md`
- 术语：`GLOSSARY.md` 新增「简历短名」
- 工单：`.scratch/cv-short-filename/issues/01–04`
