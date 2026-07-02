/**
 * 필드맵 golden 승격 순환성 가드 (공용).
 *
 * 상위 기준서: docs/gate1-field-map-labeling-guide.md ("AI 라벨을 검수 없이 golden 으로 승격 금지")
 * REVIEW-QUEUE.md 규약: 검수 완료 시 labeledBy 를 검수자(이메일)로 갱신한다.
 *
 * 파일 파이프라인(load-golden-field-maps.ts)과 리뷰어 워크스페이스 확정 경로가 동일한 판정을 쓰도록
 * AI 라벨러 거부 + 사람 검수자(이메일) 요구 로직을 한 곳으로 모은다.
 */

/**
 * AI 라벨러로 간주하여 거부하는 labeledBy 패턴.
 * 검수 없이 golden 으로 승격되는 순환성을 차단한다.
 */
export const AI_LABELER_PATTERNS: readonly RegExp[] = [
  /prelabel/i,
  /\bopus\b/i,
  /\bsonnet\b/i,
  /\bhaiku\b/i,
  /\bclaude\b/i,
  /\bgpt\b/i,
  /\bgemini\b/i,
  /\bllm\b/i,
  /(^|[^a-z])ai([^a-z]|$)/i,
  /-?model$/i,
  /auto-?label/i,
];

export function isAiLabeler(value: string): boolean {
  return AI_LABELER_PATTERNS.some((re) => re.test(value));
}

export function isReviewerEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export type ReviewerGate =
  | { ok: true; reviewer: string }
  | { ok: false; reason: string };

/**
 * 순환성 가드 판정.
 * - 검수자 표기(이메일 형태) 요구: reviewedBy(있으면 우선) 또는 labeledBy 가 이메일이어야 한다.
 * - AI 라벨러 패턴이면 거부.
 */
export function evaluateReviewer(
  labeledBy: string | null | undefined,
  reviewedBy: string | null | undefined,
): ReviewerGate {
  const reviewer = (reviewedBy ?? labeledBy ?? "").trim();
  if (!reviewer) {
    return { ok: false, reason: "no_labeledBy" };
  }
  if (isAiLabeler(reviewer)) {
    return { ok: false, reason: `ai_labeler_unreviewed:${reviewer}` };
  }
  if (!isReviewerEmail(reviewer)) {
    // 사람 검수자는 이메일로 표기한다(기준서 예시 reviewer@ba-ton.kr, REVIEW-QUEUE 규약).
    return { ok: false, reason: `not_human_reviewer:${reviewer}` };
  }
  return { ok: true, reviewer };
}
