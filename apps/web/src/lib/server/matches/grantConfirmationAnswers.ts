import type {
  CriterionKind,
  GrantConfirmationAnswerDto,
  GrantConfirmationEvaluation,
  GrantConfirmationQuestionDto,
} from "@cunote/contracts";

export const CONFIRMATION_EVALUATION_CONTRACT_VERSION = "confirmation-evaluation-v2" as const;

/**
 * 자가신고 확인 답변 검증·판정 스냅샷 계산(확인 루프 Phase B) — DB 를 모르는 순수 로직.
 * PUT 라우트가 질문 행을 로드해 이 함수로 검증하고, 통과분만 upsert 한다.
 */

/** grant_confirmation_questions 행의 검증에 필요한 부분. options 는 jsonb 원본을 정규화한 것. */
export interface ConfirmationQuestionRecord {
  id: string;
  answerType: "single" | "multi";
  options: ConfirmationOptionRecord[];
  kind: CriterionKind;
  binding?: ConfirmationQuestionBinding;
}

export interface ConfirmationOptionRecord {
  value: string;
  label: string;
  /** 선택 시 결격에 해당하는 선택지인지(판정 스냅샷 계산에만 사용, DTO 로는 내리지 않는다). */
  disqualifies?: boolean;
  /** v2 criterion 자격 의미 기준. 문구나 value에서 추정하지 않는다. */
  evaluation?: GrantConfirmationEvaluation;
}

export interface ConfirmationQuestionBinding {
  contractVersion: typeof CONFIRMATION_EVALUATION_CONTRACT_VERSION;
  criterionId: string;
  sourceRevisionSha256: string;
  sourceRawSha256: string;
  definitionSha256: string;
  questionVersion: number;
}

export interface ConfirmationAnswerInput {
  questionId: string;
  values: string[];
  binding?: ConfirmationQuestionBinding;
  expectedAnswerRevision?: number;
}

export interface ValidatedConfirmationAnswer {
  questionId: string;
  values: string[];
  /** 신규 질문은 명시 3상태, legacy exclusion은 이 필드가 없다. */
  evaluation?: GrantConfirmationEvaluation;
  binding?: ConfirmationQuestionBinding;
  expectedAnswerRevision?: number;
  /** legacy reader용 스냅샷. v2 anchor는 구 reader에서 보이지 않는다. */
  disqualified: boolean;
}

export type ConfirmationAnswersValidation =
  | { ok: true; answers: ValidatedConfirmationAnswer[] }
  | { ok: false; code: string; message: string };

/**
 * jsonb options 원본을 검증 가능한 레코드로 정규화한다. value/label 이 문자열이 아닌 항목은
 * 버린다(B-4 승격 파이프라인 산출물 오염 방지 — 남은 옵션만으로 부분집합 검증).
 */
export function normalizeConfirmationOptions(
  raw: unknown,
  contractVersion?: string | null,
): ConfirmationOptionRecord[] {
  if (!Array.isArray(raw)) return [];
  const options: ConfirmationOptionRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.value !== "string" || candidate.value.length === 0) continue;
    if (typeof candidate.label !== "string" || candidate.label.length === 0) continue;
    if (contractVersion === CONFIRMATION_EVALUATION_CONTRACT_VERSION) {
      if (!isConfirmationEvaluation(candidate.evaluation)) continue;
      options.push({
        value: candidate.value,
        label: candidate.label,
        evaluation: candidate.evaluation,
      });
      continue;
    }
    // 역사 계약만 missing disqualifies=false를 허용한다. 신규 v2는 위에서 누락을 드롭한다.
    options.push({
      value: candidate.value,
      label: candidate.label,
      disqualifies: candidate.disqualifies === true,
    });
  }
  return options;
}

/** answer_type 원본 정규화 — "multi" 외 값은 전부 single 로 본다(보수적 기본값). */
export function normalizeConfirmationAnswerType(raw: unknown): "single" | "multi" {
  return raw === "multi" ? "multi" : "single";
}

/**
 * 제출 답변을 질문 집합에 대해 검증하고 disqualified 스냅샷을 계산한다.
 *   - questionId 는 해당 공고 질문에 속해야 하며 중복 제출 불가
 *   - values 는 옵션 value 집합의 부분집합, 중복 없음, 1개 이상(빈 답변은 제출이 아니라 건너뛰기)
 *   - single 은 정확히 1개
 */
