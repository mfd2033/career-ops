import type { Dict } from "../types";

// Cluster: apply
// English (source) strings. Each key is dotted and namespaced by cluster, e.g.
// "apply.something". Add keys here and their Chinese counterpart in zh below.
export const en: Dict = {
  // ── apply page (web/src/app/apply/page.tsx) ──
  "apply.pageIntro":
    "career-ops reads the real application form on your machine and re-renders it here in plain language, pre-filled from your CV. You verify every answer — then it fills the real form behind the scenes and you submit it yourself. It never submits for you.",

  // ── apply button (web/src/components/apply-button.tsx) ──
  "apply.apply": "Apply",
  "apply.openJob": "Open job",
  "apply.openJobTitle": "Open the job posting in a new tab",
  "apply.applyTitle": "Apply — opens the form pre-filled, you review and submit yourself",
  "apply.noAppUrl": "No application URL on this report",
  "apply.genCvFirst": "Generate the tailored CV (PDF) first to apply",

  // ── apply view: idle / error input ──
  "apply.formUrlPlaceholder": "Paste an application form URL (Ashby, Lever, Greenhouse…)",
  "apply.readForm": "Read form",
  "apply.openFormDirectly": "Open the form directly",
  "apply.application": "Application",
  "apply.new": "new",

  // ── apply view: opening hero ──
  "apply.readingFormTitle": "Reading your form…",
  "apply.readingFormSubtitle": "Opening the real application on your machine and reading every field.",

  // ── apply view: prefill / drafting ──
  "apply.draftingAnswers": "Drafting your answers…",
  "apply.draftingFromCv": "Drafting from your CV…",
  "apply.prefillFromCv": "Pre-fill from my CV",
  "apply.askAssistant": "…or ask the corner assistant to write/revise any answer.",
  "apply.prefillDiagnostics": "Pre-fill diagnostics",
  "apply.steps": "{count} steps",

  // ── apply view: action buttons ──
  "apply.fillingRealForm": "Filling the real form…",
  "apply.fillRealFormReview": "Fill the real form & review",
  "apply.letAiFillTitle":
    "Let the AI drive the real form and fill it field-by-field (for tricky / multi-step forms). It never submits.",
  "apply.letAiFillIt": "Let the AI fill it",
  "apply.neverSubmits": "Never submits — you click Submit yourself.",

  // ── apply view: behind the scenes / done ──
  "apply.behindTheScenes": "Behind the scenes",
  "apply.field": "field",
  "apply.realFormPrefilled": "The real form is now in front, pre-filled.",
  "apply.reviewAndSubmit":
    "Review it and click Submit yourself — career-ops never submits for you.",

  // ── apply view: exit bar ──
  "apply.couldntMarkApplied": "Couldn't mark it applied — the tracker row is unchanged.",
  "apply.couldntConfirmUpdate":
    "Couldn't confirm the update — check the row in your tracker before relying on it.",
  "apply.leaveApplication": "Leave this application?",
  "apply.draftedAnswersDiscard":
    "Your drafted answers live only on this page. Going back discards them and closes the form.",
  "apply.leaveAndDiscard": "Leave and discard",
  "apply.stayHere": "Stay here",
  "apply.back": "Back",
  "apply.markAppliedTitle": "Set tracker row #{n} to Applied and go back",
  "apply.updatingTracker": "Updating your tracker…",
  "apply.markApplied": "Mark applied",
  "apply.clickOnceSubmitted": "Click this once you have submitted the real form yourself.",

  // ── apply view: drive panel verbs ──
  "apply.driveVerb.click": "Clicked",
  "apply.driveVerb.type": "Typed into",
  "apply.driveVerb.select": "Selected",
  "apply.driveVerb.scroll": "Scrolled",
  "apply.driveVerb.parse-error": "Thinking…",
  "apply.driveVerb.stuck": "Stuck",
  "apply.driveVerb.reached_form": "Reached the form",

  // ── apply view: drive panel headings ──
  "apply.aiFillingForm": "AI is filling the form…",
  "apply.reachingForm": "Reaching your form…",
  "apply.aiFillingDesc":
    "The AI is driving the real form field-by-field on your machine — it never submits; you review and submit.",
  "apply.aiReachingDesc":
    "The AI is navigating the real application on your machine to reach the form — it never submits.",

  // ── apply view: issues ──
  "apply.fewThingsToCheck": "A few things to check",

  // ── apply view: phase rail ──
  "apply.phaseReading": "Reading form",
  "apply.phaseDrafting": "Drafting answers",
  "apply.phaseReview": "Review & submit",

  // ── apply view: rotating draft status ──
  "apply.draft.readingCv": "Reading your CV…",
  "apply.draft.readingRole": "Reading the role and company…",
  "apply.draft.matching": "Matching your experience to each question…",
  "apply.draft.writingVoice": "Writing every answer in your own voice…",
  "apply.draft.flagging": "Flagging anything that needs your call…",

  // ── apply view: field rows ──
  "apply.untitledField": "Untitled field",
  "apply.youConfirm": "you confirm",
  "apply.youFillThisOne": "You fill this one.",
  "apply.choose": "Choose…",
  "apply.yes": "Yes",
  "apply.cvAttachedAuto":
    "Your tailored CV (PDF) will be attached automatically — you can swap it on the real form.",
  "apply.attachFileYourself": "Attach this file yourself on the real form at the handoff.",

  // ── apply provider: error / status strings ──
  "apply.errAgentCouldntStart": "The agent couldn't start.",
  "apply.errAgentCouldntReach": "The agent couldn't reach a fillable form.",
  "apply.errAgentStopped": "The agent stopped before reaching a form.",
  "apply.errAgentReachStream": "The agent couldn't reach the form: {msg}.",
  "apply.errCouldNotOpen": "Could not open the form.",
  "apply.errConfigureCli": "Configure a CLI in Config first, then pre-fill from your CV.",
  "apply.errNoResponseStream": "Couldn't pre-fill — no response stream.",
  "apply.errZeroAnswers": "The planner returned 0 answers — see the diagnostics log below.",
  "apply.errPlannerCutOff":
    "The planner was cut off — some fields were recovered, others may be blank. See diagnostics.",
  "apply.errPrefillMsg": "Couldn't pre-fill: {msg}",
  "apply.errPrefillCv": "Couldn't pre-fill from your CV.",
  "apply.errPrefillNoAnswers": "Pre-fill ended without answers — see the diagnostics log below.",
  "apply.errPrefillCvStream": "Couldn't pre-fill from your CV: {msg}. See diagnostics.",
  "apply.errPageChanged":
    "Heads up: the form's page changed during fill — review it carefully before submitting (career-ops never submits for you).",
  "apply.errFillFailed": "Fill failed.",
  "apply.errAgentCouldntStartFill": "The agent couldn't start filling.",
  "apply.aiFilledDone":
    "AI filled the form for you — review every answer on the real form, then submit it yourself.",
  "apply.aiFilledPartial":
    "AI did its best but couldn't finish — check the real form before submitting.",
  "apply.errAgentCouldntFill": "The agent couldn't fill the form.",
  "apply.errAgentFillStream": "The agent couldn't fill the form: {msg}.",
  "apply.errFallback": "error",
  "apply.logError": "✗ {msg}",
  "apply.logErrorRaw": "✗ {msg} — raw tail: {raw}",
};

