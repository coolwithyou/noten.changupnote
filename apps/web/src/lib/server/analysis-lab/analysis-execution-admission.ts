import {
  currentDeepRepairLiveExecutionBinding,
  type DeepRepairLiveExecutionBinding,
} from "./deep-repair-live-experiment";
import { currentApplicationRoundtripCanaryExecutionBinding } from "./application-roundtrip/canary";

export type AnalysisLabReceiptBoundExecutionBinding = DeepRepairLiveExecutionBinding;

export type AnalysisLabReceiptBoundExecutionExpectation =
  Omit<AnalysisLabReceiptBoundExecutionBinding, "authoritySha256">
  & { readonly authoritySha256?: string };

const RECEIPT_BINDING_FIELDS = [
  "authoritySha256",
  "grantId",
  "inputSha256",
  "attachmentManifestSha256",
  "model",
  "transport",
  "promptVersion",
] as const satisfies readonly (keyof AnalysisLabReceiptBoundExecutionBinding)[];

/**
 * Gate R circuit breaker.
 *
 * 현재 허용되는 경로는 모델 호출 없는 dry-run, plan-only, shadow replay뿐이다.
 * runtime lease는 운영 API와 로컬 실행의 상호배타만 증명하며 exact cohort/provenance와
 * 사용자 canary 승인을 증명하지 못한다. 따라서 환경변수나 기존 lease로 이 경계를
 * 열지 않는다. live `lab:experiment` core가 exact authority를 검증해 연 callback에만
 * read-only capability가 존재하며, 모든 legacy 진입점은 계속 차단한다.
 */
export class AnalysisLabExecutionPausedError extends Error {
  readonly code = "gate_r_not_satisfied" as const;

  constructor(operation: "모델 실행" | "cohort mutation") {
    super(
      `Gate R이 아직 충족되지 않아 analysis-lab ${operation}을 중단합니다. `
      + "현재는 dry-run, plan-only, createPlan/replay만 허용하며 runtime lease나 환경변수로 우회할 수 없습니다.",
    );
    this.name = "AnalysisLabExecutionPausedError";
  }
}

export class AnalysisLabExecutionBindingMismatchError extends Error {
  readonly code = "receipt_bound_execution_mismatch" as const;

  constructor(field: keyof AnalysisLabReceiptBoundExecutionBinding) {
    super(`receipt-bound authority와 실행 binding이 다릅니다: ${field}`);
    this.name = "AnalysisLabExecutionBindingMismatchError";
  }
}

/** legacy 진입점은 core capability 안에서도 열지 않는다. exact expected가 항상 필요하다. */
export function assertAnalysisLabLiveExecutionAdmitted(
  expected?: AnalysisLabReceiptBoundExecutionExpectation,
): void {
  if (!expected) throw new AnalysisLabExecutionPausedError("모델 실행");
  const admitted = currentDeepRepairLiveExecutionBinding();
  if (!admitted) throw new AnalysisLabExecutionPausedError("모델 실행");
  const normalizedExpected = normalizeExecutionExpectation(expected);
  for (const field of RECEIPT_BINDING_FIELDS) {
    if (field === "authoritySha256" && normalizedExpected.authoritySha256 === undefined) continue;
    if (admitted[field] !== normalizedExpected[field]) {
      throw new AnalysisLabExecutionBindingMismatchError(field);
    }
  }
}

/** exact prepared 경계가 검증된 뒤 같은 core callback의 하위 transport만 통과시킨다. */
export function assertAnalysisLabReceiptBoundTransportAdmitted(): void {
  if (!currentDeepRepairLiveExecutionBinding() && !currentApplicationRoundtripCanaryExecutionBinding()) {
    throw new AnalysisLabExecutionPausedError("모델 실행");
  }
}

export function assertAnalysisLabCohortMutationAdmitted(): void {
  throw new AnalysisLabExecutionPausedError("cohort mutation");
}

function normalizeExecutionExpectation(
  binding: AnalysisLabReceiptBoundExecutionExpectation,
): AnalysisLabReceiptBoundExecutionExpectation {
  if (binding.authoritySha256 !== undefined) {
    assertSha256(binding.authoritySha256, "authoritySha256");
  }
  assertSha256(binding.inputSha256, "inputSha256");
  assertSha256(binding.attachmentManifestSha256, "attachmentManifestSha256");
  for (const [field, value] of [
    ["grantId", binding.grantId],
    ["model", binding.model],
    ["promptVersion", binding.promptVersion],
  ] as const) {
    if (value.trim() === "") throw new AnalysisLabExecutionBindingMismatchError(field);
  }
  if (binding.transport !== "claude-cli") {
    throw new AnalysisLabExecutionBindingMismatchError("transport");
  }
  return binding;
}

function assertSha256(
  value: string,
  field: "authoritySha256" | "inputSha256" | "attachmentManifestSha256",
): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new AnalysisLabExecutionBindingMismatchError(field);
  }
}
