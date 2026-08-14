/**
 * LabRun의 실행 오류와 primary 품질 결과를 하나의 도메인 outcome으로 정규화한다.
 *
 * 기존 artifact는 held를 error sentinel로 저장했으므로 reader 호환을 유지한다. 반대로
 * 명시 outcome과 error가 모순되면 인프라 오류를 숨기지 않도록 failed로 닫는다.
 */

export const PRIMARY_VALIDATION_HELD_ERROR_PREFIX = "primary_validation_held:";

export type LabRunOutcome = "publishable" | "held" | "failed";

export interface LabRunOutcomeInput {
  primaryValidationOutcome?: unknown;
  error?: unknown;
}

export function isPrimaryValidationHeldError(error: unknown): boolean {
  return typeof error === "string" && error.startsWith(PRIMARY_VALIDATION_HELD_ERROR_PREFIX);
}

export function classifyLabRunOutcome(run: LabRunOutcomeInput): LabRunOutcome {
  const outcome = run.primaryValidationOutcome;
  const error = run.error;

  if (outcome === undefined) {
    if (error === null) return "publishable";
    return isPrimaryValidationHeldError(error) ? "held" : "failed";
  }
  if (outcome === "publishable") return error === null ? "publishable" : "failed";
  if (outcome === "held") {
    return error === null || isPrimaryValidationHeldError(error) ? "held" : "failed";
  }
  return "failed";
}

export function isPublishableLabRun(run: LabRunOutcomeInput): boolean {
  return classifyLabRunOutcome(run) === "publishable";
}

export function isTerminalLabRun(run: LabRunOutcomeInput): boolean {
  return classifyLabRunOutcome(run) !== "failed";
}
