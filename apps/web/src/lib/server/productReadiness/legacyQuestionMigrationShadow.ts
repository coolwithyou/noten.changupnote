import { createHash } from "node:crypto";
import { and, count, countDistinct, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { CriterionDimension, CriterionKind, CriterionOperator, GrantCriterion } from "@cunote/contracts";
import { isNonMatchingApplicationCriterion, isProfileResolvableCriterion } from "@cunote/core";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBindings } from "../deep-analysis/prepareInput";
import {
  matchingQuestionBinding,
} from "../matches/annotateConfirmationQuestions";
import {
  normalizeConfirmationOptions,
} from "../matches/grantConfirmationAnswers";

export const LEGACY_QUESTION_MIGRATION_SHADOW_SCHEMA =
  "legacy-question-migration-shadow-v1" as const;

export type LegacyQuestionMigrationDisposition =
  | "verified_v2"
  | "legacy_review_candidate"
  | "legacy_answer_preservation_review"
  | "legacy_structure_repair"
  | "v2_blocked"
  | "not_applicable";

export type LegacyQuestionShadowDifference =
  | "unchanged"
  | "improvement"
  | "regression"
  | "intentional_change"
  | "unresolved";

export interface LegacyQuestionMigrationShadowInput {
  readonly questionId: string;
  readonly grantId: string;
  readonly criterionId: string | null;
  readonly criterionStableKey: string | null;
  readonly evaluationContractVersion: string | null;
  readonly sourceRevisionSha256: string | null;
  readonly sourceRawSha256: string | null;
  readonly definitionSha256: string;
  readonly answerType: string;
  readonly options: unknown;
  readonly reusable: string;
  readonly conditionKey: string | null;
  readonly provenance: Record<string, unknown>;
  readonly criterion: {
    readonly dimension: CriterionDimension | null;
    readonly kind: CriterionKind | null;
    readonly operator: CriterionOperator | null;
    readonly value: unknown;
    readonly confidence: number | null;
    readonly sourceSpan: string | null;
    readonly needsReview: boolean | null;
  };
  readonly currentSource: {
    readonly sourceRevisionSha256: string;
    readonly sourceRawSha256: string;
  } | null;
  readonly legacyVisible: boolean;
  readonly strictV2Visible: boolean;
  readonly answerCount: number;
  readonly answeringCompanyCount: number;
}

export interface LegacyQuestionMigrationShadowEntry {
  readonly questionId: string;
  readonly grantId: string;
  readonly criterionId: string | null;
  readonly criterionStableKey: string | null;
  readonly criterionDimension: CriterionDimension | null;
  readonly criterionKind: CriterionKind | null;
  readonly criterionOperator: CriterionOperator | null;
  readonly evaluationContractVersion: string | null;
  readonly definitionSha256: string;
  readonly reusable: string;
  readonly disposition: LegacyQuestionMigrationDisposition;
  readonly blockers: readonly string[];
  readonly difference: LegacyQuestionShadowDifference;
  readonly legacyVisible: boolean;
  readonly strictV2Visible: boolean;
  readonly answerCount: number;
  readonly answeringCompanyCount: number;
  readonly currentSourceRevisionSha256: string | null;
  readonly currentSourceRawSha256: string | null;
  readonly automaticMigrationAllowed: false;
}

export interface LegacyQuestionMigrationShadowReport {
  readonly schema: typeof LEGACY_QUESTION_MIGRATION_SHADOW_SCHEMA;
  readonly observedAt: string;
  readonly snapshotSha256: string;
  readonly grantCount: number;
  readonly questionCount: number;
  readonly dispositionCounts: Readonly<Record<LegacyQuestionMigrationDisposition, number>>;
  readonly differenceCounts: Readonly<Record<LegacyQuestionShadowDifference, number>>;
  readonly authority: {
    readonly readOnly: true;
    readonly modelCallsMade: 0;
    readonly databaseWritesMade: 0;
    readonly migrationAuthorized: false;
  };
  readonly entries: readonly LegacyQuestionMigrationShadowEntry[];
}

