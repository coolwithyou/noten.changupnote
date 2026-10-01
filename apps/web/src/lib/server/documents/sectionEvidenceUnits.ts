import { createHash } from "node:crypto";
import { z } from "zod";
import type { DocumentAgentGroundingSource } from "./documentAgentGrounding";
import type { WritingComposition } from "@/lib/documents/writingComposition";
import { WritingContextError } from "./writingContext";
import { sectionFailureMessage } from "@/lib/documents/sectionFailure";

export interface SectionEvidenceUnit {
  evidenceId: string; sourceId: string; kind: DocumentAgentGroundingSource["kind"];
  start: number; end: number; quote: string;
}
/** Offsets always address the original source. Segmentation never rewrites quotes. */
export function buildSectionEvidenceUnits(sources: readonly DocumentAgentGroundingSource[]): SectionEvidenceUnit[] {
  const units: SectionEvidenceUnit[] = [];
  const segmenter = new Intl.Segmenter("ko", { granularity: "sentence" });
  for (const source of sources) {
    for (const line of source.content.matchAll(/[^\r\n]+/gu)) {
      // A brief line is one labelled record. Splitting it into sentences loses
      // shared year/period/condition qualifiers needed by later sentences.
      const trimmedLine = line[0].trim();
      const sentences = source.kind === "application_plan" && trimmedLine.length <= 500
        ? [{ index: line[0].indexOf(trimmedLine), segment: trimmedLine }] : segmenter.segment(line[0]);
      for (const sentence of sentences) {
        let start = line.index! + sentence.index;
        const sentenceEnd = start + sentence.segment.length;
        while (start < sentenceEnd) {
          let end = Math.min(start + 500, sentenceEnd);
          // Avoid splitting a Unicode surrogate pair at the fixed schema boundary.
          if (end < sentenceEnd && /[\uD800-\uDBFF]/u.test(source.content[end - 1]!)) end--;
          if (end < sentenceEnd) {
            const boundary = source.content.slice(start, end).search(/\s+\S*$/u);
            if (boundary >= 250) end = start + boundary;
          }
          let quoteStart = start;
          let quoteEnd = end;
          while (quoteStart < quoteEnd && /\s/u.test(source.content[quoteStart]!)) quoteStart++;
          while (quoteEnd > quoteStart && /\s/u.test(source.content[quoteEnd - 1]!)) quoteEnd--;
          if (quoteStart < quoteEnd) {
            const quote = source.content.slice(quoteStart, quoteEnd);
            const evidenceId = `e_${createHash("sha256").update(JSON.stringify([source.sourceId, source.sha256, quoteStart, quoteEnd, quote])).digest("hex").slice(0, 20)}`;
            units.push({ evidenceId, sourceId: source.sourceId, kind: source.kind, start: quoteStart, end: quoteEnd, quote });
          }
          start = end;
        }
      }
    }
  }
  if (new Set(units.map(unit => unit.evidenceId)).size !== units.length) throw new Error("Duplicate section evidence IDs");
  return units;
}
export function sectionEvidencePolicy(units: readonly SectionEvidenceUnit[]) {
  return {
    companyFacts: units.filter(unit => ["company_profile", "company_material", "current_document"].includes(unit.kind)
      && !/목표|계획|예정|추진할|확보할/u.test(unit.quote)),
    plans: units.filter(unit => ["application_plan", "current_document"].includes(unit.kind)),
  };
}
const unitEnum = (units: readonly SectionEvidenceUnit[]) => z.enum(units.map(unit => unit.evidenceId) as [string, ...string[]]);
export function sectionEvidenceSelectionSchema(units: readonly SectionEvidenceUnit[]) {
  const policy = sectionEvidencePolicy(units);
  const text = z.string().min(1).max(1500);
  const allIds = (max: number) => units.length ? z.array(unitEnum(units)).max(max) : z.array(z.string()).max(0);
  const proposal = z.object({ text, kind: z.literal("proposal"), evidenceIds: allIds(5) }).strict();
  const company = policy.companyFacts.length ? z.object({ text, kind: z.literal("company_fact"),
    evidenceIds: z.array(unitEnum(policy.companyFacts)).min(1).max(5) }).strict() : null;
  const plan = policy.plans.length ? z.object({ text, kind: z.literal("plan"),
    primaryEvidenceId: unitEnum(policy.plans), supportingEvidenceIds: allIds(4) }).strict() : null;
  // z.union emits provider-supported anyOf. No impossible/empty enum branches.
  const paragraph = company && plan ? z.union([company, plan, proposal])
    : company ? z.union([company, proposal]) : plan ? z.union([plan, proposal]) : proposal;
  return z.object({ paragraphs: z.array(paragraph).max(6),
    questions: z.array(z.string().min(1).max(250)).max(3) }).strict();
}
export function resolveSectionEvidenceSelection(raw: unknown, units: readonly SectionEvidenceUnit[]): WritingComposition {
  const parsed = sectionEvidenceSelectionSchema(units).safeParse(raw);
  if (!parsed.success) throw new WritingContextError("section_output_invalid", sectionFailureMessage("section_output_invalid"), 502);
  const byId = new Map(units.map(unit => [unit.evidenceId, unit]));
  return { paragraphs: parsed.data.paragraphs.map(paragraph => ({ text: paragraph.text, kind: paragraph.kind,
    evidence: (paragraph.kind === "plan" ? [paragraph.primaryEvidenceId, ...paragraph.supportingEvidenceIds] : paragraph.evidenceIds)
      .map(id => { const unit = byId.get(id)!; return { sourceId: unit.sourceId, quote: unit.quote }; }) })),
    questions: parsed.data.questions };
}
