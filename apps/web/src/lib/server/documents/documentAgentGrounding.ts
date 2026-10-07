import { createHash } from "node:crypto";
import type { DocumentEditCandidate } from "@/lib/rhwp/documentAgentContract";
import { canonicalJson } from "@/lib/rhwp/documentAgentContract";
import { buildGrantGrounding } from "../chat/grounding";

import { loadVerifiedDeepSources, type DocumentAgentGroundingSource, type DocumentAgentGroundingBundle } from "../analysis-serving/verifiedDeepSources";
export { loadVerifiedDeepSources } from "../analysis-serving/verifiedDeepSources";
export type { DocumentAgentEvidenceKind, DocumentAgentGroundingSource, DocumentAgentGroundingBundle } from "../analysis-serving/verifiedDeepSources";

export async function buildDocumentAgentGrounding(input: {
  grantId: string;
  companyId: string;
  revisionId: string;
  candidate: DocumentEditCandidate;
}): Promise<DocumentAgentGroundingBundle> {
  const grounding = await buildGrantGrounding({
    grantId: input.grantId,
    companyId: input.companyId,
    disableCitations: true,
  });
  const sources: DocumentAgentGroundingSource[] = [];
  sources.push(makeSource({
    sourceId: `current_document:${input.candidate.candidateId}`,
    kind: "current_document",
    title: `${input.candidate.location.page}쪽 ${input.candidate.location.label}`,
    content: [
      "[현재 문서 대상 문단]",
      input.candidate.beforeText,
      "[앞뒤 문맥]",
      input.candidate.adjacentContext,
    ].join("\n"),
    provenance: {
      revisionId: input.revisionId,
      candidateId: input.candidate.candidateId,
      documentSha256: input.candidate.documentSha256,
    },
  }));

  for (const [index, document] of grounding.documents.entries()) {
    const content = Buffer.from(document.data, "base64").toString("utf8");
    const contentSha = sha256(content);
    sources.push(makeSource({
      sourceId: `grant_announcement:${index}:${contentSha}`,
      kind: "announcement",
      title: document.filename,
      content,
      provenance: { filename: document.filename },
    }));
  }
  if (grounding.dynamicContext.trim()) {
    const content = grounding.dynamicContext.trim();
    sources.push(makeSource({
      sourceId: `company_profile:verified_context:${sha256(content)}`,
      kind: "company_profile",
      title: "현재 회사 확인 정보와 승인된 작성 가이드",
      content,
      provenance: { companyId: input.companyId },
    }));
  }

  const deep = await loadVerifiedDeepSources(input.grantId);
  sources.push(...deep.sources);
  assertUniqueSourceIds(sources);
  const bindingProjection = sources
    .map((source) => ({ sourceId: source.sourceId, contentSha256: source.sha256 }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId, "en"));
  const groundingBindingSha256 = sha256(canonicalJson(bindingProjection));
  return {
    sources,
    groundingBindingSha256,
    groundingProvenance: {
      sourceCount: sources.length,
      sources: bindingProjection,
      announcementBodySourceMissing: grounding.bodySourceMissing,
      announcementTruncated: grounding.truncated,
      deep: deep.provenance,
    },
  };
}


function makeSource(input: Omit<DocumentAgentGroundingSource, "sha256">): DocumentAgentGroundingSource {
  return { ...input, sha256: sha256(input.content) };
}

function assertUniqueSourceIds(sources: readonly DocumentAgentGroundingSource[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.sourceId)) throw new Error(`document agent grounding source ID 충돌: ${source.sourceId}`);
    seen.add(source.sourceId);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
