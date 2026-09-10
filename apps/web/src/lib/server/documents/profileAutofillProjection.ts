import { createHash } from "node:crypto";
import type { DraftFieldAnswers } from "./fieldAnswers";

export class ProfileAutofillProjectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProfileAutofillProjectionError";
  }
}

/**
 * RHWP 자동 입력 snapshot과 draft answer 상태를 같은 DB transaction에서 전진시킨다.
 * 클라이언트가 보낸 값은 현재 suggested/profile seed와 exact fieldId로 다시 검증한다.
 */
export function buildProfileAutofillProjection(input: {
  operation: "apply" | "undo";
  fieldIds: readonly string[];
  currentAnswers: DraftFieldAnswers;
  currentMaterializedAnswers: Readonly<Record<string, string>>;
  requestedMaterializedAnswers: Readonly<Record<string, string>>;
  currentHeadRevisionId: string | null;
  revisionId: string;
  at?: string;
}): { fieldAnswers: DraftFieldAnswers; materializedAnswers: Record<string, string> } {
  const uniqueIds = new Set(input.fieldIds);
  if (uniqueIds.size === 0 || uniqueIds.size !== input.fieldIds.length) {
    throw new ProfileAutofillProjectionError(
      "profile_autofill_fields_invalid",
      "자동 입력할 회사 정보 필드가 비어 있거나 중복되었습니다.",
    );
  }
  if (!sameUntargetedMaterializedAnswers(
    input.currentMaterializedAnswers,
    input.requestedMaterializedAnswers,
    uniqueIds,
  )) {
    throw new ProfileAutofillProjectionError(
      "profile_autofill_materialized_conflict",
      "자동 입력 대상 밖의 문서 답변 상태가 변경되었습니다.",
    );
  }

  const answerEntriesByFieldId = new Map<string, Array<[string, DraftFieldAnswers[string]]>>();
  for (const [label, answer] of Object.entries(input.currentAnswers)) {
    if (!answer?.fieldId || !uniqueIds.has(answer.fieldId)) continue;
    const matches = answerEntriesByFieldId.get(answer.fieldId) ?? [];
    matches.push([label, answer]);
    answerEntriesByFieldId.set(answer.fieldId, matches);
  }

  const nextAnswers: DraftFieldAnswers = { ...input.currentAnswers };
  const nextMaterialized = { ...input.currentMaterializedAnswers };
  const at = input.at ?? new Date().toISOString();
  for (const fieldId of input.fieldIds) {
    const matches = answerEntriesByFieldId.get(fieldId) ?? [];
    if (matches.length !== 1) {
      throw new ProfileAutofillProjectionError(
        "profile_autofill_answer_binding_invalid",
        "회사 정보 답변을 현재 문서 필드 하나에 결속하지 못했습니다.",
      );
    }
    const [label, answer] = matches[0]!;
    if (input.operation === "apply") {
      if (
        answer?.status !== "suggested"
        || answer.source !== "profile"
        || !answer.value.trim()
        || input.currentMaterializedAnswers[fieldId] !== undefined
        || input.requestedMaterializedAnswers[fieldId] !== answer.value
      ) {
        throw new ProfileAutofillProjectionError(
          "profile_autofill_answer_conflict",
          "회사 정보 제안이 바뀌었거나 이미 처리되어 자동 입력하지 않았습니다.",
        );
      }
      nextAnswers[label] = {
        ...answer,
        status: "accepted",
        materializedRevisionId: input.revisionId,
        valueSha256: createHash("sha256").update(answer.value).digest("hex"),
        updatedAt: at,
      };
      nextMaterialized[fieldId] = answer.value;
      continue;
    }

    if (
      answer?.status !== "accepted"
      || answer.source !== "profile"
      || !input.currentHeadRevisionId
      || answer.materializedRevisionId !== input.currentHeadRevisionId
      || input.currentMaterializedAnswers[fieldId] !== answer.value
      || input.requestedMaterializedAnswers[fieldId] !== undefined
    ) {
      throw new ProfileAutofillProjectionError(
        "profile_autofill_undo_conflict",
        "자동 입력 뒤 문서나 답변이 변경되어 되돌리지 않았습니다.",
      );
    }
    const { materializedRevisionId: _revision, valueSha256: _sha256, ...restored } = answer;
    nextAnswers[label] = { ...restored, status: "dismissed", updatedAt: at };
    delete nextMaterialized[fieldId];
  }
  return { fieldAnswers: nextAnswers, materializedAnswers: nextMaterialized };
}

function sameUntargetedMaterializedAnswers(
  current: Readonly<Record<string, string>>,
  requested: Readonly<Record<string, string>>,
  targetIds: ReadonlySet<string>,
): boolean {
  const currentEntries = Object.entries(current).filter(([fieldId]) => !targetIds.has(fieldId));
  const requestedEntries = Object.entries(requested).filter(([fieldId]) => !targetIds.has(fieldId));
  if (currentEntries.length !== requestedEntries.length) return false;
  const requestedMap = new Map(requestedEntries);
  return currentEntries.every(([fieldId, value]) => requestedMap.get(fieldId) === value);
}
