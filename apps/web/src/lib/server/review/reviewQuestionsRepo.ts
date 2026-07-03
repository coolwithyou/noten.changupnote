/**
 * 질문 기반 검수 모드(v2) 데이터 접근 + 공용 검증 (field_map_review_questions).
 *
 * 정본: docs/plans/2026-07-03-reviewer-workspace-v1.md "v2 — 질문 기반 검수 모드".
 * 질문은 사전 배치(generate-review-questions.ts)로 생성하고, 리뷰어는 답변만 한다.
 * 답변 즉시 applyMap 패치를 labelJson.fields 에 결정적으로 반영한다 (save 와 동일 경로, dirty 없음).
 */
import { asc, eq } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import {
  getReviewDocByDocId,
  saveReviewDraft,
  HOLD_PREFIX,
  type ReviewField,
  type ReviewLabelJson,
} from "./reviewDocsRepo";

export type QuestionKind = "quick_confirm" | "question" | "missing_sweep";
export type AnswerType = "confirm" | "yes_no_unsure" | "choice" | "short_text";

export const QUESTION_KINDS: readonly QuestionKind[] = ["quick_confirm", "question", "missing_sweep"];
export const ANSWER_TYPES: readonly AnswerType[] = ["confirm", "yes_no_unsure", "choice", "short_text"];

/**
 * applyMap 이 라벨에 반영할 수 있는 필드 속성(허용 키)과 각 값 타입.
 * LLM 이 제안한 applyMap 은 서버에서 이 화이트리스트로 검증한다 (스펙: 허용 키·값 타입 검사).
 */
export const APPLY_MAP_ALLOWED_KEYS = ["type", "required", "applicantFills", "manual", "label"] as const;
export type ApplyMapKey = (typeof APPLY_MAP_ALLOWED_KEYS)[number];

/** applyMap.type 이 취할 수 있는 표준 type 값(기준서 enum). */
export const FIELD_TYPE_VALUES = [
  "text",
  "long_text",
  "number",
  "date",
  "currency",
  "checkbox",
  "table",
  "file",
  "signature",
  "stamp",
  "unknown",
] as const;

export type ApplyPatch = Partial<Record<ApplyMapKey, unknown>>;
export type ApplyMap = Record<string, ApplyPatch>;

export interface ReviewQuestionRow {
  id: string;
  reviewDocId: string;
  fieldIndex: number | null;
  page: number | null;
  kind: QuestionKind;
  prompt: string;
  answerType: AnswerType;
  options: Array<{ value: string; label: string }> | null;
  applyMap: ApplyMap | null;
  orderIndex: number;
  answer: { value: string; text?: string } | null;
  answeredBy: string | null;
  answeredAt: Date | null;
}

/** 단일 patch(applyMap 의 한 항목)를 화이트리스트/타입으로 검증. 유효한 부분만 남긴다. */
export function sanitizeApplyPatch(raw: unknown): { patch: ApplyPatch; dropped: string[] } {
  const dropped: string[] = [];
  const patch: ApplyPatch = {};
  if (!raw || typeof raw !== "object") return { patch, dropped };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(APPLY_MAP_ALLOWED_KEYS as readonly string[]).includes(k)) {
      dropped.push(`key:${k}`);
      continue;
    }
    if (k === "type") {
      if (typeof v === "string" && (FIELD_TYPE_VALUES as readonly string[]).includes(v)) patch.type = v;
      else dropped.push(`type_value:${String(v)}`);
    } else if (k === "required" || k === "applicantFills" || k === "manual") {
      if (typeof v === "boolean") patch[k] = v;
      else dropped.push(`bool:${k}=${String(v)}`);
    } else if (k === "label") {
      if (typeof v === "string") patch.label = v;
      else dropped.push(`label_value`);
    }
  }
  return { patch, dropped };
}

/** applyMap 전체를 검증. 답변값→patch 매핑에서 빈 patch 는 제거한다. */
export function sanitizeApplyMap(raw: unknown): { applyMap: ApplyMap | null; dropped: string[] } {
  if (!raw || typeof raw !== "object") return { applyMap: null, dropped: [] };
  const out: ApplyMap = {};
  const dropped: string[] = [];
  for (const [answerValue, patchRaw] of Object.entries(raw as Record<string, unknown>)) {
    const { patch, dropped: d } = sanitizeApplyPatch(patchRaw);
    dropped.push(...d.map((x) => `${answerValue}.${x}`));
    if (Object.keys(patch).length > 0) out[answerValue] = patch;
  }
  return { applyMap: Object.keys(out).length > 0 ? out : null, dropped };
}

function toRow(r: typeof schema.fieldMapReviewQuestions.$inferSelect): ReviewQuestionRow {
  return {
    id: r.id,
    reviewDocId: r.reviewDocId,
    fieldIndex: r.fieldIndex,
    page: r.page,
    kind: r.kind as QuestionKind,
    prompt: r.prompt,
    answerType: r.answerType as AnswerType,
    options: Array.isArray(r.options) ? r.options : null,
    applyMap: (r.applyMap as ApplyMap | null) ?? null,
    orderIndex: r.orderIndex,
    answer: (r.answer as { value: string; text?: string } | null) ?? null,
    answeredBy: r.answeredBy,
    answeredAt: r.answeredAt,
  };
}

