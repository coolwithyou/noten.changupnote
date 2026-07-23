// 공모 딥분석 실험실 — 배치 대상 분할 순수 로직 (batch.ts CLI 에서 분리 — 테스트 대상).
// 우발 재분석 가드(Phase B-0, 계획 §1): 스킵 기준을 "현행 promptVersion ok 런 보유"에서
// "**버전 무관** ok 런 보유"로 바꾼다 — v3 승격 직후 lab:batch 를 그대로 돌리면 v2 ok 런
// 30건 전체가 재분석 대상이 되는 ~$12 함정이 있었다. 구버전 재분석은 명시적 탈출구
// --reanalyze-outdated 로만 허용한다(검수·감사 자산 동결 원칙과 정합).

/** 공고별 기존 런 상태 — batch.ts scanExistingRuns 가 채운다. */
export interface GrantRunState {
  /** 현행 promptVersion 의 ok 런 존재 → 항상 스킵. */
  okCurrent: boolean;
  /** 구버전 promptVersion 의 ok 런 존재 → 기본 스킵, --reanalyze-outdated 로만 대상 편입. */
  okOutdated: boolean;
  /** 현행 promptVersion 의 error 런 존재 → --retry-errors 없으면 보류. */
  errorCurrent: boolean;
}

export interface CohortPartition<E> {
  /** ok 런 보유 스킵(버전 무관 기본) — skippedOkOutdatedOnly 를 포함한다. */
  skippedOk: E[];
  /** 그중 구버전 ok 런"만" 보유한 공고 — 요약 표기·--reanalyze-outdated 안내용 부분집합. */
  skippedOkOutdatedOnly: E[];
  /** 현행 버전 error 런만 있어 보류(--retry-errors 미지정). */
  heldError: E[];
  /** 실행 대상. */
  pending: E[];
}

/**
 * 코호트 엔트리 분할 — 우선순위: 현행 ok 스킵 > 구버전 ok 스킵(--reanalyze-outdated 로 해제)
 * > 현행 error 보류(--retry-errors 로 해제) > 대상. 구버전 ok + 현행 error 를 함께 가진
 * 공고는 --reanalyze-outdated 시 error 런 보유 공고로 취급한다(--retry-errors 규칙 적용).
 */
export function partitionCohortEntries<E extends { grantId: string }>(
  entries: E[],
  states: Map<string, GrantRunState>,
  options: { retryErrors: boolean; reanalyzeOutdated: boolean },
): CohortPartition<E> {
  const partition: CohortPartition<E> = {
    skippedOk: [],
    skippedOkOutdatedOnly: [],
    heldError: [],
    pending: [],
  };
  for (const entry of entries) {
    const state = states.get(entry.grantId);
    if (state?.okCurrent) {
      partition.skippedOk.push(entry);
    } else if (state?.okOutdated && !options.reanalyzeOutdated) {
      partition.skippedOk.push(entry);
      partition.skippedOkOutdatedOnly.push(entry);
    } else if (state?.errorCurrent && !options.retryErrors) {
      partition.heldError.push(entry);
    } else {
      partition.pending.push(entry);
    }
  }
  return partition;
}
