// 评分方法论全文——英文版（中文对等版见 methodology.zh.ts；双语不是直译关系，
// 两份都是对同一口径的重写，按 ADR-0072 决议 1）。
//
// 为什么是 .ts 字符串而不是 .md：Next 16.3 的 Turbopack 没有把 .md 读成文本的
// 可用机制（type:"text" 非法、type:"raw" 默认导出 undefined、raw-loader 不被支持），
// 见 docs/adr/0072-in-repo-methodology-doc.md。代价：正文里的反引号与 ${ 需要 \ 转义，
// 编辑时记得保留。渲染端仍是 markdown（react-markdown + remark-gfm）。
export const methodologyEn = `
# The full scoring methodology

This page explains one thing: why a role got the score it got, and what that score
should not be used for. It is more complete than the collapsed summary on the report
page, but the authoritative definitions live in \`modes/_shared.md\` (scoring dimensions)
and \`modes/oferta.md\` (report structure). This page describes them; it does not replace them.

## 1.0–5.0 and the 4.0 line

Every evaluation produces one global score between 1.0 and 5.0. The recommendation
tiers are fixed:

| Score | Recommendation |
|---|---|
| 4.5+ | Strong match — apply immediately |
| 4.0 – 4.4 | Good match — worth applying |
| 3.5 – 3.9 | Decent but not ideal — apply only with a specific reason |
| Below 3.5 | Recommend against applying |

4.0 is the apply / don't-apply line. 3.5–3.9 is an explicit override-only band: the
system says why it fell short, you make the call. This is not soft advice — it is
written into the score interpretation in \`modes/_shared.md\` and bound by the ethical-use
rules in AGENTS.md.

## Five scoring dimensions, plus the global score

| Dimension | What it measures | How it is derived |
|---|---|---|
| Match | Skills, experience, proof-point alignment | Each JD requirement is mapped against \`cv.md\` and \`article-digest.md\`, citing specific CV lines (Block B) |
| North Star alignment | How close the role is to your target archetypes | Archetype detected from the JD, compared against \`modes/_profile.md\` |
| Comp | Salary relative to market | Web search across Glassdoor / Levels.fyi / Blind; 5 = top quartile, 1 = well below market |
| Cultural signals | Culture, growth stage, stability, remote policy | Qualitative judgement on the JD plus targeted search; capped when evidence is missing |
| Red flags | Blockers, warnings, risk signals | Negative-only adjustments — surfaced even when everything else scores high |
| **Global** | Overall fit, drives the apply / don't recommendation | A holistic judgement integrating the five dimensions above, **with no arithmetic formula** |

The global score is not a sixth dimension; it is the integrated judgement of the five.
The in-app summary used to list it as a sixth one, which is exactly the drift this page
and the summary now remove.

## Why LLM judgement, not closed-form math

There is no weighted-average formula in the code. The global score is the model's
holistic judgement given the rubric and the five dimensions. That is deliberate, for
three reasons:

1. **JD context is heterogeneous.** "Comp" means something different at a seed-stage
   startup than at a hyperscaler. Static weights would over-fit one of them.
2. **Archetypes vary per person.** Personalisation through \`modes/_profile.md\` changes
   priorities; a fixed formula fights that.
3. **Honesty.** Pretending closed-form math when the engine underneath is a model is
   marketing, not transparency. We say it plainly: this is rubric-guided judgement, and
   two different models can produce slightly different scores on the same input.

The rubric is fully public (the tables above) and the judgement is auditable: every
score carries citations to specific CV lines and JD requirements. You can disagree,
and you can override.

## Report structure: A–H

A full single-role evaluation is organised in blocks, defined in \`modes/oferta.md\`:

| Block | What it produces |
|---|---|
| A — Role Summary | Table: archetype, domain, function, seniority, remote policy, team size, TL;DR. No score. |
| B — Match with CV | Reads \`cv.md\`, maps each JD requirement to specific CV lines, gaps come with mitigation, focus adapts to the detected archetype |
| C — Level and Strategy | Posted level vs your natural level; "sell senior without lying", including downlevelling plans |
| D — Comp and Demand | Web search with cited sources; if there is no data it says so and never invents numbers |
| E — Customization Plan | Top 5 CV changes and top 5 LinkedIn changes for this specific role |
| F — Interview Plan | 6–10 STAR+R stories mapped to the JD; the Reflection column is what signals seniority |
| G — Posting Legitimacy | Three-tier legitimacy check, independent of the 1–5 score; signals, never accusations |
| H — Draft Application Answers | Draft answers for the application form — **generated only when the global score is ≥ 4.5** |

Between G and H sits the Risk Summary (one row per risk signal); the report tail carries
machine-readable blocks such as Machine Summary and the extracted keywords.

**Two scoring systems, often confused.** This page describes \`oferta\`: one role, five
dimensions plus a holistic global score, no arithmetic. \`ofertas\` — comparing several
offers you already hold — uses a **ten-dimension weighted matrix with published
weights** (North Star 25%, CV match 15%, level 15%, comp 10%, growth 10%, the rest 5%
each). Different job, different maths.

## Edge cases

- **Incomplete job data.** When compensation is missing, Block D says so instead of
  inventing it; the Comp dimension reports "insufficient data, lowering confidence in
  the global". Vague JDs are flagged in Block G but never auto-classified as suspicious
  for being thin — startups, niche roles and recruiter-sourced postings legitimately
  carry less detail.
- **Roles that straddle two archetypes.** Block A surfaces both; Block B maps against
  each, with the dominant signal density in the JD deciding priority. You get the full
  split, not a hidden pick.
- **Closed or expired listings.** Liveness is checked separately from scoring
  (\`check-liveness.mjs\`): apply-button state, "applications closed" regex patterns, and
  posting age against a threshold adjusted for role type.
- **Cost and token usage.** A full evaluation is on the order of 5–10 model calls plus
  2–3 web searches (Blocks D and G). Actual cost depends on which CLI you configured;
  on a metered key, that bill is yours to watch.

## What career-ops explicitly does not do

Anti-features are as load-bearing as features. The list below comes from
\`modes/_shared.md\` and the rejected-PR record, calibrated against this fork:

- **No spray-and-pray.** The 4.0 line exists to reject most postings. By design.
- **No auto-apply.** Every application is your manual decision; nothing is submitted
  without your approval.
- **No invented experience or metrics.** If it is not in your CV or your proof-point
  digest, the system will not claim it.
- **No modification of \`cv.md\`.** That file is yours. Personalised output goes to a
  separate file; the source is never overwritten.
- **No phone numbers in generated messages.** Deliberate.
- **No below-market comp recommendations.** If the role pays badly, it says so.
- **No fingerprint masking to evade anti-bot systems.** Patchright-style masking was
  considered and rejected (upstream PR #235). This fork's browser collection uses
  humanised pacing (randomised paging and click intervals) and does not alter the
  browser fingerprint.
- **No LinkedIn scraping.** This fork's browser collection covers Chinese job portals;
  LinkedIn is only used for outreach copy, never scraped.
- **No cloud data storage.** career-ops is local code. The only thing that leaves the
  machine is whatever your chosen AI CLI sends to its provider.
- **No selling user data.** The project is MIT, free, and local-data. That is the model.
  There is no other.

---

## Source and licence

This page is adapted from [career-ops.org/methodology](https://career-ops.org/methodology)
(MIT License); the original text is © Santiago Fernández de Valderrama Aparicio. The
authoritative rubric lives in \`modes/_shared.md\` and \`modes/oferta.md\`.

**Differences from the upstream text** (adapted 2026-10-08):

1. Upstream writes "five dimensions" while the in-app summary said "six dimensions"
   (counting the global score as one). This page and the summary now agree on
   "five scoring dimensions plus a global score".
2. Upstream's block table stops at G; the actual report skeleton includes H (Draft
   Application Answers, only at ≥ 4.5). Added here.
3. Removed upstream's "what's in flight" list dated 2026-05-07, the Open Collective
   funding paragraph, and the author bio.
4. The anti-feature list is calibrated for this fork (browser collection over Chinese
   portals; humanised pacing is not fingerprint masking).
5. The concrete weights of the \`ofertas\` ten-dimension matrix are spelled out; upstream
   only said "published percentages".
`;
