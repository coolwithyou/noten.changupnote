import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import { answerKey } from "./fieldAnswerState";
import { workspaceFieldState } from "./workspacePresentation";

export type DocumentAuthoringMode = "quick" | "studio" | "none";

export type DocumentTaskKind =
  | "atomic_text"
  | "choice"
  | "assisted_longform"
  | "repeating_table"
  | "free_layout_region"
  | "attachment_or_stamp"
  | "readonly";

export interface DocumentAuthoringTask {
  taskKey: string;
  fieldId: string;
  label: string;
  mode: DocumentAuthoringMode;
  kind: DocumentTaskKind;
  required: boolean;
  reason: string;
  source: "structure" | "rule";
  field: ConnectedDocumentField;
}

export type StudioTaskStatus = "unstarted" | "edited" | "confirmed" | "not_applicable" | "later";
export type StudioTaskStates = Record<string, StudioTaskStatus>;

const ATTACHMENT_OR_STAMP = /(서명|날인|인감|직인|도장|첨부(?:파일|서류)?|증빙(?:파일|서류)?)/u;
const REPEATING_OR_STRUCTURED = /(?:경력\s*사항|기술\s*\/\s*자격증|자격증.*입상|입상\s*실적|특허.*현황|관련\s*기술\s*현황|재무\s*현황|주요\s*연혁|참여\s*인력|인력\s*현황|과제\s*추진\s*일정|세부\s*추진\s*계획)/u;
const CHOICE_TYPE = /^(?:checkbox|radio|select)$/u;

export function classifyDocumentAuthoringTask(field: ConnectedDocumentField): DocumentAuthoringTask {
  const label = `${field.label} ${field.section ?? ""} ${field.sourceSpan ?? ""}`.normalize("NFKC");
  const fieldType = field.fieldType.trim().toLocaleLowerCase("en-US");
  const fillStrategy = field.fillStrategy.trim().toLocaleLowerCase("en-US");
  const manualObjectKey = /(?:^|[._-])(?:signature|stamp|seal|attachment)(?:$|[._-])/u.test(field.fieldKey);

  if (fieldType === "file" || ATTACHMENT_OR_STAMP.test(label) || (fillStrategy === "manual" && manualObjectKey)) {
    return task(field, "studio", "attachment_or_stamp", "서명·날인·첨부처럼 원본 문서에서 직접 확인해야 하는 항목이에요.", "structure");
  }
  if (fieldType === "table" || REPEATING_OR_STRUCTURED.test(label)) {
    return task(field, "studio", "repeating_table", "여러 행과 열의 관계를 유지해야 하는 표라서 문서에서 직접 작성해요.", "structure");
  }
  if (CHOICE_TYPE.test(fieldType)) {
    return task(field, "quick", "choice", "원본 선택지 중 하나를 골라 바로 반영할 수 있어요.", "structure");
  }
  if (fieldType === "long_text") {
    return task(field, "quick", "assisted_longform", "작성 도우미의 제안과 질문을 이용해 문장으로 작성할 수 있어요.", "rule");
  }
  return task(field, "quick", "atomic_text", "한 개의 값으로 확인하고 바로 채울 수 있는 항목이에요.", "rule");
}

function task(
  field: ConnectedDocumentField,
  mode: DocumentAuthoringMode,
  kind: DocumentTaskKind,
  reason: string,
  source: DocumentAuthoringTask["source"],
): DocumentAuthoringTask {
  return {
    taskKey: field.fieldId,
    fieldId: field.fieldId,
    label: field.label,
    mode,
    kind,
    required: field.required,
    reason,
    source,
    field,
  };
}

export function buildDocumentAuthoringTasks(fields: readonly ConnectedDocumentField[]): DocumentAuthoringTask[] {
  return fields.map(classifyDocumentAuthoringTask);
}

export function isStudioTaskComplete(status: StudioTaskStatus | undefined): boolean {
  return status === "confirmed" || status === "not_applicable";
}

export function isAuthoringTaskComplete(input: {
  task: DocumentAuthoringTask;
  answers: DraftFieldAnswers;
  studioTaskStates: StudioTaskStates;
  pendingLabels?: ReadonlySet<string>;
}): boolean {
  if (input.task.mode === "studio") return isStudioTaskComplete(input.studioTaskStates[input.task.fieldId]);
  const key = answerKey(input.task.label);
  if (input.pendingLabels?.has(key)) return false;
  return workspaceFieldState(input.answers[key]) === "filled";
}

export function computeAuthoringProgress(input: {
  tasks: readonly DocumentAuthoringTask[];
  answers: DraftFieldAnswers;
  studioTaskStates: StudioTaskStates;
  pendingLabels: ReadonlySet<string>;
}): { total: number; confirmed: number; quick: { total: number; confirmed: number }; studio: { total: number; confirmed: number } } {
  const quick = { total: 0, confirmed: 0 };
  const studio = { total: 0, confirmed: 0 };
  for (const task of input.tasks) {
    if (task.mode === "none") continue;
    const bucket = task.mode === "studio" ? studio : quick;
    bucket.total += 1;
    if (isAuthoringTaskComplete({ ...input, task })) bucket.confirmed += 1;
  }
  return {
    total: quick.total + studio.total,
    confirmed: quick.confirmed + studio.confirmed,
    quick,
    studio,
  };
}

export function nextIncompleteTask(input: {
  tasks: readonly DocumentAuthoringTask[];
  afterFieldId?: string | null;
  answers: DraftFieldAnswers;
  studioTaskStates: StudioTaskStates;
}): DocumentAuthoringTask | undefined {
  const start = input.tasks.findIndex((task) => task.fieldId === input.afterFieldId);
  const ordered = start >= 0
    ? input.tasks.slice(start + 1).concat(input.tasks.slice(0, start + 1))
    : [...input.tasks];
  return ordered.find((task) => !isAuthoringTaskComplete({
    task,
    answers: input.answers,
    studioTaskStates: input.studioTaskStates,
  }));
}
