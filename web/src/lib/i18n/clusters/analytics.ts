import type { Dict } from "../types";

// Cluster: analytics
// English (source) strings. Each key is dotted and namespaced by cluster, e.g.
// "analytics.something". Add keys here and their Chinese counterpart in zh below.
export const en: Dict = {
  "analytics.title": "Analytics",
  "analytics.trackedEvaluations": "Across {total} tracked evaluations.",
  "analytics.stat.evaluated": "evaluated",
  "analytics.stat.avgScore": "avg score",
  "analytics.stat.interviews": "interviews",
  "analytics.stat.offers": "offers",
  "analytics.stat.interviewsHint": "Interviews follow replies — keep follow-ups warm →",
  "analytics.stat.offersHint": "Offers follow interviews — keep the conversations going →",
  "analytics.section.pipelineByStage": "Pipeline by stage",
  "analytics.section.scoreDistribution": "Score distribution",
  "analytics.section.topCompanies": "Top companies",
  "analytics.stage.evaluated": "Evaluated",
  "analytics.stage.applied": "Applied",
  "analytics.stage.responded": "Responded",
  "analytics.stage.interview": "Interview",
  "analytics.stage.offer": "Offer",
  "analytics.stage.hired": "Hired",
  "analytics.stage.rejected": "Rejected",
  "analytics.stage.discarded": "Discarded",
};

// Simplified Chinese strings. Every key in en must have a matching key here.
export const zh: Dict = {
  "analytics.title": "数据分析",
  "analytics.trackedEvaluations": "已追踪 {total} 份评估。",
  "analytics.stat.evaluated": "已评估",
  "analytics.stat.avgScore": "平均分数",
  "analytics.stat.interviews": "面试",
  "analytics.stat.offers": "录用通知",
  "analytics.stat.interviewsHint": "面试紧随回复之后——保持跟进热度 →",
  "analytics.stat.offersHint": "录用通知紧随面试之后——保持对话继续 →",
  "analytics.section.pipelineByStage": "各阶段管道",
  "analytics.section.scoreDistribution": "分数分布",
  "analytics.section.topCompanies": "热门公司",
  "analytics.stage.evaluated": "已评估",
  "analytics.stage.applied": "已申请",
  "analytics.stage.responded": "已回复",
  "analytics.stage.interview": "面试中",
  "analytics.stage.offer": "录用通知",
  "analytics.stage.hired": "已入职",
  "analytics.stage.rejected": "已拒绝",
  "analytics.stage.discarded": "已放弃",
};
