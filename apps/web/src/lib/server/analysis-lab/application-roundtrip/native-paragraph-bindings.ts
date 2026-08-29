import type { RoundtripFieldCandidate } from "./contract";
import { resolveStudioParagraphFieldBindings } from "@/lib/rhwp/studioParagraphFieldBindings";
import { loadDocumentAgentCore } from "@/lib/server/rhwp/documentAgentCore";

const VERIFIED_SIGNAL = "RHWP native 문단 exact binding 확인";
const REJECTED_SIGNAL_PREFIX = "RHWP native 문단 결속 불가로 안전 제외";

/**
 * Kordoc의 문단 텍스트만으로는 Studio의 native 문단 좌표를 보장할 수 없다.
 * 같은 원본 바이트를 RHWP core로 다시 열어 unique·무제어·단일서식 문단만 유지한다.
 */
export async function verifyRoundtripParagraphFieldBindings(input: {
  body: Uint8Array;
  fields: RoundtripFieldCandidate[];
}): Promise<{ verifiedCount: number; rejectedCount: number; warnings: string[] }> {
  const candidates = input.fields.filter(field => field.location.target?.kind === "paragraph_text");
  if (candidates.length === 0) return { verifiedCount: 0, rejectedCount: 0, warnings: [] };

  let resolutions: ReturnType<typeof resolveStudioParagraphFieldBindings>;
  try {
    const rhwp = await loadDocumentAgentCore();
    const document = new rhwp.HwpDocument(input.body);
    try {
      resolutions = resolveStudioParagraphFieldBindings(document, candidates.map(field => ({
        fieldId: field.fieldInstanceId,
        fieldKey: field.normalizedLabel,
        label: field.label,
        fieldType: field.type,
        position: {
          targetKind: "body_paragraph_text",
          paragraphPrefix: field.location.target?.paragraphPrefix ?? "",
          paragraphSuffix: field.location.target?.paragraphSuffix ?? "",
          paragraphOccurrence: field.location.target?.paragraphOccurrence ?? 0,
        },
      })));
    } finally {
      document.free();
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const field of candidates) rejectField(field, "검증기 오류");
    return {
      verifiedCount: 0,
      rejectedCount: candidates.length,
      warnings: [`본문 필드 native 검증 실패: ${reason}`],
    };
  }

  const warnings: string[] = [];
  let verifiedCount = 0;
  let rejectedCount = 0;
  resolutions.forEach((resolution, index) => {
    const field = candidates[index]!;
    if (resolution.status === "unique") {
      field.inputSignals.push(VERIFIED_SIGNAL);
      verifiedCount += 1;
      return;
    }
    const reason = resolution.status === "ambiguous" ? "중복 위치" : "위치 또는 단일서식 불일치";
    rejectField(field, reason);
    warnings.push(`${field.displayLabel || field.label}: ${reason}`);
    rejectedCount += 1;
  });
  return { verifiedCount, rejectedCount, warnings };
}

function rejectField(field: RoundtripFieldCandidate, reason: string): void {
  field.recommendedInput = false;
  field.inputLikelihood = Math.min(field.inputLikelihood, 0.1);
  field.inputSignals.push(`${REJECTED_SIGNAL_PREFIX}: ${reason}`);
}
