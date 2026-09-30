import { z } from "zod";

const text = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "제어 문자를 포함할 수 없습니다.");
export const writingBriefFields = {
  projectName: "이번 사업 이름",
  problem: "해결하려는 문제",
  solution: "제품·서비스와 해결 방법",
  customers: "고객과 사용 대상",
  differentiation: "차별성과 보유 역량",
  goals: "이번 사업의 목표",
  timeline: "추진 일정",
  budget: "예산과 조달 계획",
} as const;
export const writingBriefSchema = z.object({
  projectName: text(200), problem: text(3000), solution: text(3000), customers: text(3000),
  differentiation: text(3000), goals: text(3000), timeline: text(3000), budget: text(3000),
}).strict();
export type WritingBrief = z.infer<typeof writingBriefSchema>;
export const emptyWritingBrief = (): WritingBrief => ({ projectName: "", problem: "", solution: "", customers: "", differentiation: "", goals: "", timeline: "", budget: "" });
export const saveWritingBriefSchema = z.object({
  expectedRevision: z.number().int().min(0),
  brief: writingBriefSchema,
  sourceIds: z.array(z.string().uuid()).max(10).refine((ids) => new Set(ids).size === ids.length),
}).strict();
export type SaveWritingBrief = z.infer<typeof saveWritingBriefSchema>;
export const createWritingSourceSchema = z.object({
  requestId: z.string().uuid(),
  title: text(200).refine((value) => value.trim().length > 0, "자료 이름을 입력해 주세요."),
  content: text(30000).refine((value) => value.trim().length > 0, "자료 내용을 입력해 주세요."),
  scope: z.enum(["company", "application"]),
  kind: z.enum(["user_statement", "company_document"]),
  observedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }).nullable(),
}).strict();
export type CreateWritingSource = z.infer<typeof createWritingSourceSchema>;
export interface WritingSourceSummary {
  id: string;
  title: string;
  scope: "company" | "application";
  kind: "user_statement" | "company_document";
  sha256: string;
  observedDate: string | null;
  createdAt: string;
  withdrawn: boolean;
}
export interface WritingContext {
  revision: number;
  brief: WritingBrief;
  sourceIds: string[];
  sources: WritingSourceSummary[];
  sourcesTruncated: boolean;
  canWrite: boolean;
}
