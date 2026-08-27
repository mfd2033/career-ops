import type { Dict } from "../types";

// Cluster: home
// English (source) strings. Each key is dotted and namespaced by cluster, e.g.
// "home.something". Add keys here and their Chinese counterpart in zh below.
export const en: Dict = {
  // today-dashboard.tsx
  "home.todayLabel": "today",
  "home.allCaughtUp": "You're all caught up.",
  "home.newMatchOne": "{n} new match this week",
  "home.newMatches": "{n} new matches this week",
  "home.followUpDueOne": "{n} follow-up due",
  "home.followUpsDue": "{n} follow-ups due",
  "home.allClearSub": "I'll keep scanning the market in the background and surface anything that fits.",
  "home.actionQueueSub": "Your action queue for today — discovery and follow-ups, in one place.",
  "home.findNewRoles": "Find new roles",
  "home.openPipeline": "Open pipeline",
  "home.followUpsDueTitle": "Follow-ups due",
  "home.followUpsDueHint": "Keep your applications alive — a nudge beats silence",
  "home.awaitingTitle": "Awaiting your decision",
  "home.awaitingHint": "Scored — apply or skip",
  "home.freshMatchesTitle": "Fresh matches this week",
  "home.freshMatchesHint": "Found by your free scans · 0 tokens",
  "home.seeAll": "See all {n}",
  "home.nothingNeedsYou1": "Nothing needs you right now. Run a",
  "home.freeScanLink": "free scan",
  "home.nothingNeedsYou2": "to surface this week's roles, or check your",
  "home.nothingNeedsYou3": ".",

  // first-run-home.tsx
  "home.localFirstTag": "local-first · your machine",
  "home.dropCvHeadline": "Drop your CV. See who's hiring you in 60 seconds.",
  "home.noAccount1": "No account. Paste text or drop a .md / .txt file to start. A PDF needs an AI CLI in",
  "home.noAccount2": "first. The market scan is ",
  "home.free": "free",
  "home.noAccount3": ". You only spend tokens when you choose to score a role.",

  // decision-card.tsx
  "home.review": "Review",
  "home.skip": "Skip",
  "home.recordAppliedTitle": "Record Applied without opening the apply flow",
  "home.applied": "Applied",

  // follow-up-card.tsx
  "home.appliedOn": "applied {date}",
  "home.followUpDue": "follow-up due",
  "home.markFollowedUp": "Mark followed up",
  "home.failed": "Failed",
  "home.retry": "Retry",
  "home.followedUp": "Followed up",
  "home.openReport": "Open report",
  "home.snooze": "Snooze",
};

// Simplified Chinese strings. Every key in en must have a matching key here.
export const zh: Dict = {
  // today-dashboard.tsx
  "home.todayLabel": "今日",
  "home.allCaughtUp": "你已处理完所有事项。",
  "home.newMatchOne": "{n} 个本周新匹配",
  "home.newMatches": "{n} 个本周新匹配",
  "home.followUpDueOne": "{n} 个待跟进",
  "home.followUpsDue": "{n} 个待跟进",
  "home.allClearSub": "我会继续在后台扫描市场，并推送任何合适的机会。",
  "home.actionQueueSub": "你今天的行动队列——发现机会与跟进，集中在一处。",
  "home.findNewRoles": "发现新职位",
  "home.openPipeline": "打开求职管道",
  "home.followUpsDueTitle": "待跟进",
  "home.followUpsDueHint": "保持申请活跃——主动提醒胜过沉默",
  "home.awaitingTitle": "等待你的决定",
  "home.awaitingHint": "已评分——申请或跳过",
  "home.freshMatchesTitle": "本周新匹配",
  "home.freshMatchesHint": "由免费扫描发现 · 0 tokens",
  "home.seeAll": "查看全部 {n}",
  "home.nothingNeedsYou1": "现在没有需要你处理的事。运行一次",
  "home.freeScanLink": "免费扫描",
  "home.nothingNeedsYou2": "以发现本周的职位，或查看你的",
  "home.nothingNeedsYou3": "。",

  // first-run-home.tsx
  "home.localFirstTag": "本地优先 · 你的设备",
  "home.dropCvHeadline": "拖入你的简历。60 秒内看看谁在招聘你。",
  "home.noAccount1": "无需账号。粘贴文本或拖入 .md / .txt 文件即可开始。生成 PDF 需要先在",
  "home.noAccount2": "中配置一个 AI CLI。市场扫描",
  "home.free": "免费",
  "home.noAccount3": "。只有在你选择为某个职位评分时才会消耗 tokens。",

  // decision-card.tsx
  "home.review": "查看",
  "home.skip": "跳过",
  "home.recordAppliedTitle": "在不打开申请流程的情况下记录已申请",
  "home.applied": "已申请",

  // follow-up-card.tsx
  "home.appliedOn": "已于 {date} 申请",
  "home.followUpDue": "待跟进",
  "home.markFollowedUp": "标记已跟进",
  "home.failed": "失败",
  "home.retry": "重试",
  "home.followedUp": "已跟进",
  "home.openReport": "打开报告",
  "home.snooze": "稍后提醒",
};