/** legacy 질문은 의미를 추정 승격하지 않고 exact 검수/수리 대상으로만 분류한다. */
export function classifyLegacyQuestionMigration(
  input: LegacyQuestionMigrationShadowInput,
): LegacyQuestionMigrationShadowEntry {
  const blockers: string[] = [];
  const criterionPresent = hasCriterion(input);
  const applicationOnly = criterionPresent && isNonMatchingApplicationCriterion({
    dimension: input.criterion.dimension,
    kind: input.criterion.kind,
    operator: input.criterion.operator,
    source_span: input.criterion.sourceSpan,
  });
  const profileResolved = criterionPresent && isProfileResolvableCriterion({
    dimension: input.criterion.dimension,
    kind: input.criterion.kind,
    operator: input.criterion.operator,
    value: input.criterion.value as GrantCriterion["value"],
    confidence: input.criterion.confidence,
    source_span: input.criterion.sourceSpan ?? "",
    needs_review: input.criterion.needsReview,
  });
  let disposition: LegacyQuestionMigrationDisposition;

  if (!criterionPresent) {
    disposition = "legacy_structure_repair";
    blockers.push("criterion_anchor_missing");
  } else if (applicationOnly) {
    disposition = "not_applicable";
    blockers.push("application_only_criterion");
  } else if (input.criterion.kind === "preferred") {
    disposition = "not_applicable";
    blockers.push("criterion_not_eligibility_blocking");
  } else if (profileResolved) {
    disposition = "not_applicable";
    blockers.push("resolved_by_company_profile");
  } else if (input.evaluationContractVersion === "confirmation-evaluation-v2") {
    disposition = input.strictV2Visible ? "verified_v2" : "v2_blocked";
    if (!input.strictV2Visible) blockers.push("current_v2_binding_unverified");
  } else if (input.evaluationContractVersion !== null) {
    disposition = "legacy_structure_repair";
    blockers.push("unsupported_evaluation_contract");
  } else {
    validateLegacyRepublishCandidate(input, blockers);
    if (blockers.length > 0) {
      disposition = "legacy_structure_repair";
    } else if (input.answerCount > 0) {
      disposition = "legacy_answer_preservation_review";
      blockers.push("existing_answers_require_semantic_mapping");
    } else {
      disposition = "legacy_review_candidate";
      blockers.push("manual_polarity_and_scope_review_required");
    }
  }

  return Object.freeze({
    questionId: input.questionId,
    grantId: input.grantId,
    criterionId: input.criterionId,
    criterionStableKey: input.criterionStableKey,
    criterionDimension: input.criterion.dimension,
    criterionKind: input.criterion.kind,
    criterionOperator: input.criterion.operator,
    evaluationContractVersion: input.evaluationContractVersion,
    definitionSha256: input.definitionSha256,
    reusable: input.reusable,
    disposition,
    blockers: Object.freeze([...new Set(blockers)].sort()),
    difference: classifyDifference(input, disposition),
    legacyVisible: input.legacyVisible,
    strictV2Visible: input.strictV2Visible,
    answerCount: input.answerCount,
    answeringCompanyCount: input.answeringCompanyCount,
    currentSourceRevisionSha256: input.currentSource?.sourceRevisionSha256 ?? null,
    currentSourceRawSha256: input.currentSource?.sourceRawSha256 ?? null,
    automaticMigrationAllowed: false,
  });
}

export function buildLegacyQuestionMigrationShadowReport(input: {
  readonly observedAt: Date;
  readonly rows: readonly LegacyQuestionMigrationShadowInput[];
}): LegacyQuestionMigrationShadowReport {
  if (!Number.isFinite(input.observedAt.getTime())) throw new Error("observedAt이 올바르지 않습니다.");
  const ids = new Set<string>();
  const entries = input.rows.map(classifyLegacyQuestionMigration)
    .sort((left, right) => left.questionId.localeCompare(right.questionId));
  for (const entry of entries) {
    if (ids.has(entry.questionId)) throw new Error("질문 ID가 중복됐습니다.");
    ids.add(entry.questionId);
  }
  const dispositionCounts = emptyDispositionCounts();
  const differenceCounts = emptyDifferenceCounts();
  for (const entry of entries) {
    dispositionCounts[entry.disposition] += 1;
    differenceCounts[entry.difference] += 1;
  }
  const body = {
    schema: LEGACY_QUESTION_MIGRATION_SHADOW_SCHEMA,
    observedAt: input.observedAt.toISOString(),
    grantCount: new Set(entries.map((entry) => entry.grantId)).size,
    questionCount: entries.length,
    dispositionCounts,
    differenceCounts,
    authority: {
      readOnly: true as const,
      modelCallsMade: 0 as const,
      databaseWritesMade: 0 as const,
      migrationAuthorized: false as const,
    },
    entries,
  };
  return Object.freeze({
    ...body,
    dispositionCounts: Object.freeze(dispositionCounts),
    differenceCounts: Object.freeze(differenceCounts),
    entries: Object.freeze(entries),
    snapshotSha256: sha256(stableJson(body)),
  });
}

