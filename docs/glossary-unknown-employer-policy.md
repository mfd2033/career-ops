# Glossary — 未知雇主处理策略

与 ADR-0004 配套的术语表。收发音殊的名词与既定约定，供实现与评审对齐口径。

| 术语 | 英文/标识 | 定义 |
|------|-----------|------|
| 终端雇主 | end employer | 真正雇佣候选人的公司（招人方背后主体）。代招场景下它往往在 JD/BOSS 页面匿名，拿不到。 |
| 发帖方 / 代招公司 | posting party / agency | 代为发布职位的公司（如 BOSS 上显示的 FESCO河南）。始终公开可得；它不是雇主，只是中介。 |
| `?` sentinel | `?` | tracker `Company` 列的 locale-invariant 标记，表示「终端雇主未知」。可替代真实公司名，永不写 "Confidential"。 |
| 占位符档 | `placeholder` | 配置值 `unknownEmployer="placeholder"`：维持现状，终端雇主未知 → `?`。默认档。 |
| 代招名档 | `agency` | 配置值 `unknownEmployer="agency"`：发帖方可得时显示发帖公司名（+「代招」标注），否则退回 `?`。 |
| 未知雇主策略 | unknown-employer policy | 本 ADR 引入的 web 配置项，控制代招/隐藏雇主时公司名的表示。存于 `AppConfig` / localStorage `career-ops:config`。 |
| `confidential-{agency}` slug | slug | 报告文件名前缀约定（如 `097-confidential-fesco-henan`）。遵守「永不重命名报告文件」原则；切策略只改标题/header/YAML。 |
| `Via:` 字段 | Via | 报告 header 与 tracker TSV `via={Agency}` 中记录中间渠道（猎头/代招公司）的字段。 |
| 报告 `company:` | YAML company | 报告 Machine Summary 中的 `company` 键。现状未知终端雇主写「某大型公司」。 |
| `buildPrompt` | server prompt 组装 | `api/run` / `api/batch-evaluate` 拼装 worker prompt 的地方，是策略注入点（与 `withModelFlag` 注入 model 同机制）。 |
| `AppConfig` | AppConfig | `~/.career-ops-web/config.json` 持久化的 web 级配置，现含 `cliId/model`，本 ADR 扩展 `unknownEmployer`。 |
| 即时回退 | rendering fallback | web 端 `report-view.tsx` 对既有 `?` 行按当前策略即时改显示，不改底层数据（无迁移）。 |
| 快评 text | quick-eval text | `extension/content.js` `extractDetailJd` 传给 `/api/quick-eval` 的 JD 文本；「代招名档」下前缀追加发帖公司名。 |

## 既定约定（不随本 ADR 改变）

- `?` 语义与 `confidential` slug 派生规则保持原样。
- 报告文件一旦生成，永不重命名；只更新标题/header/YAML。
- 策略是运行时注入的偏好，禁止写入 `modes/oferta.md` 等系统层规则文件。