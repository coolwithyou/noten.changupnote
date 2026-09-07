import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { CriterionDimension, CriterionKind, MatchCard } from "@cunote/contracts";
import { isNonMatchingApplicationCriterion } from "@cunote/core";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBindings } from "../deep-analysis/prepareInput";

/**
 * 매칭 카드에 공고별 자가신고 확인 질문 수를 주석한다(확인 루프 Phase B).
 * core 는 질문 저장소를 모르므로(annotateWriteSupport 와 동일 원칙), 서버 레이어가
 * grant_confirmation_questions 를 grantIds 배치 1쿼리(group by)로 집계해 덮어쓴다.
 * DB 미가용·조회 실패 시 이전 질문 파생 주석을 제거한 카드를 반환한다 — CTA 미노출이 안전한 기본값.
 */
export async function annotateMatchCardConfirmationQuestions(
  matches: MatchCard[],
): Promise<MatchCard[]> {
  const baseMatches = clearConfirmationQuestionAnnotations(matches);
  // grantKey 가 DB id 가 아닌 카드(`source:sourceId` 샘플 경로)는 질문도 있을 수 없어 제외한다.
  const grantIds = baseMatches.map((match) => match.grantId).filter(isUuid);
  if (grantIds.length === 0) return baseMatches;

  let anchors: ConfirmationQuestionAnchor[];
  try {
    anchors = await loadConfirmationQuestionAnchors(grantIds);
  } catch (error) {
    console.warn(
      `확인 질문 수 주석 조회 실패(주석 없이 폴백): ${error instanceof Error ? error.message : String(error)}`,
    );
    return baseMatches;
  }
  return applyActionableConfirmationQuestions(baseMatches, anchors);
}

/**
 * 질문을 카드에 적용한다(순수 — 테스트 대상).
 *
 * 사용자 확인 가능한 exact 질문이 있으면 hard/preferred 구분 없이 CTA를 연다. 우대 질문은
 * eligibility를 바꾸지 않고 우대 확인만 보완한다. source dispute·검수 전·오염 criterion은
 * 질문 anchor가 남아 있어도 관리자 확인을 사용자 답변으로 우회하지 않는다.
 */
export function applyActionableConfirmationQuestions(
  matches: MatchCard[],
  anchors: readonly ConfirmationQuestionAnchor[],
): MatchCard[] {
  const baseMatches = clearConfirmationQuestionAnnotations(matches);
  if (anchors.length === 0) return baseMatches;
  const anchorsByGrant = new Map<string, ConfirmationQuestionAnchor[]>();
  for (const anchor of anchors) {
    anchorsByGrant.set(anchor.grantId, [...(anchorsByGrant.get(anchor.grantId) ?? []), anchor]);
  }
  return baseMatches.map((match) => {
    const grantAnchors = anchorsByGrant.get(match.grantId) ?? [];
    if (grantAnchors.length === 0) return match;
    const actionableTraces = match.ruleTrace.filter(traceCanUseConfirmationQuestion);
    const matchedQuestionIds = new Set<string>();
    for (const trace of actionableTraces) {
      const matched = grantAnchors.filter((anchor) => anchorMatchesTrace(anchor, trace));
      for (const anchor of matched) matchedQuestionIds.add(anchor.questionId);
    }
    const annotatedTrace = match.ruleTrace.map((trace) => {
      if (!traceCanUseConfirmationQuestion(trace) || trace.resolution === "confirmed_by_user") return trace;
      return grantAnchors.some((anchor) => anchorMatchesTrace(anchor, trace))
        ? { ...trace, confirmationNextAction: "user_confirmation" as const }
        : trace;
    });
    // 역사 카드가 confirmed count만 싣고 trace provenance를 생략한 경우에만 기존 재확인
    // 진입을 보존한다. 신규 카드에서는 criterionId 결속 trace만 센다.
    if (matchedQuestionIds.size === 0 && (match.userConfirmedCount ?? 0) > 0 && match.ruleTrace.length === 0) {
      for (const anchor of grantAnchors) matchedQuestionIds.add(anchor.questionId);
    }
    return matchedQuestionIds.size > 0
      ? {
          ...match,
          ruleTrace: annotatedTrace,
          confirmationQuestionCount: matchedQuestionIds.size,
        }
      : match;
  });
}

