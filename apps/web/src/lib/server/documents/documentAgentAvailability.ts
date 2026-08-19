import type { CompanyRole } from "@cunote/core";
import { canWriteCompany } from "../auth/companyAccessPolicy";

export function isDocumentAgentFeatureEnabled(value = process.env.CUNOTE_DOCUMENT_AGENT_ENABLED): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

export function resolveDocumentAgentAvailability(input: {
  executionMode: "persistent" | "virtual_preview" | "admin_preview";
  role: CompanyRole | null;
  draftId: string | null;
  featureFlag?: string;
}): boolean {
  return input.executionMode === "persistent"
    && input.draftId !== null
    && input.role !== null
    && canWriteCompany(input.role)
    && isDocumentAgentFeatureEnabled(input.featureFlag);
}

export class DocumentAgentUnavailableError extends Error {
  readonly code = "document_agent_not_found";
  readonly status = 404;

  constructor() {
    super("문서 AI 작성 제안을 사용할 수 없습니다.");
    this.name = "DocumentAgentUnavailableError";
  }
}

export function requireDocumentAgentFeature(): void {
  if (!isDocumentAgentFeatureEnabled()) throw new DocumentAgentUnavailableError();
}