/** 문서(docId)의 질문 목록을 orderIndex 순으로 로드. 상세 페이지 서버 컴포넌트에서 사용. */
export async function listQuestionsForDoc(reviewDocId: string): Promise<ReviewQuestionRow[]> {
  const db = getCunoteDb();
  const rows = await db
    .select()
    .from(schema.fieldMapReviewQuestions)
    .where(eq(schema.fieldMapReviewQuestions.reviewDocId, reviewDocId))
    .orderBy(asc(schema.fieldMapReviewQuestions.orderIndex));
  return rows.map(toRow);
}

/** notes 를 "판정 보류:" 접두어로 감싼다 (이미 보류면 유지). */
function withHoldPrefix(notes: string | undefined, reason: string): string {
  const rest = (notes ?? "").trim();
  const cleaned = rest.startsWith(HOLD_PREFIX) ? rest.slice(HOLD_PREFIX.length).trim() : rest;
  const merged = [reason.trim(), cleaned].filter(Boolean).join(" / ");
  return merged ? `${HOLD_PREFIX} ${merged}` : `${HOLD_PREFIX} `;
}

export type AnswerResult =
  | { ok: true; applied: ApplyPatch | null; held: boolean }
  | { ok: false; reason: string };

/**
 * 질문 답변 저장 + applyMap 결정적 반영.
 * - 답변을 field_map_review_questions.answer 에 기록 (answeredBy/answeredAt).
 * - answerType 별 검증. applyMap[value] patch 를 해당 필드(fieldIndex)에 반영.
 * - "모르겠음"(unsure) 이면 해당 필드 notes 에 "판정 보류:" 접두어 부여.
 * - 라벨 반영은 saveReviewDraft 와 동일 경로로 즉시 저장 (dirty 없이).
 */
export async function answerQuestion(
  docId: string,
  questionId: string,
  answer: { value: string; text?: string },
  reviewerEmail: string,
): Promise<AnswerResult> {
  const db = getCunoteDb();

  const doc = await getReviewDocByDocId(docId);
  if (!doc) return { ok: false, reason: "doc_not_found" };

  const rows = await db
    .select()
    .from(schema.fieldMapReviewQuestions)
    .where(eq(schema.fieldMapReviewQuestions.id, questionId))
    .limit(1);
  const q = rows[0];
  if (!q) return { ok: false, reason: "question_not_found" };
  if (q.reviewDocId !== doc.id) return { ok: false, reason: "question_doc_mismatch" };

  const answerType = q.answerType as AnswerType;
  const value = typeof answer.value === "string" ? answer.value : "";
  if (!value) return { ok: false, reason: "empty_answer" };

  // answerType 별 값 검증.
  if (answerType === "confirm" && !["ok", "edit"].includes(value)) {
    return { ok: false, reason: "invalid_confirm_value" };
  }
  if (answerType === "yes_no_unsure" && !["yes", "no", "unsure"].includes(value)) {
    return { ok: false, reason: "invalid_yes_no_unsure_value" };
  }
  if (answerType === "choice") {
    const opts = Array.isArray(q.options) ? q.options : [];
    if (!opts.some((o) => o.value === value)) return { ok: false, reason: "invalid_choice_value" };
  }
  // short_text 는 value 를 자유 텍스트로 취급(길이만 방어).
  if (answerType === "short_text" && value.length > 2000) {
    return { ok: false, reason: "text_too_long" };
  }

  // applyMap 반영 대상 patch 선정.
  const applyMap = (q.applyMap as ApplyMap | null) ?? null;
  const { patch } = applyMap && applyMap[value] ? sanitizeApplyPatch(applyMap[value]) : { patch: {} as ApplyPatch };
  const isUnsure = answerType === "yes_no_unsure" && value === "unsure";

  // 라벨 반영: fieldIndex 가 있는 질문만 필드를 건드린다.
  let held = false;
  const fields: ReviewField[] = Array.isArray(doc.labelJson.fields)
    ? doc.labelJson.fields.map((f) => ({ ...f }))
    : [];
  const fi = q.fieldIndex;
  if (typeof fi === "number" && fi >= 0 && fi < fields.length) {
    const target = { ...fields[fi] } as ReviewField;
    if (Object.keys(patch).length > 0) Object.assign(target, patch);
    if (isUnsure) {
      const reason = answer.text?.trim() || "모르겠음(질문 모드)";
      target.notes = withHoldPrefix(typeof target.notes === "string" ? target.notes : "", reason);
      held = true;
    }
    fields[fi] = target;
  }

  const nextLabelJson: ReviewLabelJson = { ...doc.labelJson, fields };

  // 라벨을 save 경로로 저장 (fieldIndex 가 없는 질문도 answer 는 기록하되 라벨은 그대로).
  if (typeof fi === "number") {
    const saved = await saveReviewDraft(docId, nextLabelJson);
    if (!saved.ok) return { ok: false, reason: `save_failed:${saved.reason}` };
  }

  await db
    .update(schema.fieldMapReviewQuestions)
    .set({
      answer: { value, ...(answer.text ? { text: answer.text } : {}) },
      answeredBy: reviewerEmail,
      answeredAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.fieldMapReviewQuestions.id, questionId));

  return { ok: true, applied: Object.keys(patch).length > 0 ? patch : null, held };
}
