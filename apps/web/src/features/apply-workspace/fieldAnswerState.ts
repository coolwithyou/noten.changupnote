/**
 * 클라이언트 필드 답변 상태 유틸 (Apply Experience v2 · §4.3 컨펌 규약 · P2-6).
 *
 * 서버 도메인 모듈(fieldAnswers.ts)은 core 를 import 하므로 클라이언트로 값 반입하지 않는다.
 * 여기서는 타입만 `import type` 으로 참조하고, 필요한 순수 로직(정규화 label 키·낙관적 병합·오버레이
 * 상태색 매핑)만 클라이언트-안전하게 재구현한다.
 */
import type {
  DraftFieldAnswer,
  DraftFieldAnswers,
  DraftFieldAnswerStatus,
} from "@/lib/server/documents/fieldAnswers";
import type { PreviewOverlayState } from "@/features/document-viewer/PreviewCanvas";

// fieldAnswers.ts 의 normalizeAnswerLabel 과 동일 규약(trim + 160자 절단).
const LABEL_MAX_LENGTH = 160;

/** 답변 맵 조회/기록에 쓰는 정규화 label 키. 서버 normalizeAnswerLabel 과 동형이라 왕복 일관성 유지. */
export function answerKey(label: string): string {
  return label.trim().slice(0, LABEL_MAX_LENGTH);
}

/**
 * 필드 오버레이/뱃지 상태색 판정. duplicateLabels(정규화 label 충돌)는 상태와 무관하게 노랑("확인 필요")
 * 로 잡는다 — 해당 label 은 HWPX 채움에서 제외되어 항상 수동 확인이 필요하기 때문(ADR-5 label 충돌 정책).
 */
export function fieldVisualState(
  label: string,
  answers: DraftFieldAnswers,
  duplicateLabels: Set<string>,
): PreviewOverlayState {
  if (duplicateLabels.has(label)) return "warning";
  const answer = answers[answerKey(label)];
  if (!answer || answer.status === "dismissed") return "empty";
  if (answer.status === "suggested") return "suggested";
  if (answer.status === "accepted" || answer.status === "edited") return "confirmed";
  return "empty";
}

/**
 * 낙관적 병합: 서버 applyFieldAnswerPatch 와 동형으로 로컬 상태를 갱신한다(제안 계보 보존).
 * 서버 응답(fieldAnswers)이 도착하면 그것으로 덮어써 정합을 맞춘다.
 */
export function optimisticApply(
  current: DraftFieldAnswers,
  label: string,
  entry: { value?: string; status: DraftFieldAnswerStatus },
): DraftFieldAnswers {
  const key = answerKey(label);
  const existing = current[key];
  const value = entry.value !== undefined ? entry.value.trim().slice(0, 4000) : existing?.value ?? "";
  const suggestedValue =
    existing?.suggestedValue ?? (existing?.status === "suggested" ? existing.value : undefined);
  const merged: DraftFieldAnswer = {
    value,
    status: entry.status,
    source: existing?.source ?? "user",
    updatedAt: new Date().toISOString(),
  };
  if (suggestedValue !== undefined) merged.suggestedValue = suggestedValue;
  if (existing?.basis !== undefined) merged.basis = existing.basis;
  if (existing?.fieldId !== undefined) merged.fieldId = existing.fieldId;
  return { ...current, [key]: merged };
}