// Simplified Chinese strings. Every key in en must have a matching key here.
export const zh: Dict = {
  // ── apply page (web/src/app/apply/page.tsx) ──
  "apply.pageIntro":
    "career-ops 会在你的设备上读取真实申请表单，并以通俗语言在此重新呈现，已根据你的简历预填。你核对每一个回答——随后它在后台填写真实表单，由你亲自提交。它绝不会替你提交。",

  // ── apply button (web/src/components/apply-button.tsx) ──
  "apply.apply": "申请",
  "apply.openJob": "打开职位",
  "apply.openJobTitle": "在新标签页打开该职位链接",
  "apply.applyTitle": "申请——打开已预填的表单，由你核对并亲自提交",
  "apply.noAppUrl": "该报告没有申请链接",
  "apply.genCvFirst": "请先生成定制简历（PDF）再申请",

  // ── apply view: idle / error input ──
  "apply.formUrlPlaceholder": "粘贴申请表单链接（Ashby、Lever、Greenhouse…）",
  "apply.readForm": "读取表单",
  "apply.openFormDirectly": "直接打开表单",
  "apply.application": "申请",
  "apply.new": "新建",

  // ── apply view: opening hero ──
  "apply.readingFormTitle": "正在读取你的表单…",
  "apply.readingFormSubtitle": "正在你的设备上打开真实申请表单，并读取每一个字段。",

  // ── apply view: prefill / drafting ──
  "apply.draftingAnswers": "正在起草你的回答…",
  "apply.draftingFromCv": "正在根据你的简历起草…",
  "apply.prefillFromCv": "用我的简历预填",
  "apply.askAssistant": "…或让角落里的助手帮你撰写/修改任意回答。",
  "apply.prefillDiagnostics": "预填诊断",
  "apply.steps": "{count} 步",

  // ── apply view: action buttons ──
  "apply.fillingRealForm": "正在填写真实表单…",
  "apply.fillRealFormReview": "填写真实表单并核对",
  "apply.letAiFillTitle":
    "让 AI 接管真实表单并逐字段填写（适用于复杂/多步骤表单）。它绝不会替你提交。",
  "apply.letAiFillIt": "让 AI 来填写",
  "apply.neverSubmits": "绝不代你提交——由你亲自点击提交。",

  // ── apply view: behind the scenes / done ──
  "apply.behindTheScenes": "幕后",
  "apply.field": "字段",
  "apply.realFormPrefilled": "真实表单已打开在眼前，并完成预填。",
  "apply.reviewAndSubmit":
    "请核对内容并亲自点击提交——career-ops 绝不会替你提交。",

  // ── apply view: exit bar ──
  "apply.couldntMarkApplied": "无法标记为已申请——追踪表中的记录未改动。",
  "apply.couldntConfirmUpdate":
    "无法确认更新——在依赖该记录前，请先在追踪表中核对。",
  "apply.leaveApplication": "离开这次申请？",
  "apply.draftedAnswersDiscard":
    "你起草的回答仅存在于本页。返回将丢弃它们并关闭表单。",
  "apply.leaveAndDiscard": "离开并丢弃",
  "apply.stayHere": "留在此处",
  "apply.back": "返回",
  "apply.markAppliedTitle": "将追踪表第 #{n} 行标记为已申请并返回",
  "apply.updatingTracker": "正在更新你的追踪表…",
  "apply.markApplied": "标记为已申请",
  "apply.clickOnceSubmitted": "在你亲自提交真实表单后，再点击此处。",

  // ── apply view: drive panel verbs ──
  "apply.driveVerb.click": "已点击",
  "apply.driveVerb.type": "已输入",
  "apply.driveVerb.select": "已选择",
  "apply.driveVerb.scroll": "已滚动",
  "apply.driveVerb.parse-error": "思考中…",
  "apply.driveVerb.stuck": "卡住",
  "apply.driveVerb.reached_form": "已到达表单",

  // ── apply view: drive panel headings ──
  "apply.aiFillingForm": "AI 正在填写表单…",
  "apply.reachingForm": "正在前往你的表单…",
  "apply.aiFillingDesc":
    "AI 正在你的设备上逐字段接管真实表单——它绝不会提交；由你核对并提交。",
  "apply.aiReachingDesc":
    "AI 正在你的设备上导航真实申请页面以到达表单——它绝不会提交。",

  // ── apply view: issues ──
  "apply.fewThingsToCheck": "有几处需要核对",

  // ── apply view: phase rail ──
  "apply.phaseReading": "读取表单",
  "apply.phaseDrafting": "起草回答",
  "apply.phaseReview": "核对并提交",

  // ── apply view: rotating draft status ──
  "apply.draft.readingCv": "正在阅读你的简历…",
  "apply.draft.readingRole": "正在阅读职位与公司信息…",
  "apply.draft.matching": "正在将你的经历匹配到每个问题…",
  "apply.draft.writingVoice": "正在用你自己的口吻撰写每个回答…",
  "apply.draft.flagging": "正在标记需要你亲自判断的内容…",

  // ── apply view: field rows ──
  "apply.untitledField": "未命名字段",
  "apply.youConfirm": "需你确认",
  "apply.youFillThisOne": "这一项由你填写。",
  "apply.choose": "请选择…",
  "apply.yes": "是",
  "apply.cvAttachedAuto":
    "你的定制简历（PDF）将自动附上——你可以在真实表单上替换它。",
  "apply.attachFileYourself": "在交接时，请在真实表单上自行附上此文件。",

  // ── apply provider: error / status strings ──
  "apply.errAgentCouldntStart": "AI 无法启动。",
  "apply.errAgentCouldntReach": "AI 无法到达可填写的表单。",
  "apply.errAgentStopped": "AI 在到达表单前停止了。",
  "apply.errAgentReachStream": "AI 无法到达表单：{msg}。",
  "apply.errCouldNotOpen": "无法打开表单。",
  "apply.errConfigureCli": "请先在「设置」中配置 CLI，再用简历预填。",
  "apply.errNoResponseStream": "无法预填——没有响应流。",
  "apply.errZeroAnswers": "规划器返回了 0 个回答——请查看下方的诊断日志。",
  "apply.errPlannerCutOff":
    "规划器被中断——部分字段已恢复，其余可能为空。请查看诊断信息。",
  "apply.errPrefillMsg": "无法预填：{msg}",
  "apply.errPrefillCv": "无法根据你的简历预填。",
  "apply.errPrefillNoAnswers": "预填结束但未生成回答——请查看下方的诊断日志。",
  "apply.errPrefillCvStream": "无法根据你的简历预填：{msg}。请查看诊断信息。",
  "apply.errPageChanged":
    "注意：填写过程中表单页面发生了变化——提交前请仔细核对（career-ops 绝不会替你提交）。",
  "apply.errFillFailed": "填写失败。",
  "apply.errAgentCouldntStartFill": "AI 无法开始填写。",
  "apply.aiFilledDone":
    "AI 已为你填写表单——请在真实表单上核对每个回答，然后亲自提交。",
  "apply.aiFilledPartial":
    "AI 已尽力但未能完成——提交前请检查真实表单。",
  "apply.errAgentCouldntFill": "AI 无法填写表单。",
  "apply.errAgentFillStream": "AI 无法填写表单：{msg}。",
  "apply.errFallback": "错误",
  "apply.logError": "✗ {msg}",
  "apply.logErrorRaw": "✗ {msg} — 原始尾部：{raw}",
};