/** 현재 지원기간 안의 질문 자산을 repeatable-read 호출자가 넘긴 DB session에서 읽는다. */
export async function loadLegacyQuestionMigrationShadow(input: {
  readonly db: CunoteDbSession;
  readonly asOf?: Date;
  readonly limit?: number;
}): Promise<LegacyQuestionMigrationShadowReport> {
  const asOf = input.asOf ?? new Date();
  const limit = input.limit ?? 20_000;
  if (!Number.isFinite(asOf.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 20_000) {
    throw new Error("asOf 또는 limit을 확인해주세요.");
  }
  const { start, end } = kstDayBounds(asOf);
  const grants = await input.db.select({ id: schema.grants.id })
    .from(schema.grants)
    .where(and(
      eq(schema.grants.status, "open"),
      eq(schema.grants.servingState, "visible"),
      lte(schema.grants.applyStart, end),
      gte(schema.grants.applyEnd, start),
    ))
    .orderBy(desc(schema.grants.updatedAt), desc(schema.grants.id))
    .limit(limit + 1);
  if (grants.length > limit) throw new Error("질문 이관 shadow 상한 초과: 부분 결과를 반환하지 않습니다.");
  const grantIds = grants.map((grant) => grant.id);
  if (grantIds.length === 0) return buildLegacyQuestionMigrationShadowReport({ observedAt: asOf, rows: [] });

  const [questions, answers, servingRows, sourceBindings] = await Promise.all([
    input.db.select({
      questionId: schema.grantConfirmationQuestions.id,
      grantId: schema.grantConfirmationQuestions.grantId,
      criterionId: schema.grantCriteria.id,
      criterionStableKey: schema.grantCriteria.stableKey,
      evaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
      sourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
      sourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
      definitionSha256: schema.grantConfirmationQuestions.definitionSha256,
      answerType: schema.grantConfirmationQuestions.answerType,
      options: schema.grantConfirmationQuestions.options,
      reusable: schema.grantConfirmationQuestions.reusable,
      conditionKey: schema.grantConfirmationQuestions.conditionKey,
      provenance: schema.grantConfirmationQuestions.provenance,
      dimension: schema.grantCriteria.dimension,
      kind: schema.grantCriteria.kind,
      operator: schema.grantCriteria.operator,
      value: schema.grantCriteria.value,
      confidence: schema.grantCriteria.confidence,
      sourceSpan: schema.grantCriteria.sourceSpan,
      needsReview: schema.grantCriteria.needsReview,
    }).from(schema.grantConfirmationQuestions)
      .leftJoin(
        schema.grantCriteria,
        eq(
          schema.grantCriteria.id,
          sql`coalesce(${schema.grantConfirmationQuestions.evaluationCriterionId}, ${schema.grantConfirmationQuestions.grantCriteriaId})`,
        ),
      )
      .where(and(
        inArray(schema.grantConfirmationQuestions.grantId, grantIds),
        isNull(schema.grantConfirmationQuestions.invalidatedAt),
      )),
    input.db.select({
      questionId: schema.companyGrantConfirmations.questionId,
      answerCount: count(),
      companyCount: countDistinct(schema.companyGrantConfirmations.companyId),
    }).from(schema.companyGrantConfirmations)
      .innerJoin(
        schema.grantConfirmationQuestions,
        eq(schema.grantConfirmationQuestions.id, schema.companyGrantConfirmations.questionId),
      )
      .where(inArray(schema.grantConfirmationQuestions.grantId, grantIds))
      .groupBy(schema.companyGrantConfirmations.questionId),
    input.db.select({
      grantId: schema.analysisLabPromotionItems.grantId,
      runId: schema.analysisLabPromotionItems.runId,
    }).from(schema.analysisLabPromotionItems)
      .innerJoin(
        schema.analysisLabPromotionReleases,
        eq(schema.analysisLabPromotionReleases.id, schema.analysisLabPromotionItems.releaseDbId),
      )
      .where(and(
        inArray(schema.analysisLabPromotionItems.grantId, grantIds),
        eq(schema.analysisLabPromotionItems.status, "applied"),
        isNull(schema.analysisLabPromotionItems.rolledBackAt),
        inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
      )),
    loadDeepAnalysisSourceBindings({ db: input.db, grantIds }),
  ]);
  const answerCounts = new Map(answers.map((row) => [row.questionId, {
    answerCount: Number(row.answerCount),
    companyCount: Number(row.companyCount),
  }]));
  const servingRunIds = new Map<string, Set<string>>();
  for (const row of servingRows) {
    const runIds = servingRunIds.get(row.grantId) ?? new Set<string>();
    runIds.add(row.runId);
    servingRunIds.set(row.grantId, runIds);
  }
  const rows = questions.map((question): LegacyQuestionMigrationShadowInput => {
    const currentSource = sourceBindings.get(question.grantId) ?? null;
    const hasCriterion = question.criterionId !== null
      && question.dimension !== null
      && question.kind !== null
      && question.operator !== null;
    const applicationOnly = hasCriterion && isNonMatchingApplicationCriterion({
      dimension: question.dimension!,
      kind: question.kind!,
      operator: question.operator!,
      source_span: question.sourceSpan,
    });
    const strictV2Visible = hasCriterion && matchingQuestionBinding({
      grantId: question.grantId,
      criterionId: question.criterionId!,
      evaluationContractVersion: question.evaluationContractVersion,
      sourceRevisionSha256: question.sourceRevisionSha256,
      sourceRawSha256: question.sourceRawSha256,
      answerType: question.answerType,
      options: question.options,
      reusable: question.reusable,
      provenance: question.provenance,
      needsReview: question.needsReview!,
      sourceSpan: question.sourceSpan,
    }, servingRunIds, sourceBindings) !== null;
    const counts = answerCounts.get(question.questionId);
    return {
      ...question,
      criterion: {
        dimension: question.dimension,
        kind: question.kind,
        operator: question.operator,
        value: question.value,
        confidence: question.confidence,
        sourceSpan: question.sourceSpan,
        needsReview: question.needsReview,
      },
      currentSource,
      legacyVisible: hasCriterion && !applicationOnly && (
        question.evaluationContractVersion === null || strictV2Visible
      ),
      strictV2Visible,
      answerCount: counts?.answerCount ?? 0,
      answeringCompanyCount: counts?.companyCount ?? 0,
    };
  });
  return buildLegacyQuestionMigrationShadowReport({ observedAt: asOf, rows });
}

function validateLegacyRepublishCandidate(
  input: LegacyQuestionMigrationShadowInput,
  blockers: string[],
): void {
  if (!input.criterionStableKey?.trim()) blockers.push("criterion_stable_key_missing");
  if (!input.criterion.sourceSpan?.trim()) blockers.push("criterion_source_span_missing");
  if (input.criterion.needsReview !== false) blockers.push("criterion_review_incomplete");
  if (input.criterion.kind !== "required" && input.criterion.kind !== "exclusion") {
    blockers.push("criterion_not_eligibility_blocking");
  }
  if (
    input.criterion.operator !== "text_only"
    || (input.criterion.dimension !== "other" && input.criterion.dimension !== "industry")
  ) {
    blockers.push("criterion_not_user_confirmation");
  }
  if (!input.currentSource) blockers.push("current_source_binding_missing");
  if (input.answerType !== "single") blockers.push("single_answer_required");
  const options = normalizeConfirmationOptions(input.options, null);
  if (
    !Array.isArray(input.options)
    || options.length !== input.options.length
    || options.length < 2
    || options.length > 4
  ) blockers.push("legacy_options_invalid");
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    blockers.push("legacy_option_values_duplicated");
  }
  if (input.reusable !== "per_notice" && input.reusable !== "company_fact") {
    blockers.push("reusable_scope_invalid");
  }
  if (input.reusable === "company_fact" && !validConditionKey(input.conditionKey)) {
    blockers.push("company_fact_key_invalid");
  }
}

