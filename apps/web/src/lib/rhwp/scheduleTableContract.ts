import { z } from "zod";

const monthSchema = z.number().int().min(1).max(12);

export const schedulePhaseSchema = z.strictObject({
  title: z.string().trim().min(2).max(80),
  startMonth: monthSchema,
  endMonth: monthSchema,
  basis: z.string().trim().min(1).max(400),
  basisKind: z.enum(["announcement", "draft", "recommendation"]),
  evidenceQuote: z.string().max(1_000),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(3),
});

export const scheduleTablePlanSchema = z.strictObject({
  phases: z.array(schedulePhaseSchema).min(1).max(8),
});

export const scheduleSuggestionRequestSchema = z.strictObject({
  months: z.array(monthSchema).min(3).max(12),
  maxPhases: z.number().int().min(1).max(8),
  currentRows: z.array(z.string().max(200)).max(8),
  userConstraints: z.string().trim().max(2_000).optional(),
}).superRefine((value, context) => {
  if (value.currentRows.length !== value.maxPhases) {
    context.addIssue({ code: "custom", path: ["currentRows"], message: "현재 행 수와 최대 단계 수가 일치해야 합니다." });
  }
  if (value.months.some((month, index) => index > 0 && month !== value.months[index - 1]! + 1)) {
    context.addIssue({ code: "custom", path: ["months"], message: "월 열은 같은 해 안에서 연속 증가해야 합니다." });
  }
});

export type SchedulePhase = z.infer<typeof schedulePhaseSchema>;
export type ScheduleTablePlan = z.infer<typeof scheduleTablePlanSchema>;
export type ScheduleSuggestionRequest = z.infer<typeof scheduleSuggestionRequestSchema>;
