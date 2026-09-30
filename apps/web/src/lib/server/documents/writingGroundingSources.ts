import { createHash } from "node:crypto";
import { writingBriefFields, type WritingBrief, type WritingSourceSummary } from "@/lib/documents/writingContext";
import { canonicalJson } from "@/lib/rhwp/documentAgentContract";
import type { loadWritingGrounding } from "./writingContext";
import type { DocumentAgentGroundingSource } from "./documentAgentGrounding";

/** 원문 자료는 사용자 제공 근거이며 외부 검증된 프로필로 승격하지 않는다. */
export function writingGroundingSources(input: {
  companyId: string; draftId: string; revision: number; brief: WritingBrief;
  sources: Array<WritingSourceSummary & { content: string }>;
}): DocumentAgentGroundingSource[] {
  const sources: DocumentAgentGroundingSource[] = input.sources.map((source) => {
    if (source.withdrawn) throw new Error("철회한 회사 자료는 생성 근거로 사용할 수 없습니다.");
    const sha256 = createHash("sha256").update(source.content).digest("hex");
    if (sha256 !== source.sha256) throw new Error("회사 자료의 내용과 출처 해시가 일치하지 않습니다.");
    return { sourceId: `company_material:${source.id}:${source.sha256}`, kind: "company_material", title: source.title,
      content: source.content, sha256, provenance: { companyId: input.companyId, draftId: input.draftId,
        sourceId: source.id, observedDate: source.observedDate, sourceKind: source.kind, verification: "user_provided" } };
  });
  const brief = (Object.keys(writingBriefFields) as (keyof WritingBrief)[])
    .filter((key) => input.brief[key].trim()).map((key) => `${writingBriefFields[key]}: ${input.brief[key]}`).join("\n");
  if (brief) {
    const content = `[이번 신청의 사용자 계획 — 달성한 회사 실적이 아님]\n${brief}`;
    const sha256 = createHash("sha256").update(content).digest("hex");
    sources.push({ sourceId: `application_plan:${input.draftId}:${input.revision}:${sha256}`, kind: "application_plan",
      title: "이번 사업의 목표와 계획", content, sha256, provenance: { companyId: input.companyId, draftId: input.draftId, briefRevision: input.revision } });
  }
  return sources;
}

export function writingContextBinding(input: Awaited<ReturnType<typeof loadWritingGrounding>>): string {
  return createHash("sha256").update(canonicalJson({ revision: input.revision, brief: input.brief,
    sources: input.sources.map((source) => ({ id: source.id, sha256: source.sha256 })).sort((a, b) => a.id.localeCompare(b.id)),
  })).digest("hex");
}
