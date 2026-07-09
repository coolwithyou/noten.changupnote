/**
 * 필드 답변 상태 모델 도메인 모듈 (Apply Experience v2 · ADR-5 / P2-2).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md ADR-5, §6.2, §6.3, §7.1.
 *
 * `grant_document_drafts.field_answers`(Record<원문 label, DraftFieldAnswer>)를 다루는 순수 함수 모음.
 * 내보내기용 `filledFields`는 여기서 파생되는 뷰다 — **suggested/dismissed 는 절대 포함되지 않는다**(불변식).
 *
 * 키는 원문 label(HWPX 채움이 normalizeLabel 매칭이므로), `fieldId`는 참조용이다.
 */
import { normalizeLabel } from "@cunote/core/documents/hwpx-fill";

export type DraftFieldAnswerStatus = "suggested" | "accepted" | "edited" | "dismissed";
export type DraftFieldAnswerSource = "profile" | "template" | "llm" | "user";

/** ADR-5 필드 답변 단위. `grant_document_drafts.field_answers: Record<label, DraftFieldAnswer>`. */
export interface DraftFieldAnswer {
  value: string;
  status: DraftFieldAnswerStatus;
  source: DraftFieldAnswerSource;
  /** 제안 원본 (수정 추적·undo·교정률 KPI 용). */
  suggestedValue?: string;
  /** 근거 표시용 ("사업자 정보", "공고문 인용" 등). */
  basis?: string;
  /** grant_document_fields.id (있을 때만). */
  fieldId?: string;
  /** ISO */
  updatedAt: string;
}

export type DraftFieldAnswers = Record<string, DraftFieldAnswer>;

export const DRAFT_FIELD_ANSWER_STATUSES: readonly DraftFieldAnswerStatus[] = [
  "suggested",
  "accepted",
  "edited",
  "dismissed",
];
export const DRAFT_FIELD_ANSWER_SOURCES: readonly DraftFieldAnswerSource[] = [
  "profile",
  "template",
  "llm",
  "user",
];

/** §7.1 검증 한도. */
export const FIELD_ANSWERS_MAX_ENTRIES = 200;
const LABEL_MAX_LENGTH = 160;
const VALUE_MAX_LENGTH = 4000;

export function isDraftFieldAnswerStatus(value: unknown): value is DraftFieldAnswerStatus {
  return typeof value === "string" && (DRAFT_FIELD_ANSWER_STATUSES as readonly string[]).includes(value);
}

export function normalizeAnswerLabel(label: string): string {
  return label.trim().slice(0, LABEL_MAX_LENGTH);
}

export function normalizeAnswerValue(value: string): string {
  return value.trim().slice(0, VALUE_MAX_LENGTH);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 내보내기 파생 뷰: `accepted|edited` 만 걸러 Record<label, value> 를 재계산한다.
 * **"suggested 절대 미포함" 불변식**을 서버가 집행하는 지점 — dismissed 도 제외.
 */
export function deriveFilledFields(answers: DraftFieldAnswers | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!answers) return out;
  for (const [rawLabel, answer] of Object.entries(answers)) {
    if (!answer) continue;
    if (answer.status !== "accepted" && answer.status !== "edited") continue;
    const label = normalizeAnswerLabel(rawLabel);
    const value = normalizeAnswerValue(answer.value ?? "");
    if (label && value) out[label] = value;
  }
  return out;
}

/**
 * 백필·미백필 구체화: `filledFields` 각 (label,value) 를 `{status:"accepted", source:"template"}` 로 승격한다.
 * 기존 값은 이미 export 에 쓰이던 값이므로 accepted 가 정직한 이관(ADR-5 백필·쓰기 정합).
 */
export function materializeFieldAnswers(
  filledFields: Record<string, string> | null | undefined,
  options?: { at?: string },
): DraftFieldAnswers {
  const at = options?.at ?? nowIso();
  const out: DraftFieldAnswers = {};
  if (!filledFields) return out;
  for (const [rawLabel, rawValue] of Object.entries(filledFields)) {
    const label = normalizeAnswerLabel(rawLabel);
    const value = normalizeAnswerValue(rawValue ?? "");
    if (!label || !value) continue;
    out[label] = { value, status: "accepted", source: "template", updatedAt: at };
  }
  return out;
}

/**
 * 읽기 폴백: `fieldAnswers ?? filledFields 파생`.
 * 미백필 행(field_answers 가 NULL)은 filledFields 를 구체화해 돌려준다.
 */
export function resolveFieldAnswers(row: {
  fieldAnswers?: DraftFieldAnswers | null;
  filledFields: Record<string, string>;
}): DraftFieldAnswers {
  if (row.fieldAnswers != null) return row.fieldAnswers;
  return materializeFieldAnswers(row.filledFields);
}

/**
 * 결정론적 템플릿 생성값 병합 규약(ADR-5): create/regenerate 가 생성한 값은
 * `status:"suggested", source:"template"` 로만 기록하되 **이미 accepted|edited|dismissed 인 label 은
 * 건드리지 않는다**(멱등 병합). 기존 suggested 는 새 생성값으로 갱신 가능.
 */
