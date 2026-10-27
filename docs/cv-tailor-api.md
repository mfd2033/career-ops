# POST /api/cv-tailor — 定制简历生成（agent 可调用，无 UI）

> **agent 可调用，无 UI**：这是一个纯后端 HTTP 触发器，供 agent / 脚本直接调用，把某一
> tracker 行的定制简历离线生成并登记。没有前端按钮，也不产生任何前端产物。决策见
> [ADR-0090](adr/0090-cv-tailor-http-endpoint.md)。

## 请求

```
POST /api/cv-tailor
Content-Type: application/json

{ "n": "<tracker行号>", "replace": true|false }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `n` | string/number | 是 | tracker 行号（`data/applications.md` 的 `#` 列）。必须为纯数字。注意行号 ≠ 评估报告号（re-eval 会把行改指向新报告，如行 1148 → 报告 1153），取产物请用应答里的 `reportNum`。 |
| `replace` | boolean | 否 | 严格 `true` 才生效：同编号有在跑生成时，先停掉旧的再重开一个。非严格真值（`1`/`"true"`/`{}` 等）一律按缺省处理，不放行杀进程。 |

## 响应

请求**秒回**，不同步等待生成完成；后续进度经事件总线广播。

| 状态码 | body | 含义 |
|--------|------|------|
| 200 | `{ ok: true, runId, company, role, reportNum }` | 已派发 worker；`runId` 用于订阅事件总线，`reportNum` 是真实评估报告号（取 PDF 用）。 |
| 200 | `{ ok: true, replaced: [runId…], runId, company, role, reportNum }` | `replace:true` 路径：旧在跑已停、新任务已起。若任一旧任务等待退出超时，附 `unconfirmed: true`（放行了但不确定旧进程是否真死）。 |
| 400 | `{ error: "missing-jd" }` | 该行无可定制的 JD/报告（`jds/` 无归档正文且报告正文缺失/过短）。 |
| 400 | `{ error: "no-tailor-credential", hint }` | 密钥库（配置页「AI 引擎」）里没有使用中的密钥束；不派发 worker，当场拒绝。 |
| 400 | `{ error: "bad json" \| "a numeric application number is required" }` | 请求体非 JSON，或 `n` 非纯数字。 |
| 404 | `{ error: "row-not-found" }` | tracker 里没有这个编号的行。 |
| 409 | `{ running: [{ runId, state, startedAt }…], company, role, reportNum }` | 同编号已有生成在跑。`state` 为 `queued`（排队中）或 `running`（执行中）。拿 `runId` 可轮询，或 `POST /api/run/cancel {runId}` 取消；确认后带 `replace:true` 重发即替换。 |

## 进度与终态

事件走 `GET /api/events`（ADR-0020 多路复用总线），按 `runId` 过滤：

- 阶段事件（粗阶段徽章，`phase:` 前缀）：`phase:queued` → `phase:running`（建产物目录）→
  `phase:tailoring`（LLM 定制）→ `phase:finalizing:render`（渲染 PDF + 登记）。
- 终态唯一：`done`（成功）或 `error`（`msg` 形如 `"tailor: openai-tailor failed (check OPENAI_API_KEY / endpoint): …"`）。

## 产物

成功后：

- 定制 HTML/PDF 落 `output/<reportNum>-<company-slug>-<role-slug>/cv/tailored/vNNN/`（`cv.html` / `cv.pdf`；中文公司名的 slug 可能是占位形状如 `1153-application-role`，不要自己拼路径，用下面的 API 取）。
- 渲染成功后 worker 会自动调 `mark-pdf-ready.mjs <reportNum>` 把 tracker 该行 PDF 列 ❌→✅
  （报告页的「已生成定制简历」状态即读自此格）；回写失败会以 `stage:mark` 的 ERROR 终态上报，
  不会静默留下「产物已生成但 UI 说没生成」的矛盾态。
- `generate-pdf.mjs --report=<reportNum>` 把 report→pdf 写入 `data/pdf-index.tsv`，于是
  `GET /api/cv-pdf?report=<reportNum>` 精确命中该 PDF（中文公司名亦可靠）。这里的参数是
  **应答体里的 `reportNum`（评估报告号），不是请求里的行号 `n`**（两者在 re-eval 后不同）。

## 前置条件

- 定制 LLM 调用使用 **ADR-0083 密钥库**（配置页「AI 引擎」区，落盘 `data/quick-eval.json`）中
  **使用中**的那把 OpenAI 兼容密钥束；派发时路由把其 key/baseUrl/model 注入 `openai-tailor.mjs`
  子进程的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` 环境变量（明文不进命令行、
  不进事件流、不进台账）。库里无可用密钥 → 当场 400 `no-tailor-credential`，不派必死的 worker。
  换端点/换模型：在配置页切换使用中密钥即可，无需重启。
- 该行须有评估报告（`openai-tailor.mjs` 硬要求 `--report`）。

## 调用示例

```bash
# 派发生成 #161 的定制简历
curl -s -X POST http://localhost:3000/api/cv-tailor \
  -H 'Content-Type: application/json' -d '{"n":"161"}'
# → {"ok":true,"runId":"…","company":"…","role":"…"}

# 替换在跑的那一个
curl -s -X POST http://localhost:3000/api/cv-tailor \
  -H 'Content-Type: application/json' -d '{"n":"161","replace":true}'

# 生成完成后按报告号取 PDF
curl -s http://localhost:3000/api/cv-pdf?report=161 -o cv.pdf
```
