import { z } from "zod";

export const writingParagraphKindLabels = {
  company_fact: "자료에 근거한 회사 내용",
  plan: "이번 사업의 계획",
  proposal: "검토할 제안",
} as const;
export const writingCompositionSchema = z.object({
  paragraphs: z.array(z.object({
    text: z.string().min(1).max(1500),
    kind: z.enum(["company_fact", "plan", "proposal"]),
    evidence: z.array(z.object({ sourceId: z.string().min(1).max(300), quote: z.string().min(1).max(500) }).strict()).max(5),
  }).strict()).max(6),
  questions: z.array(z.string().min(1).max(250)).max(3),
}).strict();
export type WritingComposition = z.infer<typeof writingCompositionSchema>;
export function writingCompositionText(composition: WritingComposition): string {
  return composition.paragraphs.map((paragraph) => paragraph.kind === "proposal" ? `검토 제안: ${paragraph.text}` : paragraph.text).join("\n\n");
}