export function mergeTemplateSuggestions(
  current: DraftFieldAnswers,
  templateFilledFields: Record<string, string>,
  options?: { source?: DraftFieldAnswerSource; at?: string },
): DraftFieldAnswers {
  const source = options?.source ?? "template";
  const at = options?.at ?? nowIso();
  const next: DraftFieldAnswers = { ...current };
  for (const [rawLabel, rawValue] of Object.entries(templateFilledFields)) {
    const label = normalizeAnswerLabel(rawLabel);
    const value = normalizeAnswerValue(rawValue ?? "");
    if (!label || !value) continue;
    const existing = next[label];
    if (existing && existing.status !== "suggested") continue; // 멱등: 확정/기각은 불변
    next[label] = { value, status: "suggested", source, suggestedValue: value, updatedAt: at };
  }
  return next;
}

/**
 * `field-answers` PATCH(§7.1) 적용: label 당 { value?, status } 를 병합한다.
 * 제안 계보(source·suggestedValue·basis·fieldId)는 보존해 KPI 교정률(§11) 소스 귀속을 유지한다.
 * 제안 이력이 없는 신규 label 은 `source:"user"`.
 */
export function applyFieldAnswerPatch(
  current: DraftFieldAnswers,
  patch: Record<string, { value?: string; status: DraftFieldAnswerStatus }>,
  options?: { at?: string; newEntrySource?: DraftFieldAnswerSource },
): DraftFieldAnswers {
  const at = options?.at ?? nowIso();
  const newEntrySource = options?.newEntrySource ?? "user";
  const next: DraftFieldAnswers = { ...current };
  for (const [rawLabel, entry] of Object.entries(patch)) {
    const label = normalizeAnswerLabel(rawLabel);
    if (!label) continue;
    const existing = next[label];
    const value = entry.value !== undefined
      ? normalizeAnswerValue(entry.value)
      : normalizeAnswerValue(existing?.value ?? "");
    const suggestedValue = existing?.suggestedValue
      ?? (existing?.status === "suggested" ? existing.value : undefined);
    const merged: DraftFieldAnswer = {
      value,
      status: entry.status,
      source: existing?.source ?? newEntrySource,
      updatedAt: at,
    };
    if (suggestedValue !== undefined) merged.suggestedValue = suggestedValue;
    if (existing?.basis !== undefined) merged.basis = existing.basis;
    if (existing?.fieldId !== undefined) merged.fieldId = existing.fieldId;
    next[label] = merged;
  }
  return next;
}

/**
 * 구 PATCH(`filledFields` 수용) 동기 반영(ADR-5 표 1행): 들어온 filledFields 각 (label,value) 를
 * `status:"edited", source:"user"` 로 병합해 파생 일관성을 유지한다. 제안 원본(suggestedValue)은 보존.
 */
export function syncUserFilledFields(
  current: DraftFieldAnswers,
  filledFields: Record<string, string>,
  options?: { at?: string },
): DraftFieldAnswers {
  const at = options?.at ?? nowIso();
  const next: DraftFieldAnswers = { ...current };
  for (const [rawLabel, rawValue] of Object.entries(filledFields)) {
    const label = normalizeAnswerLabel(rawLabel);
    const value = normalizeAnswerValue(rawValue ?? "");
    if (!label || !value) continue;
    const existing = next[label];
    const merged: DraftFieldAnswer = { value, status: "edited", source: "user", updatedAt: at };
    const suggestedValue = existing?.suggestedValue
      ?? (existing?.status === "suggested" ? existing.value : undefined);
    if (suggestedValue !== undefined) merged.suggestedValue = suggestedValue;
    if (existing?.fieldId !== undefined) merged.fieldId = existing.fieldId;
    next[label] = merged;
  }
  return next;
}

/**
 * 정규화 label 충돌 감지(ADR-5 label 키 충돌 정책): 서로 **다른** 원문 label 이
 * `normalizeLabel` 로 같은 키에 붕괴하는 경우를 찾는다(예: "기업명(국문)"/"기업명(영문)" → "기업명").
 * 동일 원문 label 의 중복은 충돌이 아니다.
 *
 * `duplicateLabels`(제외 대상 원문 label 집합)는 HWPX 내보내기에서 채움 제외 + 경고 뱃지 근거로 쓴다.
 */
export function detectDuplicateNormalizedLabels(labels: Iterable<string>): {
  duplicateLabels: Set<string>;
  collisions: Array<{ normalized: string; labels: string[] }>;
} {
  const byNormalized = new Map<string, string[]>();
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    if (!normalized) continue;
    const list = byNormalized.get(normalized) ?? [];
    if (!list.includes(label)) list.push(label);
    byNormalized.set(normalized, list);
  }
  const duplicateLabels = new Set<string>();
  const collisions: Array<{ normalized: string; labels: string[] }> = [];
  for (const [normalized, list] of byNormalized) {
    if (list.length <= 1) continue;
    collisions.push({ normalized, labels: list });
    for (const label of list) duplicateLabels.add(label);
  }
  return { duplicateLabels, collisions };
}
