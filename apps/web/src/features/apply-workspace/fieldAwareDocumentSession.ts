import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import { answerKey } from "./fieldAnswerState";
import type { DocumentAuthoringTask } from "./documentAuthoring";
import { workspaceFieldState, type WorkspaceFieldState } from "./workspacePresentation";
import type { StudioFieldTargetV1 } from "@/lib/rhwp/studioDocumentAgentProtocol";

export type FieldBindingStatus = "resolving" | "unique" | "missing" | "ambiguous";
export type FieldAssistAvailability =
  | "ready"
  | "rollout_off"
  | "binding_resolving"
  | "binding_missing"
  | "binding_ambiguous"
  | "unsupported_kind"
  | "not_suggestable";

export interface FieldAwareSessionItem {
  fieldId: string;
  label: string;
  section: string | null;
  required: boolean;
  kind: DocumentAuthoringTask["kind"];
  state: WorkspaceFieldState;
  value: string | null;
  basis: string | null;
  bindingStatus: FieldBindingStatus;
  assistAvailability: FieldAssistAvailability;
  isSelected: boolean;
  isSuggesting: boolean;
  canRequestSuggestion: boolean;
}

export interface FieldAwareDocumentSessionView {
  fields: FieldAwareSessionItem[];
  selected: FieldAwareSessionItem | null;
  boundCount: number;
  totalCount: number;
}

/** 객체 identity가 아닌 strict 좌표로 Studio selection과 서버 확정 binding을 연결한다. */
export function fieldSelectionTargetKey(target: StudioFieldTargetV1): string {
  if (target.kind === "form_text") {
    return [target.kind, target.section, target.paragraph, target.fieldId].join(":");
  }
  return [
    target.kind,
    target.section,
    target.parentPara,
    target.controlIndex,
    target.cellIndex,
    target.cellParagraph,
  ].join(":");
}

/**
 * Workspace가 답변 저장 방식, task 분류, exact binding, rollout 규칙을 직접 조합하지 않도록
 * 필드 레일이 필요한 읽기 모델을 한 경계에서 만든다. 첫 slice는 atomic text + unique cell만 연다.
 */
export function buildFieldAwareDocumentSession(input: {
  tasks: readonly DocumentAuthoringTask[];
  answers: DraftFieldAnswers;
  selectedFieldId: string | null;
  bindingStatuses: ReadonlyMap<string, Exclude<FieldBindingStatus, "resolving">>;
  bindingsResolved: boolean;
  fieldEditorAgentAvailable: boolean;
  suggestableLabels: ReadonlySet<string>;
  suggestingLabels: ReadonlySet<string>;
}): FieldAwareDocumentSessionView {
  const selectedFieldId = input.tasks.some((task) => task.fieldId === input.selectedFieldId)
    ? input.selectedFieldId
    : input.tasks[0]?.fieldId ?? null;
  const fields = input.tasks.map((task): FieldAwareSessionItem => {
    const key = answerKey(task.label);
    const answer = input.answers[key];
    const bindingStatus = input.bindingsResolved
      ? input.bindingStatuses.get(task.fieldId) ?? "missing"
      : "resolving";
    const assistAvailability = resolveAssistAvailability({
      fieldEditorAgentAvailable: input.fieldEditorAgentAvailable,
      task,
      bindingStatus,
      suggestable: input.suggestableLabels.has(task.label),
    });
    const isSuggesting = input.suggestingLabels.has(key);
    return {
      fieldId: task.fieldId,
      label: task.label,
      section: task.field.section,
      required: task.required,
      kind: task.kind,
      state: workspaceFieldState(answer),
      value: answer?.status === "dismissed" ? null : answer?.value?.trim() || null,
      basis: answer?.basis?.trim() || null,
      bindingStatus,
      assistAvailability,
      isSelected: task.fieldId === selectedFieldId,
      isSuggesting,
      canRequestSuggestion: assistAvailability === "ready" && !isSuggesting,
    };
  });
  return {
    fields,
    selected: fields.find((field) => field.isSelected) ?? null,
    boundCount: fields.filter((field) => field.bindingStatus === "unique").length,
    totalCount: fields.length,
  };
}

function resolveAssistAvailability(input: {
  fieldEditorAgentAvailable: boolean;
  task: DocumentAuthoringTask;
  bindingStatus: FieldBindingStatus;
  suggestable: boolean;
}): FieldAssistAvailability {
  if (!input.fieldEditorAgentAvailable) return "rollout_off";
  if (input.task.kind !== "atomic_text" && input.task.kind !== "choice") return "unsupported_kind";
  if (input.bindingStatus === "resolving") return "binding_resolving";
  if (input.bindingStatus === "missing") return "binding_missing";
  if (input.bindingStatus === "ambiguous") return "binding_ambiguous";
  if (!input.suggestable) return "not_suggestable";
  return "ready";
}
