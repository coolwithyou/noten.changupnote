/**
 * Text parser 후보화 (Phase 4 [F2] · 마스터 설계 §8.5).
 *
 * `extractGrantDocumentFields()` 의 출력(`ExtractedGrantDocumentField[]`)을
 * `CandidateSet`(layer=text_parser) 으로 변환하는 **순수 래퍼**다. 원함수는 무변경 —
 * §8.5 대로 최종 결과 생성기를 "후보 evidence 생성기"로 재사용한다.
 *
 * text parser 후보의 성질:
 *   - bbox 없음(page/bbox = null), bboxSource = "text_parser".
 *   - label = 필드 라벨, text = "" (parser 는 채움값이 아니라 라벨/구조를 낸다).
 *   - raw 에 원 필드 전체를 보존 → reconciliation 이 fieldKey/fillStrategy/section/
 *     sourceSpan 등 텍스트 근거를 그대로 승계할 수 있다.
 */
import type { DocumentFieldType } from "@cunote/contracts";
import type { ExtractedGrantDocumentField } from "./field-extraction.js";
import type { CandidateKind, CandidateSet, NormalizedFieldCandidate } from "./field-candidates.js";

export interface ToTextParserCandidateSetOptions {
  /** 엔진 식별자 (기본 "text-parser"). */
  engine?: string;
  /** 파서 버전. 미지정 시 첫 필드의 parserVersion, 없으면 "unknown". */
  engineVersion?: string;
  /** 생성 시각. 미지정 시 현재 시각 ISO. */
  extractedAt?: string;
}

/** DocumentFieldType → CandidateKind. §8.4 어휘로 수렴. */
export function fieldTypeToCandidateKind(fieldType: DocumentFieldType): CandidateKind {
  switch (fieldType) {
    case "long_text":
      return "long_text";
    case "checkbox":
      return "checkbox";
    case "table":
      return "table_cell";
    case "file":
      return "file_attach";
    case "unknown":
      return "unknown";
    case "text":
    case "number":
    case "date":
    case "currency":
    default:
      return "text_input";
  }
}

/** 서명/직인 성격이면 kind 를 signature/stamp 로 승격 (§8.6 rule ④ 입력). */
function refineManualKind(field: ExtractedGrantDocumentField, base: CandidateKind): CandidateKind {
  const key = field.fieldKey.toLowerCase();
  if (key.includes("stamp") || /직인|날인/.test(field.label)) return "stamp";
  if (
    key.includes("signature") ||
    /서명|서약|확약/.test(field.label) ||
    (field.fillStrategy === "manual" && /동의/.test(field.label))
  ) {
    return "signature";
  }
  return base;
}

function toCandidate(field: ExtractedGrantDocumentField): NormalizedFieldCandidate {
  const baseKind = fieldTypeToCandidateKind(field.fieldType);
  return {
    page: null,
    bbox: null,
    bboxSource: "text_parser",
    layer: "text_parser",
    kind: refineManualKind(field, baseKind),
    label: field.label,
    text: "",
    confidence: typeof field.confidence === "number" ? field.confidence : null,
    rotationDeg: null,
    // 원 필드 전체 보존 — reconciliation 이 텍스트 근거를 승계한다.
    raw: { ...field },
  };
}

/**
 * `extractGrantDocumentFields` 출력을 text_parser CandidateSet 으로 변환한다.
 * 순수 함수 — I/O 없음.
 */
export function toTextParserCandidateSet(
  fields: ExtractedGrantDocumentField[],
  opts: ToTextParserCandidateSetOptions = {},
): CandidateSet {
  const engineVersion = opts.engineVersion ?? fields[0]?.parserVersion ?? "unknown";
  return {
    engine: opts.engine ?? "text-parser",
    engineVersion,
    layer: "text_parser",
    extractedAt: opts.extractedAt ?? new Date().toISOString(),
    candidates: fields.map(toCandidate),
  };
}