function classifyDifference(
  input: LegacyQuestionMigrationShadowInput,
  disposition: LegacyQuestionMigrationDisposition,
): LegacyQuestionShadowDifference {
  if (input.legacyVisible && input.strictV2Visible) return "unchanged";
  if (!input.legacyVisible && input.strictV2Visible) return "improvement";
  if (input.legacyVisible && !input.strictV2Visible) {
    if (disposition === "not_applicable") return "improvement";
    return input.evaluationContractVersion === null ? "intentional_change" : "regression";
  }
  return disposition === "not_applicable" ? "unchanged" : "unresolved";
}

function hasCriterion(input: LegacyQuestionMigrationShadowInput): input is LegacyQuestionMigrationShadowInput & {
  criterionId: string;
  criterion: {
    dimension: CriterionDimension;
    kind: CriterionKind;
    operator: CriterionOperator;
    value: unknown;
    confidence: number;
    sourceSpan: string | null;
    needsReview: boolean;
  };
} {
  return input.criterionId !== null
    && input.criterion.dimension !== null
    && input.criterion.kind !== null
    && input.criterion.operator !== null
    && input.criterion.confidence !== null
    && input.criterion.needsReview !== null;
}

function validConditionKey(value: string | null): boolean {
  return typeof value === "string" && /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(value.trim());
}

function emptyDispositionCounts(): Record<LegacyQuestionMigrationDisposition, number> {
  return {
    verified_v2: 0,
    legacy_review_candidate: 0,
    legacy_answer_preservation_review: 0,
    legacy_structure_repair: 0,
    v2_blocked: 0,
    not_applicable: 0,
  };
}

function emptyDifferenceCounts(): Record<LegacyQuestionShadowDifference, number> {
  return { unchanged: 0, improvement: 0, regression: 0, intentional_change: 0, unresolved: 0 };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function kstDayBounds(value: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  return {
    start: new Date(`${day}T00:00:00.000+09:00`),
    end: new Date(`${day}T23:59:59.999+09:00`),
  };
}
