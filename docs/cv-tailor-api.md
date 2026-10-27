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
| `n` | string/number | 是 | tracker 报告号（`data/applications.md` 的 `#` 列）。必须为纯数字。 |
| `replace` | boolean | 否 | 严格 `true` 才生效：同编号有在跑生成时，先停掉旧的再重开一个。非严格真值（`1`/`"true"`/`{}` 等）一律按缺省处理，不放行杀进程。 |

## 响应

请求**秒回**，不同步等待生成完成；后续进度经事件总线广播。

| 状态码 | body | 含义 |
|--------|------|------|
| 200 | `{ ok: true, runId, company, role }` | 已派发 worker，`runId` 用于订阅事件总线。 |
| 200 | `{ ok: true, replaced: [runId…], runId, company, role }` | `replace:true` 路径：旧在跑已停、新任务已起。若任一旧任务等待退出超时，附 `unconfirmed: true`（放行了但不确定旧进程是否真死）。 |
| 400 | `{ error: "missing-jd" }` | 该行无可定制的 JD/报告（`jds/` 无归档正文且报告正文缺失/过短）。 |
| 400 | `{ error: "bad json" \| "a numeric application number is required" }` | 请求体非 JSON，或 `n` 非纯数字。 |
| 404 | `{ error: "row-not-found" }` | tracker 里没有这个编号的行。 |
| 409 | `{ running: [{ runId, state, startedAt }…], company, role }` | 同编号已有生成在跑。`state` 为 `queued`（排队中）或 `running`（执行中）。拿 `runId` 可轮询，或 `POST /api/run/cancel {runId}` 取消；确认后带 `replace:true` 重发即替换。 |

## 进度与终态

事件走 `GET /api/events`（ADR-0020 多路复用总线），按 `runId` 过滤：

- 阶段事件（粗阶段徽章，`phase:` 前缀）：`phase:queued` → `phase:running`（建产物目录）→
  `phase:tailoring`（LLM 定制）→ `phase:finalizing:render`（渲染 PDF + 登记）。
- 终态唯一：`done`（成功）或 `error`（`msg` 形如 `"tailor: openai-tailor failed (check OPENAI_API_KEY / endpoint): …"`）。

## 产物

成功后：

- 定制 HTML/PDF 落 `output/<reportNum>-<company-slug>-<role-slug>/cv/tailored/vNNN/`（`cv.html` / `cv.pdf`）。
- `generate-pdf.mjs --report=N` 把 report→pdf 写入 `data/pdf-index.tsv`，于是
  `GET /api/cv-pdf?report=N` 精确命中该 PDF（中文公司名亦可靠）。

## 前置条件

- 运行环境需具备 OpenAI 兼容端点凭据（`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL`，见 `.env`）；缺失时 worker 在 tailor 阶段以 ERROR 终态上报，不产生半成品。
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