export function validateConfirmationAnswers(input: {
  questions: readonly ConfirmationQuestionRecord[];
  answers: readonly ConfirmationAnswerInput[];
}): ConfirmationAnswersValidation {
  if (input.answers.length === 0) {
    return { ok: false, code: "confirmation_answers_empty", message: "저장할 답변이 없습니다." };
  }
  const questionsById = new Map(input.questions.map((question) => [question.id, question]));
  const seen = new Set<string>();
  const validated: ValidatedConfirmationAnswer[] = [];

  for (const answer of input.answers) {
    const question = questionsById.get(answer.questionId);
    if (!question) {
      return {
        ok: false,
        code: "confirmation_question_not_found",
        message: "이 공고의 확인 질문이 아닙니다.",
      };
    }
    if (seen.has(answer.questionId)) {
      return {
        ok: false,
        code: "confirmation_answer_duplicated",
        message: "같은 질문에 대한 답변이 중복됐습니다.",
      };
    }
    seen.add(answer.questionId);

    if (question.binding) {
      if (!answer.binding || !sameConfirmationBinding(answer.binding, question.binding)) {
        return {
          ok: false,
          code: "confirmation_question_stale",
          message: "질문이나 공고 원문이 변경되었습니다. 다시 확인해 주세요.",
        };
      }
      if (question.answerType !== "single") {
        return {
          ok: false,
          code: "confirmation_evaluation_multi_unsupported",
          message: "이 질문의 복수 선택 평가 규칙을 확인할 수 없습니다.",
        };
      }
      if (!Number.isInteger(answer.expectedAnswerRevision) || answer.expectedAnswerRevision! < 0) {
        return {
          ok: false,
          code: "confirmation_answer_revision_required",
          message: "최신 답변 버전을 다시 불러와 주세요.",
        };
      }
    } else if (answer.binding) {
      return {
        ok: false,
        code: "confirmation_question_binding_unexpected",
        message: "이 질문에는 신규 평가 결속을 사용할 수 없습니다.",
      };
    }

    if (!Array.isArray(answer.values) || answer.values.length === 0) {
      return {
        ok: false,
        code: "confirmation_values_empty",
        message: "선택지를 한 개 이상 선택해 주세요.",
      };
    }
    if (question.answerType === "single" && answer.values.length !== 1) {
      return {
        ok: false,
        code: "confirmation_single_choice_violated",
        message: "이 질문은 한 개의 선택지만 고를 수 있습니다.",
      };
    }
    const optionValues = new Set(question.options.map((option) => option.value));
    const chosen = new Set<string>();
    for (const value of answer.values) {
      if (typeof value !== "string" || !optionValues.has(value)) {
        return {
          ok: false,
          code: "confirmation_value_not_in_options",
          message: "질문 선택지에 없는 값입니다.",
        };
      }
      if (chosen.has(value)) {
        return {
          ok: false,
          code: "confirmation_value_duplicated",
          message: "같은 선택지를 중복해서 보낼 수 없습니다.",
        };
      }
      chosen.add(value);
    }

    if (question.binding) {
      const selected = question.options.find((option) => chosen.has(option.value));
      if (!selected || !isConfirmationEvaluation(selected.evaluation)) {
        return {
          ok: false,
          code: "confirmation_option_evaluation_missing",
          message: "선택지의 평가 의미를 확인할 수 없습니다.",
        };
      }
      validated.push({
        questionId: answer.questionId,
        values: [...chosen],
        evaluation: selected.evaluation,
        binding: question.binding,
        expectedAnswerRevision: answer.expectedAnswerRevision!,
        // 구 reader는 v2 질문 anchor를 읽지 않는다. 필드는 스키마 호환만 위해 기록한다.
        disqualified: selected.evaluation === "unsatisfied",
      });
      continue;
    }
    if (question.kind !== "exclusion") {
      return {
        ok: false,
        code: "confirmation_legacy_kind_unsupported",
        message: "기존 형식 답변은 제외 조건에만 사용할 수 있습니다.",
      };
    }
    const disqualified = question.options.some(
      (option) => chosen.has(option.value) && option.disqualifies === true,
    );
    validated.push({ questionId: answer.questionId, values: [...chosen], disqualified });
  }

  return { ok: true, answers: validated };
}

/** 질문 레코드를 DTO 로 투영한다 — 결격 극성은 제외(중립 제시). */
export function toConfirmationQuestionDto(
  record: ConfirmationQuestionRecord & { prompt: string },
): GrantConfirmationQuestionDto {
  return {
    id: record.id,
    prompt: record.prompt,
    answerType: record.answerType,
    options: record.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.evaluation === "unknown" ? { isUnknown: true } : {}),
    })),
    ...(record.binding ? { binding: record.binding } : {}),
  };
}

/** 저장 행의 answer jsonb({ values })에서 값 배열을 복원한다. 오염 시 빈 배열. */
export function readAnswerValues(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const values = (raw as Record<string, unknown>).values;
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string");
}

export function toConfirmationAnswerDto(row: {
  questionId: string;
  answer: unknown;
  disqualified: boolean;
  evaluation?: string | null;
  answerRevision?: number;
  answeredAt: Date;
}): GrantConfirmationAnswerDto {
  const evaluation = isConfirmationEvaluation(row.evaluation) ? row.evaluation : null;
  return {
    questionId: row.questionId,
    values: readAnswerValues(row.answer),
    ...(evaluation ? { evaluation, answerRevision: row.answerRevision ?? 1 } : {
      disqualified: row.disqualified,
    }),
    answeredAt: row.answeredAt.toISOString(),
  };
}

export function isConfirmationEvaluation(value: unknown): value is GrantConfirmationEvaluation {
  return value === "satisfied" || value === "unsatisfied" || value === "unknown";
}

export function sameConfirmationBinding(
  left: ConfirmationQuestionBinding,
  right: ConfirmationQuestionBinding,
): boolean {
  return left.contractVersion === right.contractVersion
    && left.criterionId === right.criterionId
    && left.sourceRevisionSha256 === right.sourceRevisionSha256
    && left.sourceRawSha256 === right.sourceRawSha256
    && left.definitionSha256 === right.definitionSha256
    && left.questionVersion === right.questionVersion;
}
