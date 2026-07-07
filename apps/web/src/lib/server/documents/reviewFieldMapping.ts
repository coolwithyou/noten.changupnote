/**
 * 검수 라벨(field_map_review_docs.labelJson.fields) ↔ 도메인 필드 매핑 (슬라이스 B, 순수 함수).
 *
 * 정본: docs/plans/2026-07-08-ideal-flow-vertical-slice.md "슬라이스 B".
 * 상위 기준서: docs/gate1-field-map-labeling-guide.md (라벨 판정 규칙 1~10 · 표준 key 사전).
 *
 * 여기 모인 함수는 전부 I/O 없는 순수 함수다 (DB/R2/LLM 의존 0) — 단위 검증 가능.
 *   - parsePrelabelResponse: B2 LLM 응답 JSON → 정규화 prelabel 필드 + 드롭 사유.
 *   - prelabelFieldToReviewField: prelabel 필드 → 검수 GUI 가 소비하는 labelJson.fields 형태.
 *   - reviewFieldsToReconciled: 확정 labelJson.fields → ReconciledField[] (B3 승인 반영 브리지).
 *
 * labelJson.fields 형태는 검수 GUI(features/review/ReviewDetailView) 와 spike-labels/*.json 이 쓰는
 * 계약과 동일하다: { key, label, section, type, required, applicantFills, manual, page, bbox, notes }.
 * bbox 는 §8.4 좌표계(0~1 정규화, top-left) 의 [x, y, w, h] 배열.
 */
import type { DocumentFieldType, DocumentFillStrategy } from "@cunote/contracts";
import type { ReconciledField } from "@cunote/core";
import { parseBbox } from "@/lib/documents/bbox";

// ---------------------------------------------------------------------------
// 상수 · 타입
// ---------------------------------------------------------------------------

/**
 * B1 유입기가 심는 docRef 네임스페이스 접두어. `surface:<surfaceId>`.
 * 이 접두어가 B2 사전라벨 대상 조건이자 B3 승인 반영 브리지의 발동 조건이다.
 */
export const SURFACE_DOC_REF_PREFIX = "surface:";

/** §8.4 좌표계 bbox 튜플 [x, y, w, h] (0~1). */
export type BboxTuple = [number, number, number, number];

/** B2 LLM 사전라벨 출력의 정규화 필드. (프롬프트 계약: label/fieldKey/fieldType/required/section/page/bbox/sourceSpan) */
export interface PrelabelField {
  fieldKey: string | null;
  label: string;
  section: string | null;
  fieldType: DocumentFieldType;
  required: boolean;
  /** 자필/서명 필요 (고유식별정보·서명·동의 — 기준서 manual 판정). */
  manual: boolean;
  page: number | null;
  bbox: BboxTuple | null;
  sourceSpan: string | null;
}

/** 검수 GUI 가 소비하는 labelJson.fields 한 항목 (spike-labels 계약과 동일). */
export interface ReviewLabelField {
  key?: string;
  label?: string;
  section?: string;
  type?: string;
  required?: boolean;
  applicantFills?: boolean;
  manual?: boolean;
  page?: number;
  bbox?: BboxTuple | null;
  /** 라벨이 명시적으로 fillStrategy 를 실으면 B3 가 우선 사용 (없으면 'manual' 기본). */
  fillStrategy?: string;
  sourceSpan?: string;
  notes?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// enum coerce (도메인 계약 준수)
// ---------------------------------------------------------------------------

/** grant_document_fields.field_type 가 허용하는 값 (contracts DocumentFieldType). */
const FIELD_TYPES: readonly DocumentFieldType[] = [
  "text",
  "long_text",
  "number",
  "date",
  "currency",
  "checkbox",
  "table",
  "file",
  "unknown",
];

/** grant_document_fields.fill_strategy 가 허용하는 값 (contracts DocumentFillStrategy). */
const FILL_STRATEGIES: readonly DocumentFillStrategy[] = [
  "copy",
  "summarize",
  "generate",
  "ask_user",
  "manual",
];

/**
 * 라벨 type → DocumentFieldType.
 * 검수 라벨은 signature/stamp 를 쓰지만 grant_document_fields 는 이를 열거하지 않는다(§dto).
 * signature/stamp 는 사람이 직접 처리하는 칸이므로 'text'(값 없는 서명란)으로 수렴하고 manual 로 표식한다.
 */
export function coerceFieldType(type: string | null | undefined): DocumentFieldType {
  if (!type) return "unknown";
  const t = type.trim().toLowerCase();
  if ((FIELD_TYPES as readonly string[]).includes(t)) return t as DocumentFieldType;
  if (t === "signature" || t === "stamp") return "text";
  return "unknown";
}

/** 라벨 fillStrategy → DocumentFillStrategy. 알 수 없으면 null(호출부에서 기본값 결정). */
export function coerceFillStrategy(value: string | null | undefined): DocumentFillStrategy | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return (FILL_STRATEGIES as readonly string[]).includes(v) ? (v as DocumentFillStrategy) : null;
}

