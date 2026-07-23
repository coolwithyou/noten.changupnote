// 공모 딥분석 실험실 — 확정 자산 승격 계획 수립 (순수 로직 — DB·fs·네트워크 미사용).
//
// ⚠️ 이 모듈(+promote-cli.ts)은 실험실 "DB 쓰기 0 원칙"의 **의도된 유일한 경계 통과 지점**이다.
// 검수·감사로 확정된 criteria(B)를 프로덕션 grant_criteria 로, 확인 질문(v3 인라인 +
// <runId>.confirmations.json 사이드카)을 grant_confirmation_questions 로 발행한다
// (확인 루프 Phase B-4 — docs/plans/2026-07-23-confirmation-loop-phase-b.md §1).
//
// **기본은 dry-run(발행 계획 출력만)이다.** 실쓰기는 프로토콜 게이트(잔여 48항목 사람 감사 →
// aggregate GO → lab:shadow 긍정) 통과 후 --write --confirm-go 두 플래그를 모두 지정해야만
// 열린다 — 하나라도 없으면 경고와 함께 dry-run 으로 강등된다(resolvePromotionMode).
//
// 재사용 계약(재구현 금지):
//   - 변환: shadow-convert 의 convertReviewedLabRun — 검수 correct criterion 만
//     normalizeGrantLlmCriteria(needs_review=false)로 변환. "golden_set 승격 발행 어댑터로
//     재사용"이 설계 의도였다(섀도 계획 2026-07-22 §3). 변환 손실(강등·탈락)은 무은폐.
//   - 질문 병합: confirmations 의 mergeConfirmationsIntoRun — v3 인라인 우선 + 사이드카 보강,
//     criterionIndex 범위 밖·비 exclusion 드롭까지 기존 규칙 그대로.
//   - 대상 선정: 사람 review 보유 런 + 감사 완료 병합 런, grantId 중복 시 사람 우선
//     (confirmations-cli 와 동일 규칙 — dedupePromotionSources 로 순수화).
// 쓰기 경로(per-grant 트랜잭션·Drizzle 포트)는 promote-cli.ts 에 있고, 이 모듈은 주입
// 가능한 포트 인터페이스(PromotionWritePort)와 실행 오케스트레이션만 정의한다(테스트는 페이크).
import { createHash } from "node:crypto";
import type { GrantCriterion } from "@cunote/contracts";
import type {
  LabAudit,
  LabConfirmationOption,
  LabConfirmationReusable,
  LabReview,
  LabRun,
} from "@/features/dev/analysis-lab/contract";
import type { AiCriterionReviewSnapshot } from "./criterion-resolution";
import type { HumanReviewOverlay } from "./human-review-overlay";
import {
  CONFIRMATIONS_PROMPT_VERSION,
  mergeConfirmationsIntoRun,
  type LabConfirmationsFile,
} from "./confirmations";
import {
  criterionNeedsReview,
  publishesConfirmationQuestion,
  publishesCriterion,
  resolveCriterionStates,
  type CriterionResolution,
  type CriterionResolutionState,
} from "./criterion-resolution";
import { convertSelectedLabCriteria, type ShadowConversionReport } from "./shadow-convert";

// ---- 대상 선정 (사람 우선 dedupe — confirmations-cli 규칙의 순수화) -------------------

/** 검수 확정의 출처 — 사람 전수 검수(human) / AI 검수 + 감사 완료 병합(audited). */
export type PromotionOrigin = "human" | "audited" | "pending";

/**
 * 질문 provenance 의 감사 상태 — 스키마 계약(B-4 계획 §2).
 * 감사 병합 런은 개별 항목의 확정 주체(사람 감사 vs AI 블라인드 일치)가 병합 후 구분되지
 * 않으므로 런 단위 출처로 기록한다(항목 단위 세분화는 후속 — provenance 무결성 우선).
 */
export type PromotionAuditState = "human_reviewed" | "ai_audit_concur" | "mixed_resolution";

export interface PromotionSource {
  run: LabRun;
  review?: LabReview;
  aiReview?: AiCriterionReviewSnapshot;
  audit?: LabAudit | null;
  overlay?: HumanReviewOverlay | null;
  origin: PromotionOrigin;
}

/**
 * 사람 검수 런 + 감사 확정 병합 런을 grantId 로 합친다 — 중복 시 **사람 우선**
 * (confirmations-cli 와 동일: 구조상 겹치지 않지만 로더 규칙 변경에 대비한 방어).
 * 출력은 grantId 정렬 — 계획 출력·발행 순서의 재현성.
 */
