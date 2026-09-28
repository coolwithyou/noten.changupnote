import type { LabRun } from "./lab-contract";

/**
 * 원문 판독 실패를 스스로 기록한 자격·제외 조건은 검수 verdict가 correct여도 발행하지 않는다.
 * 일반적인 해석 불확실성은 이 검사 범위 밖이다. 대체 원문으로 확인했다면
 * 판독 불가라고 기록된 기존 run 대신 근거를 결속한 수리 run으로 발행한다.
 */
export function hasUnreadableEligibilitySource(run: Pick<LabRun, "criteria">): boolean {
  return run.criteria.some((criterion) => {
    if (criterion.kind !== "required" && criterion.kind !== "exclusion") return false;
    const note = (criterion.note ?? "").normalize("NFKC").replace(/\s+/gu, " ");
    return /(?:OCR|스캔|이미지).{0,100}(?:판독\s*불가|해독\s*불가)/iu.test(note);
  });
}
