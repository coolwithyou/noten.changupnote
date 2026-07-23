// 공모 딥분석 실험실 — 감사 확정 AI 검수 병합·로더 (dev 전용, DB·네트워크 미사용).
// 확대 실험 계획 §9: 사람 review.json 이 없는 공고의 "AI 검수 + 완료된 사람 감사" 짝을
// LabReview 호환 형태로 병합해 게이트 표본의 새 원천을 만든다:
//   - 감사된 항목은 humanVerdict(동의면 AI 판정과 동일 값이 저장돼 있음)
//   - 감사 안 된 항목은 AI 판정 그대로(§9 표본 감사 설계 — 비-correct 전수 + 플래그 전수 +
//     correct 20% 표본만 사람이 확인하고, 나머지 correct 는 AI 판정을 신뢰한다)
//   - AI 블라인드 감사 일치(concur, §9 완화 개정) 항목은 humanVerdict 없이 완료로 간주되며
//     (isLabAuditComplete) 병합 결과는 AI 검수 판정 그대로다 — 코드 경로상 "감사 안 된 항목"
//     과 동일하게 흐르고, provenance(aiConcurCount 등)로만 구분된다.
// 병합 결과는 LabReview 와 구조가 같아 aggregate(게이트 집계)·shadow(섀도 측정)·
// shadow-convert(correct 만 변환)가 무변경으로 소비한다. 검수 주체는 provenance 로
// 구분해 집계 출력에 병기한다(§9 게이트 해석 조항 — 방법론 은폐 금지).
// 미완료 감사(파일 미생성 포함)는 "감사 대기"로 별도 반환한다(무은폐).
import { join } from "node:path";
import {
  AI_REVIEW_ADOPTED,
  isAiAuditConcur,
  type LabAudit,
  type LabAuditItem,
  type LabCriterionReview,
  type LabCriterionVerdict,
  type LabAxisReview,
  type LabEmptyAxisVerdict,
  type LabReview,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import {
  collectAiReviewsForAudit,
  isLabAuditComplete,
  readLabAuditFileAt,
  type AuditSourceAiReview,
  type CollectedAiReview,
} from "./audit-store";
import { PILOT_STRATUM, readCohortFileV2 } from "./cohort-file";
import { modelSlug } from "./run-store";

// ---- 병합 (순수 — 테스트 대상) -----------------------------------------------------

export interface AuditedReviewProvenance {
  source: "ai_plus_audit";
  model: string;
  aiPromptVersion: string;
  /** 사람이 판정한 감사 항목 수. */
  auditedCount: number;
  /** 감사에서 AI 판정이 뒤집힌 항목 수 — 공고당 >1건 누적 시 자동 검수 신뢰 재평가(§9). */
  overturnedCount: number;
  /** AI 블라인드 감사가 기록된 항목 수(§9 완화 개정 — 사람 판정 보유 항목 포함). */
  aiAuditedCount: number;
  /** AI 블라인드 감사 일치로 사람 판정 없이 자동 확정된 항목 수(isAiAuditConcur). */
  aiConcurCount: number;
  /** AI 감사 기록 중 비일치(불일치·unsure) 항목 수 — 사람 판정이 필요한(했던) 갈래. */
  aiDisagreeCount: number;
  /** AI 블라인드 감사 모델 — 미실행 감사 파일이면 null. */
  aiAuditModel: string | null;
}

export interface MergedAuditedReview {
  review: LabReview;
  provenance: AuditedReviewProvenance;
}

/** 병합 입력의 AI 검수 최소 형태 — AuditSourceAiReview(audit-store)의 부분집합. */
export type AuditedAiReviewInput = Pick<
  AuditSourceAiReview,
  "grantId" | "runId" | "model" | "promptVersion" | "criterionReviews" | "axisReviews"
>;

/**
 * AI 검수 + 사람 감사 → LabReview 호환 병합.
 * 감사된 항목은 humanVerdict 가 verdict 가 되고 note 는 human note ?? AI note.
 * 감사 안 된(또는 미판정) 항목은 AI 판정·note 그대로. reviewerEmail 은 감사자 이메일
 * (대상 0건 공허 완료 감사는 저장 이력이 없어 null — 마커 문자열로 대체).
 */
export function mergeAuditedReview(aiReview: AuditedAiReviewInput, audit: LabAudit): MergedAuditedReview {
  if (aiReview.runId !== audit.runId || aiReview.grantId !== audit.grantId) {
    throw new Error(
      `감사 병합 대상 불일치: ai-review ${aiReview.grantId}/${aiReview.runId} vs audit ${audit.grantId}/${audit.runId}`,
    );
  }

  const criterionAudits = new Map<number, LabAuditItem>();
  const axisAudits = new Map<string, LabAuditItem>();
  let auditedCount = 0;
  let overturnedCount = 0;
  let aiAuditedCount = 0;
  let aiConcurCount = 0;
  let aiDisagreeCount = 0;
  for (const item of audit.items) {
    if (item.kind === "criterion" && item.criterionIndex !== undefined) {
      criterionAudits.set(item.criterionIndex, item);
    } else if (item.kind === "axis" && item.dimension !== undefined) {
      axisAudits.set(item.dimension, item);
    }
    if (item.humanVerdict !== null) {
      auditedCount += 1;
      if (item.humanVerdict !== item.aiVerdict) overturnedCount += 1;
    }
    // AI 블라인드 감사 집계(§9 완화 개정) — 일치(concur)는 사람 판정 없는 항목의 자동 확정만
    // 센다(사람 판정이 있으면 사람이 확정 주체 — auditedCount 쪽). 비일치는 기록 전건.
    if (item.aiAuditVerdict !== undefined && item.aiAuditVerdict !== null) {
      aiAuditedCount += 1;
      if (item.humanVerdict === null && isAiAuditConcur(item)) aiConcurCount += 1;
      else if (!isAiAuditConcur(item)) aiDisagreeCount += 1;
    }
  }

  const criterionReviews: LabCriterionReview[] = aiReview.criterionReviews.map((ai) => {
    const audited = criterionAudits.get(ai.criterionIndex);
    if (!audited || audited.humanVerdict === null) {
      return { criterionIndex: ai.criterionIndex, verdict: ai.verdict, note: ai.note };
    }
    return {
      criterionIndex: ai.criterionIndex,
      verdict: audited.humanVerdict as LabCriterionVerdict,
      note: audited.note ?? ai.note,
    };
  });
  const axisReviews: LabAxisReview[] = aiReview.axisReviews.map((ai) => {
    const audited = axisAudits.get(ai.dimension);
    if (!audited || audited.humanVerdict === null) {
      return { dimension: ai.dimension, verdict: ai.verdict, note: ai.note };
    }
    return {
      dimension: ai.dimension,
      verdict: audited.humanVerdict as LabEmptyAxisVerdict,
      note: audited.note ?? ai.note,
    };
  });

  return {
    review: {
      grantId: audit.grantId,
      runId: audit.runId,
      reviewerEmail:
        audit.auditorEmail ??
        (audit.items.length === 0 ? "(감사 대상 0건 — 자동 편입)" : "(AI 블라인드 감사 — 사람 판정 없음)"),
      createdAt: audit.createdAt,
      updatedAt: audit.updatedAt,
      criterionReviews,
      axisReviews,
      overallNote: audit.overallNote,
    },
    provenance: {
      source: "ai_plus_audit",
      model: aiReview.model,
      aiPromptVersion: aiReview.promptVersion,
      auditedCount,
      overturnedCount,
      aiAuditedCount,
      aiConcurCount,
      aiDisagreeCount,
      aiAuditModel: audit.aiAuditModel ?? null,
    },
  };
}

// ---- 로더 (게이트 표본의 새 원천) ---------------------------------------------------

export interface AuditedConfirmedRun {
  run: LabRun;
  review: LabReview;
  provenance: AuditedReviewProvenance;
}

/** 감사 대기(파일 미생성이면 decided/total null) — 무은폐 표시용. */
export interface AuditedPendingNotice {
  grantId: string;
  runId: string;
  title: string;
  decidedItems: number | null;
  totalItems: number | null;
}

export interface AuditedReviewSelection {
  /** 완료된 감사로 확정된 AI 검수 — 게이트 표본 편입 대상. */
  confirmed: AuditedConfirmedRun[];
  /** 감사 미완 공고 — 집계에서 제외되며 건수를 출력에 병기한다. */
  pending: AuditedPendingNotice[];
}

/**
 * 코호트 공고 중 사람 review.json 이 **없는** 공고에서, 지정 모델의 AI 검수 + 감사 짝을
 * 수집한다(사람 검수 보유 공고 제외는 collectAiReviewsForAudit 가 공고 디렉토리 단위로
 * 수행). 완료 감사는 병합해 confirmed 로, 미완·미생성은 pending 으로 반환한다.
 * 읽기 전용 — 감사 파일을 생성하지 않는다(생성은 감사 시트 GET/audit-store 의 소관).
 */
export async function loadAuditedConfirmedReviews(options: {
  model: string;
  /** true 면 코호트 밖 공고도 포함(aggregate --all 과 동일 규칙). */
  scanAll: boolean;
  /** true 면 stratum=pilot 공고 제외(게이트 표본 전용) — 파일럿은 사람 검수 보유라 보통 무의미. */
  excludePilotStratum?: boolean;
}): Promise<AuditedReviewSelection> {
  const cohort = await readCohortFileV2();
  const stratumByGrant = new Map<string, string>();
  if (cohort) {
    for (const entry of cohort.entries) {
      if (!stratumByGrant.has(entry.grantId)) stratumByGrant.set(entry.grantId, entry.stratum);
    }
  }

  const collected = await collectAiReviewsForAudit(options.model, { quiet: true });

  // 코호트 필터(기본) — 다른 실험 AI 검수의 혼입 차단(aggregate 의 사람 검수 필터와 동일 규칙).
  let pool = collected;
  if (!options.scanAll && cohort !== null) {
    pool = collected.filter((item) => stratumByGrant.has(item.review.grantId));
    const filteredOut = collected.length - pool.length;
    if (filteredOut > 0) {
      console.warn(`[경고] 코호트 밖 AI 검수 ${filteredOut}건 제외 — 포함하려면 --all.`);
    }
    if (options.excludePilotStratum === true) {
      pool = pool.filter((item) => stratumByGrant.get(item.review.grantId) !== PILOT_STRATUM);
    }
  }

  // 같은 공고에 AI 검수가 여러 개면 최신 런 1건만(사람 검수 dedupe 와 같은 원칙).
  const byGrant = new Map<string, CollectedAiReview>();
  for (const item of pool) {
    const previous = byGrant.get(item.review.grantId);
    if (!previous) {
      byGrant.set(item.review.grantId, item);
      continue;
    }
    const kept =
      (previous.run?.startedAt ?? "") >= (item.run?.startedAt ?? "") ? previous : item;
    byGrant.set(item.review.grantId, kept);
    console.warn(
      `[경고] 같은 공고의 AI 검수 중 최신 런만 감사 집계: ${kept.review.grantId} → ${kept.review.runId}`,
    );
  }

  const slug = modelSlug(options.model);
  const confirmed: AuditedConfirmedRun[] = [];
  const pending: AuditedPendingNotice[] = [];
  for (const item of byGrant.values()) {
    if (!item.run || item.run.error !== null) {
      console.warn(
        `[경고] AI 검수의 짝 런 파일이 없거나 실패 런 — 감사 집계 제외: ${item.review.grantId}/${item.review.runId}`,
      );
      continue;
    }
    if (item.review.promptVersion !== AI_REVIEW_ADOPTED.promptVersion) {
      console.warn(
        `[경고] AI 검수 promptVersion(${item.review.promptVersion})이 채택본(${AI_REVIEW_ADOPTED.promptVersion})과 다름: ${item.review.runId}`,
      );
    }
    const audit = await readLabAuditFileAt(join(item.dir, `${item.review.runId}.audit.${slug}.json`));
    if (!audit || !isLabAuditComplete(audit)) {
      pending.push({
        grantId: item.review.grantId,
        runId: item.review.runId,
        title: item.title,
        decidedItems: audit ? audit.items.filter((auditItem) => auditItem.humanVerdict !== null).length : null,
        totalItems: audit ? audit.items.length : null,
      });
      continue;
    }
    const merged = mergeAuditedReview(item.review, audit);
    confirmed.push({ run: item.run, review: merged.review, provenance: merged.provenance });
  }

  return { confirmed, pending };
}
