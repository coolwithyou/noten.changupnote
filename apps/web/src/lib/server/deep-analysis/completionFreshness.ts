export interface DeepAnalysisCompletionInputIdentity {
  sealed: boolean;
  sourceRevisionSha256: string;
  inputSha256: string;
}

export interface DeepAnalysisCompletionFreshnessFailure {
  errorCode:
    | "source_revision_changed"
    | "input_changed_during_analysis"
    | "input_not_sealed_before_completion";
  message: string;
  reasons: Array<
    | "source_revision_changed"
    | "input_changed"
    | "input_not_sealed"
  >;
  baseline: {
    sourceRevisionSha256: string;
    inputSha256: string;
  };
  current: DeepAnalysisCompletionInputIdentity;
}

/**
 * Paid analysis 결과를 S11로 닫기 직전에 source/input identity를 다시 확인한다.
 * 변경된 source revision은 새 job을 먼저 보장하고, 현재 run은 stale로 끝낸 뒤
 * 호출자에게 실패를 돌려 analysis_complete receipt 생성을 막는다.
 */
export async function ensureDeepAnalysisCompletionInputFresh(input: {
  baseline: Pick<
    DeepAnalysisCompletionInputIdentity,
    "sourceRevisionSha256" | "inputSha256"
  >;
  loadCurrent: () => Promise<DeepAnalysisCompletionInputIdentity>;
  enqueueReplacement: (
    current: DeepAnalysisCompletionInputIdentity,
  ) => Promise<void>;
  markCurrentRunStale: (
    failure: DeepAnalysisCompletionFreshnessFailure,
  ) => Promise<void>;
}): Promise<void> {
  const loaded = await input.loadCurrent();
  const current: DeepAnalysisCompletionInputIdentity = {
    sealed: loaded.sealed,
    sourceRevisionSha256: loaded.sourceRevisionSha256,
    inputSha256: loaded.inputSha256,
  };
  const reasons: DeepAnalysisCompletionFreshnessFailure["reasons"] = [];
  if (
    current.sourceRevisionSha256
    !== input.baseline.sourceRevisionSha256
  ) {
    reasons.push("source_revision_changed");
  }
  if (current.inputSha256 !== input.baseline.inputSha256) {
    reasons.push("input_changed");
  }
  if (!current.sealed) reasons.push("input_not_sealed");
  if (reasons.length === 0) return;

  const errorCode = reasons.includes("source_revision_changed")
    ? "source_revision_changed"
    : reasons.includes("input_changed")
      ? "input_changed_during_analysis"
      : "input_not_sealed_before_completion";
  const message = `Deep analysis input is not sealed before completion: ${reasons.join(",")}`;
  const failure: DeepAnalysisCompletionFreshnessFailure = {
    errorCode,
    message,
    reasons,
    baseline: {
      sourceRevisionSha256: input.baseline.sourceRevisionSha256,
      inputSha256: input.baseline.inputSha256,
    },
    current,
  };

  if (reasons.includes("source_revision_changed")) {
    await input.enqueueReplacement(current);
  }
  await input.markCurrentRunStale(failure);
  throw new Error(message);
}
