import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CriterionDimension, CriterionKind, MatchCard } from "@cunote/contracts";
import { isNonMatchingApplicationCriterion } from "@cunote/core";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";

/**
 * 매칭 카드에 공고별 자가신고 확인 질문 수를 주석한다(확인 루프 Phase B).
 * core 는 질문 저장소를 모르므로(annotateWriteSupport 와 동일 원칙), 서버 레이어가
 * grant_confirmation_questions 를 grantIds 배치 1쿼리(group by)로 집계해 덮어쓴다.
 * DB 미가용·조회 실패 시 주석 없이 원본 카드를 그대로 반환한다 — CTA 미노출이 안전한 기본값.
 */
export async function annotateMatchCardConfirmationQuestions(
  matches: MatchCard[],
): Promise<MatchCard[]> {
  // grantKey 가 DB id 가 아닌 카드(`source:sourceId` 샘플 경로)는 질문도 있을 수 없어 제외한다.
  const grantIds = matches.map((match) => match.grantId).filter(isUuid);
  if (grantIds.length === 0) return matches;

  let anchors: ConfirmationQuestionAnchor[];
  try {
    anchors = await loadConfirmationQuestionAnchors(grantIds);
  } catch (error) {
    console.warn(
      `확인 질문 수 주석 조회 실패(주석 없이 폴백): ${error instanceof Error ? error.message : String(error)}`,
    );
    return matches;
  }
  return applyActionableConfirmationQuestions(matches, anchors);
}

/**
 * 질문을 카드에 적용한다(순수 — 테스트 대상).
 *
 * 아직 답하지 않은 카드에서는 모든 hard unknown이 발행 질문으로 해소될 때만 CTA를 연다.
 * 즉 질문 하나를 답해도 업종·사업자 유형 같은 다른 blocker가 그대로 남는 저가치 진입을
 * 먼저 노출하지 않는다. 이미 답한 카드는 재확인 진입을 위해 유효 질문 수를 계속 싣는다.
 */
export function applyActionableConfirmationQuestions(
  matches: MatchCard[],
  anchors: readonly ConfirmationQuestionAnchor[],
): MatchCard[] {
  if (anchors.length === 0) return matches;
  const anchorsByGrant = new Map<string, ConfirmationQuestionAnchor[]>();
  for (const anchor of anchors) {
    anchorsByGrant.set(anchor.grantId, [...(anchorsByGrant.get(anchor.grantId) ?? []), anchor]);
  }
  return matches.map((match) => {
    const grantAnchors = anchorsByGrant.get(match.grantId) ?? [];
    if (grantAnchors.length === 0) return match;
    if ((match.userConfirmedCount ?? 0) > 0) {
      return { ...match, confirmationQuestionCount: uniqueQuestionCount(grantAnchors) };
    }
    const hardUnknowns = match.ruleTrace.filter((trace) =>
      (trace.result === "unknown" || trace.result === "text_only")
      && (trace.kind === "required" || trace.kind === "exclusion"));
    if (hardUnknowns.length === 0) return match;
    const matchedQuestionIds = new Set<string>();
    for (const trace of hardUnknowns) {
      const matched = grantAnchors.filter((anchor) => anchorMatchesTrace(anchor, trace));
      if (matched.length === 0) return match;
      for (const anchor of matched) matchedQuestionIds.add(anchor.questionId);
    }
    return matchedQuestionIds.size > 0
      ? { ...match, confirmationQuestionCount: matchedQuestionIds.size }
      : match;
  });
}

export interface ConfirmationQuestionAnchor {
  questionId: string;
  grantId: string;
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
      dimension: schema.grantCriteria.dimension,
      kind: schema.grantCriteria.kind,
      operator: schema.grantCriteria.operator,
      sourceSpan: schema.grantCriteria.sourceSpan,
    })
    .from(schema.grantConfirmationQuestions)
    .innerJoin(
      schema.grantCriteria,
      eq(schema.grantCriteria.id, schema.grantConfirmationQuestions.grantCriteriaId),
    )
    .where(and(
      inArray(schema.grantConfirmationQuestions.grantId, grantIds),
      isNull(schema.grantConfirmationQuestions.invalidatedAt),
    ));
  return rows.filter((row) => !isNonMatchingApplicationCriterion({
    dimension: row.dimension,
    kind: row.kind,
    operator: row.operator,
    source_span: row.sourceSpan,
  }));
}

function anchorMatchesTrace(
  anchor: ConfirmationQuestionAnchor,
  trace: MatchCard["ruleTrace"][number],
): boolean {
  return anchor.dimension === trace.dimension
    && anchor.kind === trace.kind
    && normalizeSpan(anchor.sourceSpan) !== ""
    && normalizeSpan(anchor.sourceSpan) === normalizeSpan(trace.sourceSpan);
}

function uniqueQuestionCount(anchors: readonly ConfirmationQuestionAnchor[]): number {
  return new Set(anchors.map((anchor) => anchor.questionId)).size;
}

function normalizeSpan(value: string | null | undefined): string {
  return (value ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
