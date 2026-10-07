import { createHash } from "node:crypto";
import type { DocumentAgentGroundingSource } from "../analysis-serving/verifiedDeepSources";
import type { GrantGrounding } from "../chat/grounding";

/** 작성 지침의 예시 실적·지원 요건을 회사 프로필 인용으로 사용할 수 없게 분리한다. */
export function writingGuidanceSources(grounding: Pick<GrantGrounding, "profileSummary" | "lessonBlock">, companyId: string): DocumentAgentGroundingSource[] {
  const sources: DocumentAgentGroundingSource[] = [];
  for (const block of [
    { content: grounding.profileSummary, kind: "company_profile" as const, title: "저장된 회사 정보" },
    { content: grounding.lessonBlock, kind: "writing_guide" as const, title: "승인된 작성 지침 · 회사 실적 근거가 아님" },
  ]) {
    const content = block.content.trim();
    if (!content) continue;
    const sha256 = createHash("sha256").update(content).digest("hex");
    sources.push({ sourceId: `${block.kind}:${sha256}`, kind: block.kind, title: block.title, content, sha256,
      provenance: block.kind === "company_profile" ? { companyId, verification: "stored_profile" } : { verification: "approved_guidance" } });
  }
  return sources;
}
