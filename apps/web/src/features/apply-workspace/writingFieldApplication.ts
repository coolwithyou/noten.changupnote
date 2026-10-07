import { isReplaceableRhwpGuide } from "@/lib/rhwp/guideText";
/** Match the existing verified field transaction and server materialized-answer limits. */
export function canApplySavedWritingToField(binding: { status: string; beforeText?: string; targetKind?: string } | null | undefined, sourceSpan: string | null | undefined, text: string, options?: { allowReviewedOverwrite: boolean }): boolean {
  if (!binding || binding.status !== "unique" || !["table_cell_text", "table_cell_region"].includes(binding.targetKind ?? "") || typeof binding.beforeText !== "string" || !text.trim() || text.length > 4_000) return false;
  return !binding.beforeText.trim() || isReplaceableRhwpGuide(binding.beforeText.trim(), sourceSpan, null) || options?.allowReviewedOverwrite === true;
}
export interface WritingApplicationReview { fieldId: string; beforeText: string; text: string; revision: number; requiresConfirmation: boolean; confirmed: boolean }
export function assertWritingApplicationCurrent(application: WritingApplicationReview,
  saved: { revision: number; text: string } | undefined, canWrite: boolean,
  binding: { beforeText: string; requiresConfirmation?: boolean } | null): void {
  if (application.requiresConfirmation && !application.confirmed) throw new Error("현재 내용을 검토하고 교체에 동의해 주세요.");
  if (!canWrite || saved?.revision !== application.revision || saved.text !== application.text) throw new Error("저장 문안이 바뀌었어요. 최신 저장본을 확인한 뒤 다시 비교해 주세요.");
  if (!binding || binding.beforeText !== application.beforeText || Boolean(binding.requiresConfirmation) !== application.requiresConfirmation) throw new Error("양식 내용이나 입력 위치가 바뀌었어요. 다시 비교한 뒤 반영해 주세요.");
}
