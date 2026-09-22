/**
 * P4의 공고 단위 준비도 계약이다.
 *
 * 이 모듈은 DB, 파일 시스템, 네트워크, 모델을 호출하지 않는다. 기존 공고 조사와 신규
 * ingestion은 각각 현재 source/analysis/question 행을 이 입력으로 정규화해서 같은
 * 판정을 사용한다. `question.reviewed`는 draft가 아니라 기존 검수·발행 경로를 통과한
 * 질문일 때만 true로 제공해야 한다.
 */
export const GRANT_PRODUCT_READINESS_SCHEMA = "grant-product-readiness-v1" as const;
export const CONFIRMATION_EVALUATION_V2 = "confirmation-evaluation-v2" as const;

export type GrantReadinessCategory = "A" | "B" | "C" | "D";

export type GrantReadinessBlocker =
  | "source_missing"
  | "source_revision_missing"
  | "source_raw_missing"
  | "source_revision_changed"
  | "source_raw_changed"
  | "attachments_missing"
  | "attachment_manifest_missing"
  | "attachment_manifest_changed"
  | "analysis_missing"
  | "analysis_source_binding_missing"
  | "analysis_attachment_binding_missing"
  | "criteria_structure_incomplete"
  | "criteria_review_incomplete"
  | "eligible_question_key_missing"
  | "eligible_question_missing"
  | "active_question_invalidated"
  | "active_question_v2_missing"
  | "active_question_unreviewed"
  | "active_question_source_stale";

export interface GrantReadinessInput {
  /** 식별자는 집계·목록 adapter가 붙일 수 있는 관측용 값이며 판정에는 쓰지 않는다. */
  readonly grantId?: string;
  readonly source: {
    readonly availability: "available" | "missing";
    /** 수집 시각만 달라진 재수집은 freshness를 바꾸지 않는다. */
    readonly collectedAt?: string | null;
    readonly revisionSha256: string | null;
    readonly rawSha256: string | null;
    /** raw 관측값을 제외한 공고·첨부 projection. source rebind admission에서만 사용한다. */
    readonly materialRevisionSha256?: string | null;
    readonly attachmentStatus: "not_required" | "complete" | "missing";
    readonly attachmentManifestSha256: string | null;
  };
  readonly analysis: {
    readonly status: "present" | "missing";
    readonly sourceRevisionSha256: string | null;
    readonly sourceRawSha256: string | null;
    readonly attachmentManifestSha256: string | null;
    readonly structure: "complete" | "incomplete";
    readonly criteriaReview: "reviewed" | "incomplete";
    /** 검수된 criterion 중 실제 자가신고 질문이 필요한 stable key만 넣는다. */
    readonly eligibleQuestionCriterionStableKeys: readonly string[];
  };
  readonly questions: readonly {
    readonly criterionStableKey: string | null;
    readonly evaluationContractVersion: string | null;
    readonly reviewed: boolean;
    readonly invalidated: boolean;
    readonly sourceRevisionSha256: string | null;
    readonly sourceRawSha256: string | null;
  }[];
}

export interface GrantReadiness {
  readonly schema: typeof GRANT_PRODUCT_READINESS_SCHEMA;
  /** A/B/C/D 중 정확히 하나만 선택한다. */
  readonly category: GrantReadinessCategory;
  /** category를 바꾸지 않는 동시 원인을 포함해 코드순으로 반환한다. */
  readonly blockerCodes: readonly GrantReadinessBlocker[];
  readonly eligibleQuestionCount: number;
  readonly eligibleQuestionCoveredCount: number;
}

export interface GrantReadinessSummary {
  readonly total: number;
  readonly categories: Readonly<Record<GrantReadinessCategory, number>>;
  readonly blockerCounts: Readonly<Partial<Record<GrantReadinessBlocker, number>>>;
}

const D_BLOCKERS = new Set<GrantReadinessBlocker>([
  "source_missing",
  "source_revision_missing",
  "source_raw_missing",
  "source_revision_changed",
  "source_raw_changed",
  "attachments_missing",
  "attachment_manifest_changed",
  "analysis_missing",
]);

const C_BLOCKERS = new Set<GrantReadinessBlocker>([
  "analysis_source_binding_missing",
  "analysis_attachment_binding_missing",
  "attachment_manifest_missing",
  "criteria_structure_incomplete",
  "criteria_review_incomplete",
  "eligible_question_key_missing",
]);

