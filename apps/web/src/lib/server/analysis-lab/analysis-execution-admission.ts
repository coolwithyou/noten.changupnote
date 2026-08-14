/**
 * Gate R circuit breaker.
 *
 * 현재 허용되는 경로는 모델 호출 없는 dry-run, plan-only, shadow replay뿐이다.
 * runtime lease는 운영 API와 로컬 실행의 상호배타만 증명하며 exact cohort/provenance와
 * 사용자 canary 승인을 증명하지 못한다. 따라서 환경변수나 기존 lease로 이 경계를
 * 열지 않는다. 향후 live `lab:experiment` Adapter가 receipt-bound authority를 소유할 때
 * 이 정적 차단기를 해당 authority 검증으로 교체한다.
 */
export class AnalysisLabExecutionPausedError extends Error {
  readonly code = "gate_r_not_satisfied" as const;

  constructor(operation: "모델 실행" | "cohort mutation" | "promotion mutation") {
    super(
      `Gate R이 아직 충족되지 않아 analysis-lab ${operation}을 중단합니다. `
      + "현재는 dry-run, plan-only, createPlan/replay만 허용하며 runtime lease나 환경변수로 우회할 수 없습니다.",
    );
    this.name = "AnalysisLabExecutionPausedError";
  }
}

export function assertAnalysisLabLiveExecutionAdmitted(): void {
  throw new AnalysisLabExecutionPausedError("모델 실행");
}

export function assertAnalysisLabCohortMutationAdmitted(): void {
  throw new AnalysisLabExecutionPausedError("cohort mutation");
}

export function assertAnalysisLabPromotionMutationAdmitted(): void {
  throw new AnalysisLabExecutionPausedError("promotion mutation");
}