/** 라벨 type 이 서명/도장 성격인가 (manual 강제 판단 보조). */
function isSignatureType(type: string | null | undefined): boolean {
  const t = (type ?? "").trim().toLowerCase();
  return t === "signature" || t === "stamp";
}

/** 한글/영숫자만 남긴 스네이크 slug (field-reconciliation.slug 규약과 동일 형태). */
export function slugFieldKey(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return s || "field";
}

/** 배열/객체 bbox 입력을 §8.4 [x,y,w,h] 튜플로 정규화(범위 이탈은 null). bbox.ts parseBbox 재사용. */
export function normalizeBboxTuple(value: unknown): BboxTuple | null {
  const box = parseBbox(value);
  if (!box) return null;
  return [box.x, box.y, box.width, box.height];
}

// ---------------------------------------------------------------------------
// B2 — LLM 사전라벨 응답 파싱 (순수)
// ---------------------------------------------------------------------------

interface RawPrelabelField {
  fieldKey?: unknown;
  key?: unknown;
  label?: unknown;
  section?: unknown;
  fieldType?: unknown;
  type?: unknown;
  required?: unknown;
  manual?: unknown;
  page?: unknown;
  bbox?: unknown;
  sourceSpan?: unknown;
}

export interface ParsePrelabelResult {
  fields: PrelabelField[];
  /** 버려진 항목 사유 (검증 로깅용). */
  dropped: string[];
}

/**
 * LLM 응답 텍스트(코드펜스/설명 혼입 허용) → 정규화 prelabel 필드.
 * label 이 비면 버린다(식별 불가). 그 외 필드는 관대하게 정규화한다.
 * status/reviewStatus 는 여기서 다루지 않는다 — 순환성 가드는 저장 계층(B2 러너)의 책임.
 */
export function parsePrelabelResponse(text: string): ParsePrelabelResult {
  const parsed = extractJsonObject(text);
  const rawFields = Array.isArray((parsed as { fields?: unknown })?.fields)
    ? ((parsed as { fields: unknown[] }).fields as RawPrelabelField[])
    : [];

  const fields: PrelabelField[] = [];
  const dropped: string[] = [];

  rawFields.forEach((raw, i) => {
    const label = str(raw.label);
    if (!label) {
      dropped.push(`empty_label:#${i}`);
      return;
    }
    const fieldKeyRaw = str(raw.fieldKey) ?? str(raw.key);
    const typeRaw = str(raw.fieldType) ?? str(raw.type);
    const manualFlag = raw.manual === true || isSignatureType(typeRaw);
    fields.push({
      fieldKey: fieldKeyRaw ? slugFieldKey(fieldKeyRaw) : null,
      label,
      section: str(raw.section),
      fieldType: coerceFieldType(typeRaw),
      required: raw.required === true,
      manual: manualFlag,
      page: intOrNull(raw.page),
      bbox: normalizeBboxTuple(raw.bbox),
      sourceSpan: str(raw.sourceSpan),
    });
  });

  return { fields, dropped };
}

/** prelabel 필드 → 검수 GUI labelJson.fields 항목. GUI 가 즉시 렌더/편집할 수 있는 형태로 낮춘다. */
export function prelabelFieldToReviewField(pf: PrelabelField): ReviewLabelField {
  return {
    key: pf.fieldKey ?? "",
    label: pf.label,
    section: pf.section ?? "",
    // GUI type enum 에는 signature/stamp 도 있으나, 사전라벨은 도메인 안전값으로 낮춘다(coerceFieldType).
    type: pf.fieldType,
    required: pf.required,
    applicantFills: true,
    manual: pf.manual,
    page: pf.page ?? 1,
    bbox: pf.bbox,
    ...(pf.sourceSpan ? { sourceSpan: pf.sourceSpan } : {}),
    notes: "",
  };
}