export function dedupePromotionSources(
  human: Array<{ run: LabRun; review: LabReview }>,
  audited: Array<{ run: LabRun; review: LabReview }>,
): PromotionSource[] {
  const byGrant = new Map<string, PromotionSource>();
  for (const item of human) {
    byGrant.set(item.run.grantId, { run: item.run, review: item.review, origin: "human" });
  }
  for (const item of audited) {
    if (!byGrant.has(item.run.grantId)) {
      byGrant.set(item.run.grantId, { run: item.run, review: item.review, origin: "audited" });
    }
  }
  return [...byGrant.values()].sort((a, b) => a.run.grantId.localeCompare(b.run.grantId));
}

// ---- 승격 계획 수립 (순수 — 테스트 대상) ---------------------------------------------

/**
 * sourceSpan 정규화 해시 — criterion_ref 의 재연결 보조 키(스키마 주석 참조).
 * 전용 span 해시 유틸이 없어 입력 파이프라인의 sha256 관행(input.ts)을 따르되,
 * 공백 나열·유니코드 정규화 차이로 같은 인용이 다른 해시가 되지 않게 NFC + 공백 접기로
 * 정규화한 뒤 해시한다. span 부재는 null(해시 불가를 위장하지 않는다).
 */
export function sourceSpanHash(span: string | null | undefined): string | null {
  if (!span) return null;
  const normalized = span.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * criterion 내용 안정 키 — 객체 key 순서와 유니코드/공백 표현 차이를 제거한 뒤
 * dimension + kind + operator + value + sourceSpanHash를 해시한다.
 */
export function criterionStableKey(
  criterion: Pick<GrantCriterion, "dimension" | "kind" | "operator" | "value"> & {
    source_span?: string | null;
  },
): string {
  const material = [
    criterion.dimension,
    criterion.kind,
    criterion.operator,
    stableJson(criterion.value),
    sourceSpanHash(criterion.source_span ?? null) ?? "",
  ].join("\u001f");
  return createHash("sha256").update(material).digest("hex");
}

function stableJson(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value.normalize("NFC").replace(/\s+/g, " ").trim());
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface ExistingPromotionCriterion {
  id: string;
  stableKey: string | null;
  dimension: GrantCriterion["dimension"];
  operator: GrantCriterion["operator"];
  value: GrantCriterion["value"];
  kind: GrantCriterion["kind"];
  sourceSpan: string | null;
}

export interface ExistingPromotionQuestion {
  id: string;
  grantCriteriaId: string | null;
  criterionStableKey: string | null;
}

/**
 * stable_key 도입 전 행도 내용으로 키를 복원해 같은 criterion ID를 재사용한다.
 * 같은 키의 중복 legacy 행은 첫 행을 택하고, DB unique index가 이후 중복 생성을 막는다.
 */
export function indexExistingCriteriaByStableKey<T extends ExistingPromotionCriterion>(
  rows: T[],
): Map<string, T> {
  const indexed = new Map<string, T>();
  for (const row of rows) {
    const stableKey = row.stableKey ?? criterionStableKey({
      dimension: row.dimension,
      operator: row.operator,
      value: row.value,
      kind: row.kind,
      source_span: row.sourceSpan,
    });
    if (!indexed.has(stableKey)) indexed.set(stableKey, row);
  }
  return indexed;
}

/**
 * 질문은 stable key를 우선하고, 마이그레이션 전 질문은 보존된 criterion ID로 재연결한다.
 * 반환된 행을 UPDATE해야 질문 ID와 그 아래 답변 FK가 그대로 유지된다.
 */
export function findExistingQuestionForStableKey<T extends ExistingPromotionQuestion>(
  rows: T[],
  stableKey: string,
  grantCriteriaId: string,
): T | null {
  return rows.find((row) => row.criterionStableKey === stableKey)
    ?? rows.find((row) => row.grantCriteriaId === grantCriteriaId)
    ?? null;
}

export interface PromotionQuestionPlan {
  /** 발행 criteria 배열에서의 위치 — 쓰기 경로가 새 grant_criteria 행 id 를 연결하는 키. */
  criteriaPosition: number;
  /** 런 criteria 배열 인덱스(안정 키 — 런 불변). */
  criterionIndex: number;
  prompt: string;
  options: LabConfirmationOption[];
  answerType: "single" | "multi";
  reusable: LabConfirmationReusable;
  conditionKey: string | null;
  /** 인라인이면 런의 promptVersion(lab-deep-v3), 사이드카면 confirmations-v1. */
  promptVer: string;
  /** v3 인라인 여부(원본 런 기준) — 계획 출력용. */
  inline: boolean;
  provenance: { runId: string; auditState: PromotionAuditState; criterionIndex: number };
  criterionRef: { dimension: string; kind: string; sourceSpanHash: string | null };
  /** 질문 upsert와 ID/답변 보존의 기준. */
  criterionStableKey: string;
  resolutionState: CriterionResolutionState;
}

export interface GrantPromotionPlan {
  grantId: string;
  runId: string;
  title: string;
  origin: PromotionOrigin;
  auditState: PromotionAuditState;
  /** 발행 B criteria — shadow-convert 산출 그대로(needs_review=false, 강등분만 true). */
  criteria: GrantCriterion[];
  /**
   * 발행 배열 위치 → 런 criterionIndex. normalize 는 순서를 보존하고 산출 id 에 입력 row
   * 순번(llm-<n>)을 새기므로, 탈락(dropped)이 있어도 위치 이동에 안전하게 역산된다.
   * 역산 실패는 -1 — 정상 경로에서는 나올 수 없다(테스트로 봉인).
   */
  criterionIndexByPosition: number[];
  /** criteriaPosition과 1:1인 DB upsert 키. */
  criterionStableKeys: string[];
  resolutions: CriterionResolution[];
  /** 변환 보고 — 손실(강등·탈락·계약 실패) 무은폐. */
  conversion: ShadowConversionReport;
  questions: PromotionQuestionPlan[];
  /**
   * 병합 confirmation 을 보유한 correct exclusion 인데 발행 criteria 에 앵커를 잃어
   * 질문이 되지 못한 수(변환 탈락 등) — 무은폐 원칙.
   */
  droppedQuestionCandidates: number;
}

/** 산출 criterion id(…:llm-<n>)에서 변환 입력 row 순번을 역산한다 — llm-criteria 의 id 계약. */
function rowIndexFromCriterionId(id: string | undefined): number {
  const matched = /:llm-(\d+)$/.exec(id ?? "");
  return matched ? Number(matched[1]) - 1 : -1;
}

/**
 * 검수 확정 런 1건의 승격 계획 수립 — criteria 발행분(correct 전부, kind 무관)과
 * 질문 발행분(발행 criteria 중 exclusion + 병합 confirmation 보유)을 함께 계산한다.
 * DB 를 모르는 순수 함수: 현재 A 수와 upsert 대상은 호출부(CLI)가 읽는다.
 */
export function planGrantPromotion(input: {
  run: LabRun;
  review?: LabReview | null | undefined;
  aiReview?: AiCriterionReviewSnapshot | null | undefined;
  audit?: LabAudit | null | undefined;
  overlay?: HumanReviewOverlay | null | undefined;
  origin: PromotionOrigin;
  /** <runId>.confirmations.json 사이드카(없으면 null) — 병합 규칙은 confirmations.ts 그대로. */
  sidecar: LabConfirmationsFile | null;
}): GrantPromotionPlan {
  // 질문 소스: v3 인라인 + 사이드카 병합(인라인 우선·범위 밖 드롭 — 기존 병합 규칙 재사용).
  const mergedRun = mergeConfirmationsIntoRun(input.run, input.sidecar);
  const resolutions = resolveCriterionStates({
    run: mergedRun,
    humanReview: input.review,
    aiReview: input.aiReview,
    audit: input.audit,
    overlay: input.overlay,
  });
  const selected = resolutions.filter((item) => publishesCriterion(item.state));
  const conversion = convertSelectedLabCriteria(mergedRun, {
    selections: selected.map((item) => ({
      criterionIndex: item.criterionIndex,
      needsReview: criterionNeedsReview(item.state),
    })),
    verdicts: {
      correct: resolutions.filter((item) =>
        item.state === "confirmed_correct" || item.state === "unaudited_correct").length,
      needs_edit: resolutions.filter((item) => item.state === "confirmed_edited").length,
      wrong: resolutions.filter((item) => item.state === "confirmed_wrong").length,
      unsure: resolutions.filter((item) => item.state === "pending").length,
    },
    missedConditions: (input.review?.axisReviews ?? input.aiReview?.axisReviews ?? [])
      .filter((axis) => axis.verdict === "missed_condition").length,
  });

  const rowCriterionIndexes = selected.map((item) => item.criterionIndex);
  const criterionIndexByPosition = conversion.criteria.map((criterion) => {
    const rowIndex = rowIndexFromCriterionId(criterion.id);
    return rowCriterionIndexes[rowIndex] ?? -1;
  });

  const auditState: PromotionAuditState =
    input.origin === "human"
      ? "human_reviewed"
      : input.origin === "audited"
        ? "ai_audit_concur"
        : "mixed_resolution";
  const criterionStableKeys = conversion.criteria.map(criterionStableKey);
  const resolutionByIndex = new Map(resolutions.map((item) => [item.criterionIndex, item]));

  const questions: PromotionQuestionPlan[] = [];
  conversion.criteria.forEach((criterion, position) => {
    if (criterion.kind !== "exclusion") return; // 질문은 발행 exclusion 에만 앵커된다.
    const criterionIndex = criterionIndexByPosition[position] ?? -1;
    const resolution = resolutionByIndex.get(criterionIndex);
    if (!resolution || !publishesConfirmationQuestion(resolution.state)) return;
    const confirmation = criterionIndex >= 0 ? mergedRun.criteria[criterionIndex]?.confirmation : null;
    if (!confirmation) return;
    const inline = Boolean(input.run.criteria[criterionIndex]?.confirmation);
    questions.push({
      criteriaPosition: position,
      criterionIndex,
      prompt: confirmation.prompt,
      options: confirmation.options,
      answerType: confirmation.answerType,
      reusable: confirmation.reusable,
      conditionKey: confirmation.conditionKey,
      // 인라인은 런 세대(lab-deep-v3), 보강 사이드카는 자체 promptVersion(confirmations-v1).
      promptVer: inline ? input.run.promptVersion : (input.sidecar?.promptVersion ?? CONFIRMATIONS_PROMPT_VERSION),
      inline,
      provenance: {
        runId: input.run.runId,
        auditState: questionAuditState(input, resolution),
        criterionIndex,
      },
      // 재연결 보조 참조는 **발행 criterion** 기준 — 강등 시 dimension/kind 가 런과 다를 수 있다.
      criterionRef: {
        dimension: criterion.dimension,
        kind: criterion.kind,
        sourceSpanHash: sourceSpanHash(criterion.source_span ?? null),
      },
      criterionStableKey: criterionStableKeys[position]!,
      resolutionState: resolution.state,
    });
  });

  // 무은폐: 질문 후보(병합 confirmation 보유 correct exclusion)였는데 발행에 앵커되지 못한 수.
  const publishedQuestionIndexes = new Set(questions.map((question) => question.criterionIndex));
  let droppedQuestionCandidates = 0;
  for (const resolution of resolutions) {
    if (!publishesConfirmationQuestion(resolution.state)) continue;
    const criterionIndex = resolution.criterionIndex;
    const labCriterion = mergedRun.criteria[criterionIndex];
    if (!labCriterion?.confirmation || labCriterion.kind !== "exclusion") continue;
    if (!publishedQuestionIndexes.has(criterionIndex)) droppedQuestionCandidates += 1;
  }

  return {
    grantId: input.run.grantId,
    runId: input.run.runId,
    title: input.run.title,
    origin: input.origin,
    auditState,
    criteria: conversion.criteria,
    criterionIndexByPosition,
    criterionStableKeys,
    resolutions,
    conversion: conversion.report,
    questions,
    droppedQuestionCandidates,
  };
}

function questionAuditState(
  input: {
    origin: PromotionOrigin;
    audit?: LabAudit | null | undefined;
    overlay?: HumanReviewOverlay | null | undefined;
  },
  resolution: CriterionResolution,
): PromotionAuditState {
  if (input.origin === "human") return "human_reviewed";
  if (input.origin === "audited") return "ai_audit_concur";
  const overlayDecision = input.overlay?.items.some((item) =>
    item.itemKind === "criterion"
    && item.criterionIndex === resolution.criterionIndex
    && item.humanVerdict === "correct");
  const auditItem = input.audit?.items.find((item) =>
    item.kind === "criterion" && item.criterionIndex === resolution.criterionIndex);
  if (overlayDecision || auditItem?.humanVerdict === "correct") return "human_reviewed";
  if (auditItem && auditItem.aiAuditVerdict === "correct") return "ai_audit_concur";
  return "mixed_resolution";
}

// ---- 발행 가드 (순수 — 테스트 대상) --------------------------------------------------

export type PromotionRefusalReason =
  /** 변환 계약 실패(공고 단위 격리) — 빈 criteria 로 A 를 지우는 사고 방지. */
  "conversion_error"
  /** 발행 criteria 0건 — 교체형 발행이 삭제만 남기는 것을 막는다. */
  | "empty_criteria";

export interface RefusedPromotion {
  plan: GrantPromotionPlan;
  reason: PromotionRefusalReason;
  detail: string;
}

export interface PromotionGuardResult {
  publishable: GrantPromotionPlan[];
  refused: RefusedPromotion[];
}

/**
 * 발행 가능 판정. 답변 보존은 질문 삭제가 아닌 안정 키 upsert·soft-invalidate로
 * 쓰기 포트가 보장하므로, 답변 존재 자체는 더 이상 공고 전체 거부 사유가 아니다.
 */
export function applyPublishGuards(
  plans: GrantPromotionPlan[],
): PromotionGuardResult {
  const publishable: GrantPromotionPlan[] = [];
  const refused: RefusedPromotion[] = [];
  for (const plan of plans) {
    if (plan.conversion.error !== null) {
      refused.push({ plan, reason: "conversion_error", detail: `변환 계약 실패: ${plan.conversion.error}` });
      continue;
    }
    if (plan.criteria.length === 0) {
      refused.push({ plan, reason: "empty_criteria", detail: "발행 criteria 0건 — 교체 발행이 기존 A 삭제만 남긴다" });
      continue;
    }
    publishable.push(plan);
  }
  return { publishable, refused };
}

// ---- 실행 모드 게이트 (순수 — 테스트 대상) -------------------------------------------

export const PROMOTION_PROTOCOL_NOTICE =
  "실발행은 잔여 48항목 사람 감사 → aggregate GO → lab:shadow 긍정 후에만 허용됩니다. " +
  "실행하려면 --write --confirm-go 두 플래그를 모두 지정하세요.";

export interface PromotionMode {
  write: boolean;
  /** 플래그가 하나만 지정된 경우의 프로토콜 경고 — dry-run 강등 사유. */
  warning: string | null;
}

/** --write 와 --confirm-go 가 **모두** 있어야만 실쓰기 — 하나라도 없으면 경고 + dry-run. */
export function resolvePromotionMode(flags: { write: boolean; confirmGo: boolean }): PromotionMode {
  if (flags.write && flags.confirmGo) return { write: true, warning: null };
  if (flags.write || flags.confirmGo) {
    const missing = flags.write ? "--confirm-go" : "--write";
    return {
      write: false,
      warning: `프로토콜 게이트: ${missing} 가 없어 dry-run 으로 강등합니다. ${PROMOTION_PROTOCOL_NOTICE}`,
    };
  }
  return { write: false, warning: null };
}

// ---- 쓰기 오케스트레이션 (포트 주입 — 실행 테스트는 페이크) ---------------------------

export interface PromotionGrantWriteResult {
  criteriaDeleted: number;
  criteriaInserted: number;
  criteriaUpdated: number;
  questionsInserted: number;
  questionsUpdated: number;
  questionsInvalidated: number;
  matchStatesDeleted: number;
}

/** per-grant 트랜잭션 경계 — 실 구현(Drizzle)은 promote-cli.ts, 테스트는 페이크. */
export interface PromotionWritePort {
  publishGrant(plan: GrantPromotionPlan): Promise<PromotionGrantWriteResult>;
}

export type PromotionWriteOutcome =
  | { plan: GrantPromotionPlan; result: PromotionGrantWriteResult; error: null }
  | { plan: GrantPromotionPlan; result: null; error: string };

/**
 * 발행 실행 — grant 단위로 격리한다: 한 공고의 실패가 나머지 발행을 막지 않고,
 * 실패 사유는 결과에 남아 CLI 가 무은폐로 출력한다.
 */
export async function executePromotionWrites(
  plans: GrantPromotionPlan[],
  port: PromotionWritePort,
): Promise<PromotionWriteOutcome[]> {
  const outcomes: PromotionWriteOutcome[] = [];
  for (const plan of plans) {
    try {
      outcomes.push({ plan, result: await port.publishGrant(plan), error: null });
    } catch (caught) {
      outcomes.push({ plan, result: null, error: caught instanceof Error ? caught.message : String(caught) });
    }
  }
  return outcomes;
}