/** D(원문/분석) → C(구조·검수) → B(질문) → A 순서로 fail-closed 분류한다. */
export function classifyGrantReadiness(input: GrantReadinessInput): GrantReadiness {
  const blockers = new Set<GrantReadinessBlocker>();
  const source = input.source;
  const analysis = input.analysis;

  if (source.availability === "missing") {
    blockers.add("source_missing");
  } else {
    if (!nonEmpty(source.revisionSha256)) blockers.add("source_revision_missing");
    if (!nonEmpty(source.rawSha256)) blockers.add("source_raw_missing");
    if (source.attachmentStatus === "missing") blockers.add("attachments_missing");
    if (source.attachmentStatus === "complete" && !nonEmpty(source.attachmentManifestSha256)) {
      blockers.add("attachment_manifest_missing");
    }
  }

  if (analysis.status === "missing") {
    blockers.add("analysis_missing");
  } else if (source.availability === "available") {
    addSourceBindingBlockers(source, analysis, blockers);
    if (analysis.structure === "incomplete") blockers.add("criteria_structure_incomplete");
    if (analysis.criteriaReview === "incomplete") blockers.add("criteria_review_incomplete");
  }

  const expectedKeys = uniqueNonEmpty(analysis.eligibleQuestionCriterionStableKeys);
  if (analysis.eligibleQuestionCriterionStableKeys.some((key) => !nonEmpty(key))) {
    blockers.add("eligible_question_key_missing");
  }
  const coveredKeys = new Set<string>();
  for (const key of expectedKeys) {
    if (questionCoversKey(input.questions, key, source)) {
      coveredKeys.add(key);
    } else {
      addQuestionBlockers(input.questions, key, source, blockers);
    }
  }

  return Object.freeze({
    schema: GRANT_PRODUCT_READINESS_SCHEMA,
    category: categoryFor(blockers),
    blockerCodes: Object.freeze([...blockers].sort()),
    eligibleQuestionCount: expectedKeys.length,
    eligibleQuestionCoveredCount: coveredKeys.size,
  });
}

/** 목록 전체를 DB pagination 이전에 분류한 adapter가 합계를 만들 때 사용한다. */
export function summarizeGrantReadiness(inputs: readonly GrantReadinessInput[]): GrantReadinessSummary {
  const categories: Record<GrantReadinessCategory, number> = { A: 0, B: 0, C: 0, D: 0 };
  const blockerCounts: Partial<Record<GrantReadinessBlocker, number>> = {};
  for (const input of inputs) {
    const readiness = classifyGrantReadiness(input);
    categories[readiness.category] += 1;
    for (const blocker of readiness.blockerCodes) {
      blockerCounts[blocker] = (blockerCounts[blocker] ?? 0) + 1;
    }
  }
  return Object.freeze({
    total: inputs.length,
    categories: Object.freeze(categories),
    blockerCounts: Object.freeze(blockerCounts),
  });
}

function addSourceBindingBlockers(
  source: GrantReadinessInput["source"],
  analysis: GrantReadinessInput["analysis"],
  blockers: Set<GrantReadinessBlocker>,
): void {
  if (nonEmpty(source.revisionSha256) && !nonEmpty(analysis.sourceRevisionSha256)) {
    blockers.add("analysis_source_binding_missing");
  } else if (nonEmpty(source.revisionSha256) && analysis.sourceRevisionSha256 !== source.revisionSha256) {
    blockers.add("source_revision_changed");
  }
  if (nonEmpty(source.rawSha256) && analysis.sourceRawSha256 !== source.rawSha256) {
    blockers.add("source_raw_changed");
  }
  if (source.attachmentStatus === "complete" && nonEmpty(source.attachmentManifestSha256)
    && !nonEmpty(analysis.attachmentManifestSha256)) {
    blockers.add("analysis_attachment_binding_missing");
  } else if (source.attachmentStatus === "complete" && nonEmpty(source.attachmentManifestSha256)
    && analysis.attachmentManifestSha256 !== source.attachmentManifestSha256) {
    blockers.add("attachment_manifest_changed");
  }
  if (source.attachmentStatus === "not_required" && analysis.attachmentManifestSha256 !== null) {
    blockers.add("attachment_manifest_changed");
  }
}

function questionCoversKey(
  questions: GrantReadinessInput["questions"],
  key: string,
  source: GrantReadinessInput["source"],
): boolean {
  return questions.some((question) => question.criterionStableKey === key
    && !question.invalidated
    && question.reviewed
    && question.evaluationContractVersion === CONFIRMATION_EVALUATION_V2
    && question.sourceRevisionSha256 === source.revisionSha256
    && question.sourceRawSha256 === source.rawSha256);
}

function addQuestionBlockers(
  questions: GrantReadinessInput["questions"],
  key: string,
  source: GrantReadinessInput["source"],
  blockers: Set<GrantReadinessBlocker>,
): void {
  const candidates = questions.filter((question) => question.criterionStableKey === key);
  if (candidates.length === 0) {
    blockers.add("eligible_question_missing");
    return;
  }
  if (candidates.every((question) => question.invalidated)) blockers.add("active_question_invalidated");
  if (candidates.every((question) => question.evaluationContractVersion !== CONFIRMATION_EVALUATION_V2)) {
    blockers.add("active_question_v2_missing");
  }
  if (candidates.every((question) => !question.reviewed)) blockers.add("active_question_unreviewed");
  if (candidates.every((question) => question.sourceRevisionSha256 !== source.revisionSha256
    || question.sourceRawSha256 !== source.rawSha256)) {
    blockers.add("active_question_source_stale");
  }
  blockers.add("eligible_question_missing");
}

function categoryFor(blockers: ReadonlySet<GrantReadinessBlocker>): GrantReadinessCategory {
  if ([...blockers].some((blocker) => D_BLOCKERS.has(blocker))) return "D";
  if ([...blockers].some((blocker) => C_BLOCKERS.has(blocker))) return "C";
  if (blockers.size > 0) return "B";
  return "A";
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.filter(nonEmpty))].sort();
}

function nonEmpty(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
