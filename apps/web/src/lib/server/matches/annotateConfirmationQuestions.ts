import { count, inArray } from "drizzle-orm";
import type { MatchCard } from "@cunote/contracts";
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

  let counts: ReadonlyMap<string, number>;
  try {
    counts = await loadConfirmationQuestionCounts(grantIds);
  } catch (error) {
    console.warn(
      `확인 질문 수 주석 조회 실패(주석 없이 폴백): ${error instanceof Error ? error.message : String(error)}`,
    );
    return matches;
  }
  return applyConfirmationQuestionCounts(matches, counts);
}

/**
 * 집계 결과를 카드에 적용한다(순수 — 테스트 대상). 질문이 없는 공고(빈 테이블 포함)는
 * 필드를 싣지 않아 CTA 게이트(count > 0)가 자연히 닫힌다.
 */
export function applyConfirmationQuestionCounts(
  matches: MatchCard[],
  counts: ReadonlyMap<string, number>,
): MatchCard[] {
  if (counts.size === 0) return matches;
  return matches.map((match) => {
    const questionCount = counts.get(match.grantId);
    return questionCount && questionCount > 0
      ? { ...match, confirmationQuestionCount: questionCount }
      : match;
  });
}

async function loadConfirmationQuestionCounts(grantIds: string[]): Promise<Map<string, number>> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      grantId: schema.grantConfirmationQuestions.grantId,
      questionCount: count(schema.grantConfirmationQuestions.id),
    })
    .from(schema.grantConfirmationQuestions)
    .where(inArray(schema.grantConfirmationQuestions.grantId, grantIds))
    .groupBy(schema.grantConfirmationQuestions.grantId);
  return new Map(rows.map((row) => [row.grantId, row.questionCount]));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
