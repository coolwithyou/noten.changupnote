import { z } from "zod";

/** 초안 문단 종류 라벨. 문항별 문안 시트와 작성 도우미 rail이 함께 쓰는 단일 원천(D3). */
export const writingParagraphKindLabels = {
  company_fact: "회사 자료 기반",
  plan: "이번 사업 계획",
  proposal: "검토할 제안",
} as const;
export type WritingParagraphKind = keyof typeof writingParagraphKindLabels;
export const writingCompositionSchema = z.object({
  paragraphs: z.array(z.object({
    text: z.string().min(1).max(1500),
    kind: z.enum(["company_fact", "plan", "proposal"]),
    evidence: z.array(z.object({ sourceId: z.string().min(1).max(300), quote: z.string().min(1).max(500) }).strict()).max(5),
  }).strict()).max(6),
  questions: z.array(z.string().min(1).max(250)).max(3),
}).strict();
export type WritingComposition = z.infer<typeof writingCompositionSchema>;
/** 초안 전체의 인용 근거 수. "인용 근거 보기 · N건" 표기에 쓴다. */
export function writingCompositionEvidenceCount(composition: WritingComposition): number {
  return composition.paragraphs.reduce((count, paragraph) => count + paragraph.evidence.length, 0);
}
export function writingCompositionText(composition: WritingComposition): string {
  return composition.paragraphs.map((paragraph) => paragraph.kind === "proposal" ? `검토 제안: ${paragraph.text}` : paragraph.text).join("\n\n");
}
