/**
 * Field Reconciliation 골격 (Phase 4 [F4] · 마스터 설계 §8.6).
 *
 * layout / text_parser 후보 묶음을 합쳐 grant_document_fields 형상의 최종 필드맵
 * (`ReconciledField[]`)을 만드는 **순수 함수**다. I/O 없음 — 저장·반영은 F3/F5 가 담당.
 *
 * §8.6 신뢰도 규칙 (plan doc F4 ①~⑥):
 *   ① text + layout 이 같은 항목(라벨 정규화 매칭 + page 호환) → high
 *   ② layout 만 잡은 빈칸 → medium
 *   ③ text 만 있고 위치 없음 → medium
 *   ④ 서명/직인/동의 kind → fillStrategy `manual` 강제
 *   ⑤ layout 후보 간 중복은 bbox IoU 로 병합
 *   ⑥ 저신뢰 필드 → reviewRequired (운영 검수 큐)
 *
 * 임계값은 RECONCILE_THRESHOLDS 로 분리한다 — Gate 2 측정 전까지 잠정값.
 */
import type {
  DocumentFieldType,
  DocumentFillStrategy,
} from "@cunote/contracts";
import type {
  BBox,
  CandidateKind,
  CandidateSet,
  NormalizedFieldCandidate,
} from "./field-candidates.js";

/**
 * Reconciliation 임계값.
 *
 * **잠정 — Gate 2 측정 후 캘리브레이션.** 현재 값은 layout-eval 메트릭(IOU_THRESHOLD 0.5 /
 * LABEL_SIM_THRESHOLD 0.6)과 정합하도록 설정한 초기 추정치다. golden set 대비 coverage /
 * manual recall 측정([D]) 후 마스터 §13 임계값 캘리브레이션 단계에서 확정한다.
 */
export const RECONCILE_THRESHOLDS = {
  /** 라벨 정규화 유사도 매칭 컷 (rule ①). */
  labelMatch: 0.6,
  /** layout 후보 간 중복 병합 IoU 컷 (rule ⑤). */
  layoutMergeIou: 0.5,
  /** 이 값 미만 confidence 는 reviewRequired (rule ⑥). */
  lowConfidence: 0.5,
  /** high 티어(text+layout 합치) 기본 confidence (rule ①). */
  highConfidence: 0.9,
  /** medium 티어(단일 소스) 기본 confidence (rule ②③). */
  mediumConfidence: 0.6,
} as const;

/** grant_document_fields 형상의 최종 재조정 필드. */
export interface ReconciledField {
  fieldKey: string;
  label: string;
  section: string | null;
  fieldType: DocumentFieldType;
  required: boolean;
  fillStrategy: DocumentFillStrategy;
  confidence: number;
  /** 확정 신뢰도 티어 (디버그·정렬용). */
  tier: "high" | "medium" | "low";
  /** 좌표. layout 근거가 있으면 { page, bbox }, 없으면 null. */
  position: { page: number | null; bbox: BBox | null } | null;
  visualEvidence: Record<string, unknown> | null;
  textEvidence: Record<string, unknown> | null;
  reviewRequired: boolean;
  mappedCompanyField: string | null;
  sourceSpan: string | null;
  documentName: string | null;
  documentCategory: string | null;
}

export interface ReconcileOptions {
  thresholds?: Partial<typeof RECONCILE_THRESHOLDS>;
}

// ---------------------------------------------------------------------------
// 순수 기하/문자 헬퍼 (layout-eval/metrics.ts 와 동일 정의를 core 로 자립화)
// ---------------------------------------------------------------------------

/** NFKC + 소문자 + 공백/구두점 제거 (한글/영숫자만). */
function normalizeLabelText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** 문자 bigram Dice 계수 (0~1). 길이<2 는 완전일치만 1. */
function diceBigram(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, c] of A) {
    total += c;
    inter += Math.min(c, B.get(g) ?? 0);
  }
  for (const [, c] of B) total += c;
  return total === 0 ? 0 : (2 * inter) / total;
}

/** 정규화 label 유사도 (0~1). */
export function labelSimilarity(a: string, b: string): number {
  return diceBigram(normalizeLabelText(a), normalizeLabelText(b));
}

/** 두 [x,y,w,h] 의 IoU. */
export function iou(a: BBox, b: BBox): number {
  const ix = Math.max(a[0], b[0]);
  const iy = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[0] + a[2], b[0] + b[2]);
  const iy2 = Math.min(a[1] + a[3], b[1] + b[3]);
  const iw = Math.max(0, ix2 - ix);
  const ih = Math.max(0, iy2 - iy);
  const inter = iw * ih;
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni <= 0 ? 0 : inter / uni;
}

function clampConfidence(value: number): number {
  return Math.max(0.1, Math.min(0.99, Number(value.toFixed(3))));
}

