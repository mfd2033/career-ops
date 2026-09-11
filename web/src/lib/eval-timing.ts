// Shared shape of an eval-timing summary (see CONTEXT.md「评估用时」). Kept in a
// directive-free module so BOTH server code (career-ops.ts) and client hooks
// (eval-duration-client.ts) can import the same type without bundling either
// side into the other.
export type EvalStep = { step: string; seconds: number };

/** Latest eval session for one report number: `duration` is the 评估用时
 *  (sum of report-delivery steps only — extract/liveness/eval/report; delayed
 *  pdf/answers/tracker are visible in `steps` but NOT counted, ADR-0016). */
export type EvalTimingEntry = {
  duration: number | null;
  steps: EvalStep[];
  finishedAt: string | null;
};
