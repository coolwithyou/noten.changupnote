import { isReplaceableRhwpGuide } from "@/lib/rhwp/guideText";
/** Match the existing verified field transaction and server materialized-answer limits. */
export function canApplySavedWritingToField(binding: { status: string; beforeText?: string; targetKind?: string } | null | undefined, sourceSpan: string | null | undefined, text: string): boolean {
  if (!binding || binding.status !== "unique" || binding.targetKind !== "table_cell_text" || typeof binding.beforeText !== "string" || !text.trim() || text.length > 4_000) return false;
  return !binding.beforeText.trim() || isReplaceableRhwpGuide(binding.beforeText.trim(), sourceSpan, null);
}