/** page 호환: 둘 다 값이면 같아야, 하나라도 null 이면 호환(text_parser 는 page 없음). */
function pageCompatible(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

const MANUAL_LABEL_RE = /서명|날인|직인|동의|서약|확약/;

/** rule ④ 판정: 서명/직인/동의 성격인가. */
function isManualForced(kind: CandidateKind, label: string, fieldKey: string): boolean {
  if (kind === "signature" || kind === "stamp") return true;
  const key = fieldKey.toLowerCase();
  if (key.includes("signature") || key.includes("stamp") || key.includes("consent")) return true;
  return MANUAL_LABEL_RE.test(label);
}

function slug(value: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return s || "field";
}

// ---------------------------------------------------------------------------
// layout 후보 병합 (rule ⑤)
// ---------------------------------------------------------------------------

interface LayoutGroup {
  page: number | null;
  bbox: BBox | null;
  kind: CandidateKind;
  label: string;
  text: string;
  confidence: number | null;
  rotationDeg: number | null;
  engine: string;
  members: NormalizedFieldCandidate[];
}

function toLayoutGroup(cand: NormalizedFieldCandidate, engine: string): LayoutGroup {
  return {
    page: cand.page,
    bbox: cand.bbox,
    kind: cand.kind,
    label: cand.label,
    text: cand.text,
    confidence: cand.confidence,
    rotationDeg: cand.rotationDeg,
    engine,
    members: [cand],
  };
}

/**
 * rule ⑤: 같은 page + bbox IoU ≥ 임계값(라벨 유사 또는 동일 kind) 인 layout 후보를 병합한다.
 * 대표값은 confidence 가 가장 높은 멤버 기준.
 */
function mergeLayoutDuplicates(
  groups: LayoutGroup[],
  mergeIou: number,
): LayoutGroup[] {
  const merged: LayoutGroup[] = [];
  for (const group of groups) {
    const target = merged.find((existing) => {
      if (!existing.bbox || !group.bbox) return false;
      if (!pageCompatible(existing.page, group.page)) return false;
      if (iou(existing.bbox, group.bbox) < mergeIou) return false;
      const sameKind = existing.kind === group.kind;
      const labelClose =
        (existing.label && group.label && labelSimilarity(existing.label, group.label) >= 0.6) ||
        (!existing.label && !group.label);
      return sameKind || labelClose;
    });
    if (target) {
      target.members.push(...group.members);
      // 대표값: confidence 최대 멤버.
      const best = target.members.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a));
      target.page = best.page;
      target.bbox = best.bbox;
      target.kind = best.kind;
      target.label = best.label || target.label;
      target.text = best.text || target.text;
      target.confidence = best.confidence;
      target.rotationDeg = best.rotationDeg;
    } else {
      merged.push(group);
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// ReconciledField 빌더
// ---------------------------------------------------------------------------

function layoutKindToFieldType(kind: CandidateKind): DocumentFieldType {
  switch (kind) {
    case "long_text":
      return "long_text";
    case "checkbox":
      return "checkbox";
    case "table_cell":
      return "table";
    case "file_attach":
      return "file";
    case "signature":
    case "stamp":
    case "instruction":
    case "text_input":
      return "text";
    case "unknown":
    default:
      return "unknown";
  }
}

function textFieldOf(cand: NormalizedFieldCandidate): Record<string, unknown> {
  return (cand.raw ?? {}) as Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function visualEvidenceOf(group: LayoutGroup): Record<string, unknown> {
  return {
    engine: group.engine,
    kind: group.kind,
    bbox: group.bbox,
    page: group.page,
    rotationDeg: group.rotationDeg,
    confidence: group.confidence,
    mergedFrom: group.members.length,
  };
}

function textEvidenceOf(cand: NormalizedFieldCandidate, engine: string): Record<string, unknown> {
  const field = textFieldOf(cand);
  return {
    engine,
    label: cand.label,
    sourceSpan: field.sourceSpan ?? null,
    fieldKey: field.fieldKey ?? null,
    confidence: cand.confidence,
  };
}

/** rule ① — text + layout 합치. */
function buildMatched(
  text: NormalizedFieldCandidate,
  textEngine: string,
  group: LayoutGroup,
  thresholds: typeof RECONCILE_THRESHOLDS,
): ReconciledField {
  const field = textFieldOf(text);
  const fieldKey = str(field.fieldKey) ?? `manual.${slug(text.label)}`;
  const fieldType = (str(field.fieldType) as DocumentFieldType | null) ?? layoutKindToFieldType(group.kind);
  let fillStrategy = (str(field.fillStrategy) as DocumentFillStrategy | null) ?? "ask_user";
  const confidence = clampConfidence(
    Math.max(thresholds.highConfidence, text.confidence ?? 0, group.confidence ?? 0),
  );
  const manual = isManualForced(group.kind, text.label, fieldKey);
  if (manual) fillStrategy = "manual";
  return {
    fieldKey,
    label: text.label || group.label,
    section: str(field.section),
    fieldType,
    required: field.required === true,
    fillStrategy,
    confidence,
    tier: "high",
    position: { page: group.page, bbox: group.bbox },
    visualEvidence: visualEvidenceOf(group),
    textEvidence: textEvidenceOf(text, textEngine),
    reviewRequired: confidence < thresholds.lowConfidence,
    mappedCompanyField: str(field.mappedCompanyField),
    sourceSpan: str(field.sourceSpan),
    documentName: str(field.documentName),
    documentCategory: str(field.documentCategory),
  };
}

/** rule ③ — text 만. */
function buildTextOnly(
  text: NormalizedFieldCandidate,
  textEngine: string,
  thresholds: typeof RECONCILE_THRESHOLDS,
): ReconciledField {
  const field = textFieldOf(text);
  const fieldKey = str(field.fieldKey) ?? `manual.${slug(text.label)}`;
  const fieldType = (str(field.fieldType) as DocumentFieldType | null) ?? "text";
  let fillStrategy = (str(field.fillStrategy) as DocumentFillStrategy | null) ?? "ask_user";
  // 위치 없음 → medium 상한. 소스 신뢰도가 더 낮으면 그대로 반영(rule ⑥ 트리거 가능).
  const confidence = clampConfidence(Math.min(thresholds.mediumConfidence, text.confidence ?? thresholds.mediumConfidence));
  const manual = isManualForced(text.kind, text.label, fieldKey);
  if (manual) fillStrategy = "manual";
  return {
    fieldKey,
    label: text.label,
    section: str(field.section),
    fieldType,
    required: field.required === true,
    fillStrategy,
    confidence,
    tier: "medium",
    position: null,
    visualEvidence: null,
    textEvidence: textEvidenceOf(text, textEngine),
    reviewRequired: confidence < thresholds.lowConfidence,
    mappedCompanyField: str(field.mappedCompanyField),
    sourceSpan: str(field.sourceSpan),
    documentName: str(field.documentName),
    documentCategory: str(field.documentCategory),
  };
}

/** rule ② — layout 만. */
function buildLayoutOnly(
  group: LayoutGroup,
  thresholds: typeof RECONCILE_THRESHOLDS,
): ReconciledField {
  const label = group.label || group.text || "(무제 항목)";
  const fieldKey = `layout.${slug(label)}`;
  const fieldType = layoutKindToFieldType(group.kind);
  const manual = isManualForced(group.kind, label, fieldKey);
  const confidence = clampConfidence(
    Math.min(thresholds.mediumConfidence, group.confidence ?? thresholds.mediumConfidence),
  );
  return {
    fieldKey,
    label,
    section: null,
    fieldType,
    required: false,
    fillStrategy: manual ? "manual" : "ask_user",
    confidence,
    tier: "medium",
    position: { page: group.page, bbox: group.bbox },
    visualEvidence: visualEvidenceOf(group),
    textEvidence: null,
    reviewRequired: confidence < thresholds.lowConfidence,
    mappedCompanyField: null,
    sourceSpan: null,
    documentName: null,
    documentCategory: null,
  };
}

// ---------------------------------------------------------------------------
// 메인
// ---------------------------------------------------------------------------

interface TaggedCandidate {
  cand: NormalizedFieldCandidate;
  engine: string;
}

/**
 * layout / text_parser CandidateSet 을 합쳐 ReconciledField[] 를 만든다.
 * 순수 함수. 규칙 ①~⑥ 은 파일 상단 doc 참조.
 */
export function reconcileFieldCandidates(
  sets: readonly CandidateSet[],
  opts: ReconcileOptions = {},
): ReconciledField[] {
  const thresholds = { ...RECONCILE_THRESHOLDS, ...(opts.thresholds ?? {}) };

  const layoutCands: TaggedCandidate[] = [];
  const textCands: TaggedCandidate[] = [];
  for (const set of sets) {
    for (const cand of set.candidates) {
      const tagged = { cand, engine: set.engine };
      if (cand.layer === "layout") layoutCands.push(tagged);
      else textCands.push(tagged);
    }
  }

  // rule ⑤: layout 중복 병합.
  const groups = mergeLayoutDuplicates(
    layoutCands.map((t) => toLayoutGroup(t.cand, t.engine)),
    thresholds.layoutMergeIou,
  );

  const results: ReconciledField[] = [];
  const usedGroups = new Set<LayoutGroup>();
  const seenFieldKeys = new Set<string>();

  // rule ① / ③: text 후보를 layout 그룹에 매칭 시도.
  for (const { cand: text, engine } of textCands) {
    const match = groups.find(
      (group) =>
        !usedGroups.has(group) &&
        group.bbox !== null &&
        pageCompatible(text.page, group.page) &&
        (group.label
          ? labelSimilarity(text.label, group.label) >= thresholds.labelMatch
          : false),
    );
    let field: ReconciledField;
    if (match) {
      usedGroups.add(match);
      field = buildMatched(text, engine, match, thresholds);
    } else {
      field = buildTextOnly(text, engine, thresholds);
    }
    if (seenFieldKeys.has(field.fieldKey)) continue;
    seenFieldKeys.add(field.fieldKey);
    results.push(field);
  }

  // rule ②: 매칭되지 않은 layout 그룹.
  for (const group of groups) {
    if (usedGroups.has(group)) continue;
    const field = buildLayoutOnly(group, thresholds);
    if (seenFieldKeys.has(field.fieldKey)) continue;
    seenFieldKeys.add(field.fieldKey);
    results.push(field);
  }

  return results;
}