// ---------------------------------------------------------------------------
// B3 — 확정 라벨 → ReconciledField[] (승인 반영 브리지 매핑, 순수)
// ---------------------------------------------------------------------------

export interface ReviewToReconciledOptions {
  /** field 에 documentName/documentCategory 가 없을 때 applyReconciledFields 가 쓸 기본값(여기선 통과만). */
  documentName?: string | null;
  documentCategory?: string | null;
}

/**
 * 확정 검수 라벨(labelJson.fields) → ReconciledField[].
 *
 * 출처 표식: 이 경로는 "전문가 사람 검수 확정"(human_review) 유래다. reconcile 후보 파이프라인이 아니라
 *   승인된 라벨을 곧바로 반영하므로 confidence=1.0 · reviewRequired=false 로 고정한다. 저장 시
 *   parserVersion 은 applyReconciledFields 의 reconcile-v0 를 그대로 쓰되(백필 전략 표식), 유래는
 *   visualEvidence.source='human_review' 로 남긴다.
 *
 * 매핑 규칙:
 *   - fieldKey: 라벨 key 가 있으면 slug 정규화, 없으면 label 기반 slug 폴백. 충돌 시 -2, -3 접미
 *     (applyReconciledFields upsert 키가 (surfaceId, fieldKey) 라 중복 키는 서로를 덮어써 인스턴스를
 *      잃는다 — 기준서 규칙2 의 반복 key 도 저장 단계에서는 유일화해 전부 보존한다).
 *   - fieldType: signature/stamp → text 등 도메인 enum 으로 coerce.
 *   - fillStrategy: 라벨에 명시가 있으면 사용, manual=true 면 'manual' 강제, 그 밖에는 'manual' 기본
 *     (사전 fill planner(슬라이스 D) 전까지는 자동채움을 열지 않는 보수적 기본값).
 *   - position: bbox 가 유효하면 { page, bbox }, page 만 있으면 { page, bbox:null }, 둘 다 없으면 null.
 */
export function reviewFieldsToReconciled(
  fields: readonly ReviewLabelField[],
  _opts: ReviewToReconciledOptions = {},
): ReconciledField[] {
  const usedKeys = new Set<string>();
  const out: ReconciledField[] = [];

  for (const field of fields) {
    const label = (str(field.label) ?? str(field.key) ?? "(무제 항목)") as string;
    const baseKey = str(field.key) ? slugFieldKey(str(field.key) as string) : slugFieldKey(label);
    const fieldKey = uniqueKey(usedKeys, baseKey);

    const fieldType = coerceFieldType(field.type);
    const manual = field.manual === true || isSignatureType(field.type);
    const explicitStrategy = coerceFillStrategy(field.fillStrategy);
    const fillStrategy: DocumentFillStrategy = manual
      ? "manual"
      : explicitStrategy ?? "manual";

    const bbox = normalizeBboxTuple(field.bbox);
    const page = intOrNull(field.page);
    const position =
      bbox || page !== null ? { page, bbox } : null;

    out.push({
      fieldKey,
      label,
      section: str(field.section),
      fieldType,
      required: field.required === true,
      fillStrategy,
      confidence: 1,
      tier: "high",
      position,
      visualEvidence: {
        source: "human_review",
        label,
        ...(bbox ? { bbox } : {}),
        ...(page !== null ? { page } : {}),
      },
      textEvidence: str(field.sourceSpan)
        ? { source: "human_review", sourceSpan: str(field.sourceSpan) }
        : null,
      reviewRequired: false,
      mappedCompanyField: null,
      sourceSpan: str(field.sourceSpan),
      documentName: null,
      documentCategory: null,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 헬퍼 (순수)
// ---------------------------------------------------------------------------

function uniqueKey(used: Set<string>, base: string): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  const key = `${base}-${n}`;
  used.add(key);
  return key;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

function intOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) {
    const n = Number(v.trim());
    return n >= 1 ? n : null;
  }
  return null;
}

/** 코드펜스/설명 혼입을 허용해 첫 { ~ 마지막 } 를 JSON 으로 파싱. 실패 시 {}. (generate-review-questions.extractJson 규약) */
function extractJsonObject(text: string): unknown {
  const trimmed = (text ?? "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fence ? fence[1] : trimmed) ?? "";
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  try {
    return JSON.parse(slice);
  } catch {
    return {};
  }
}