function clearConfirmationQuestionAnnotations(matches: MatchCard[]): MatchCard[] {
  let changed = false;
  const cleared = matches.map((match) => {
    const hadCount = match.confirmationQuestionCount !== undefined;
    let traceChanged = false;
    const ruleTrace = match.ruleTrace.map((trace) => {
      if (trace.confirmationNextAction !== "user_confirmation") return trace;
      traceChanged = true;
      if (trace.resolution === "confirmed_by_user") {
        const { confirmationNextAction: _nextAction, ...resolvedTrace } = trace;
        return resolvedTrace;
      }
      return {
        ...trace,
        confirmationNextAction: trace.unresolvedReason === "company_profile_missing"
          ? "company_profile" as const
          : "admin_source_review" as const,
      };
    });
    if (!hadCount && !traceChanged) return match;
    changed = true;
    const { confirmationQuestionCount: _count, ...withoutCount } = match;
    return { ...withoutCount, ruleTrace };
  });
  return changed ? cleared : matches;
}

function traceCanUseConfirmationQuestion(trace: MatchCard["ruleTrace"][number]): boolean {
  if (trace.resolution === "confirmed_by_user") return true;
  if (trace.result !== "unknown" && trace.result !== "text_only") return false;
  return trace.unresolvedReason === "company_profile_missing"
    || trace.unresolvedReason === "criterion_text_only";
}

export interface ConfirmationQuestionAnchor {
  questionId: string;
  grantId: string;
  criterionId: string;
  dimension: CriterionDimension;
  kind: CriterionKind;
  operator: string;
  sourceSpan: string | null;
}

async function loadConfirmationQuestionAnchors(grantIds: string[]): Promise<ConfirmationQuestionAnchor[]> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      questionId: schema.grantConfirmationQuestions.id,
      grantId: schema.grantConfirmationQuestions.grantId,
      evaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
      sourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
      sourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
      criterionId: schema.grantCriteria.id,
      dimension: schema.grantCriteria.dimension,
      kind: schema.grantCriteria.kind,
      operator: schema.grantCriteria.operator,
      sourceSpan: schema.grantCriteria.sourceSpan,
    })
    .from(schema.grantConfirmationQuestions)
    .innerJoin(
      schema.grantCriteria,
      eq(
        schema.grantCriteria.id,
        sql`coalesce(${schema.grantConfirmationQuestions.evaluationCriterionId}, ${schema.grantConfirmationQuestions.grantCriteriaId})`,
      ),
    )
    .where(and(
      inArray(schema.grantConfirmationQuestions.grantId, grantIds),
      isNull(schema.grantConfirmationQuestions.invalidatedAt),
    ));
  const v2GrantIds = [...new Set(rows
    .filter((row) => row.evaluationContractVersion === "confirmation-evaluation-v2")
    .map((row) => row.grantId))];
  const currentSourceByGrant = await loadDeepAnalysisSourceBindings({ db, grantIds: v2GrantIds });
  return rows.filter((row) => (
    (row.evaluationContractVersion === null
      || row.evaluationContractVersion === "confirmation-evaluation-v2")
    && (row.evaluationContractVersion === null || (
      row.sourceRawSha256 === currentSourceByGrant.get(row.grantId)?.sourceRawSha256
      && row.sourceRevisionSha256 === currentSourceByGrant.get(row.grantId)?.sourceRevisionSha256
    ))
    && !isNonMatchingApplicationCriterion({
      dimension: row.dimension,
      kind: row.kind,
      operator: row.operator,
      source_span: row.sourceSpan,
    })
  ));
}

function anchorMatchesTrace(
  anchor: ConfirmationQuestionAnchor,
  trace: MatchCard["ruleTrace"][number],
): boolean {
  if (trace.criterionId) return anchor.criterionId === trace.criterionId;
  // 구 카드 fallback. 신규 카드는 criterionId로만 결속하며 같은 span의 다른 조건을 섞지 않는다.
  return anchor.dimension === trace.dimension
    && anchor.kind === trace.kind
    && normalizeSpan(anchor.sourceSpan) !== ""
    && normalizeSpan(anchor.sourceSpan) === normalizeSpan(trace.sourceSpan);
}

function normalizeSpan(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
