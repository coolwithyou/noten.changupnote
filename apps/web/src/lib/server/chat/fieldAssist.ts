import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { FieldAssistOutcome } from "@/lib/chat/messageContent";
import { generateFieldSuggestions } from "@/lib/server/documents/fieldSuggest";
import { requestFieldAgentSuggestions } from "@/lib/server/documents/fieldAgentRuns";
import { getGrantDocumentDraft } from "@/lib/server/documents/grantDocumentDrafts";
import type { StudioFieldTargetV1 } from "@/lib/rhwp/studioDocumentAgentProtocol";
import { ChatSessionError } from "./session";

/**
 * 기존 근거 검증 필드 제안 파이프라인을 채팅용 실행 결과로 감싼다.
 * 제안이 만들어지지 않으면 값을 발명하지 않고 사용자 입력 질문으로 낮춘다.
 */
export async function buildFieldAssistOutcome(input: {
  access: CompanyAccess;
  grantId: string;
  draftId: string;
  field: {
    fieldId?: string;
    label: string;
    section?: string;
    fieldAgent?: {
      clientRequestId: string;
      baseRevisionId: string;
      target: StudioFieldTargetV1;
    };
  };
  userMessage: string;
}): Promise<FieldAssistOutcome> {
  const draft = await getGrantDocumentDraft({ draftId: input.draftId, access: input.access });
  if (draft.grantId !== input.grantId) {
    throw new ChatSessionError("draft_grant_mismatch", "현재 공고와 지원서가 일치하지 않습니다.", 404);
  }
  if (input.field.fieldId && input.field.fieldAgent) {
    const run = await requestFieldAgentSuggestions({
      draftId: input.draftId,
      fieldId: input.field.fieldId,
      clientRequestId: input.field.fieldAgent.clientRequestId,
      baseRevisionId: input.field.fieldAgent.baseRevisionId,
      target: input.field.fieldAgent.target,
      access: input.access,
      ...(!isInitialFieldQuestion(input.userMessage, input.field.label)
        ? { sourceText: input.userMessage }
        : {}),
    });
    const suggestion = run.suggestions.find((entry) => entry.status === "pending");
    if (suggestion) {
      return {
        status: "proposal",
        fieldId: run.fieldId,
        label: run.fieldLabel,
        guidance: "현재 문서 revision과 정확한 입력 칸에 결속된 초안입니다. 적용하면 왼쪽 문서에 바로 반영됩니다.",
        proposal: {
          value: suggestion.value,
          basis: suggestion.rationale,
          basisKind: evidenceBasisKind(suggestion.evidence),
          runId: run.id,
          suggestionId: suggestion.id,
        },
      };
    }
    return {
      status: "needs_input",
      fieldId: run.fieldId,
      label: run.fieldLabel,
      guidance: "현재 문서와 확인 가능한 근거만으로는 이 칸의 값을 안전하게 확정할 수 없습니다.",
      questions: [
        `'${run.fieldLabel}'에 넣을 실제 경험이나 성과를 알려주세요.`,
        "수치, 기간, 본인의 역할 중 확인 가능한 내용이 있나요?",
      ],
    };
  }
  const result = await generateFieldSuggestions({
    draftId: input.draftId,
    access: input.access,
    labels: [input.field.label],
    mode: "generate",
    ...(!isInitialFieldQuestion(input.userMessage, input.field.label)
      ? { userEvidenceText: input.userMessage }
      : {}),
  });
  const suggestion = result.suggestions[input.field.label];
  const fieldId = input.field.fieldId?.trim() || `label:${input.field.label}`;
  if (suggestion) {
    return {
      status: "proposal",
      fieldId,
      label: input.field.label,
      guidance: "공고와 저장된 회사 정보를 근거로 만든 초안입니다. 사실과 표현을 확인한 뒤 반영해 주세요.",
      proposal: {
        value: suggestion.value,
        basis: suggestion.basis,
        basisKind: suggestion.basisKind ?? "announcement",
      },
    };
  }
  return {
    status: "needs_input",
    fieldId,
    label: input.field.label,
    guidance: "공고와 저장된 회사 정보만으로는 이 칸의 값을 안전하게 확정할 수 없습니다.",
    questions: [
      `'${input.field.label}'에 넣을 회사의 실제 사실이나 수치를 알려주세요.`,
      "어느 기준 시점과 단위로 작성해야 하는지도 알고 있나요?",
    ],
  };
}

function evidenceBasisKind(
  evidence: readonly Record<string, unknown>[],
): "announcement" | "profile" | "user" {
  const kind = evidence.find((entry) => (
    entry.kind === "announcement" || entry.kind === "profile" || entry.kind === "user"
  ))?.kind;
  return kind === "announcement" || kind === "profile" || kind === "user" ? kind : "user";
}

function isInitialFieldQuestion(message: string, label: string): boolean {
  return message.trim() === `'${label}' 항목은 어떤 내용을 어떻게 작성해야 하나요? 공고 기준으로 알려주세요.`;
}
