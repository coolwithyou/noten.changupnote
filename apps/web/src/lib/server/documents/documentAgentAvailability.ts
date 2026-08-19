import type { CompanyRole } from "@cunote/core";
import { canWriteCompany } from "../auth/companyAccessPolicy";

export function isDocumentAgentFeatureEnabled(value = process.env.CUNOTE_DOCUMENT_AGENT_ENABLED): boolean {
  return isEnabled(value);
}

/**
 * 필드 결속형 편집 에이전트는 일반 본문 문단 에이전트와 별도의 rollout 경계를 가진다.
 * 한 기능의 플래그가 켜졌다는 이유로 다른 종류의 모델 호출이나 문서 mutation을 열지 않는다.
 */
export function isFieldEditorAgentFeatureEnabled(
  value = process.env.CUNOTE_FIELD_EDITOR_AGENT_ENABLED,
): boolean {
  return isEnabled(value);
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

export function resolveFieldEditorAgentAvailability(input: {
  executionMode: "persistent" | "virtual_preview" | "admin_preview";
  role: CompanyRole | null;
  draftId: string | null;
  featureFlag?: string;
}): boolean {
  return input.executionMode === "persistent"
    && input.draftId !== null
    && input.role !== null
    && canWriteCompany(input.role)
    && isFieldEditorAgentFeatureEnabled(input.featureFlag);
}

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
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

export class FieldEditorAgentUnavailableError extends Error {
  readonly code = "field_editor_agent_not_found";
  readonly status = 404;

  constructor() {
    super("AI 필드 제안을 사용할 수 없습니다.");
    this.name = "FieldEditorAgentUnavailableError";
  }
}

export function requireFieldEditorAgentFeature(): void {
  if (!isFieldEditorAgentFeatureEnabled()) throw new FieldEditorAgentUnavailableError();
}
