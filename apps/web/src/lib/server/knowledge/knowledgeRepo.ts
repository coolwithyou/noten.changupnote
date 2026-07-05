/**
 * 운영 지식 인제스천 저장 계층 (knowledge_sources / review_lessons).
 *
 * 설계: 마스터 18.5(ReviewLesson) + docs/plans/2026-07-05-ops-knowledge-ingestion.md §6.
 * 원천 문서 등록·조회(멱등)와 lesson 후보 적재·큐레이션(승격 게이트·충돌 검출)을 담당한다.
 *
 * 핵심 불변식:
 *   - 원천 문서는 sha256 로 멱등(같은 파일 중복 등록 금지).
 *   - lesson 후보는 항상 status='proposed' 로만 적재된다(추출 결과는 후보일 뿐 — 계획 §6 승격 게이트).
 *   - approved 전이는 (sourceRefs 비어있지 않음) 또는 (goldenCaseRef 존재) 중 하나가 필수 —
 *     "원문 인용 없는 후보 승격 금지"의 저장 계층 버전. 위반 시 에러를 던진다.
 *
 * 클라이언트는 db/client 의 getCunoteDb 를 재사용한다(generate-review-questions.ts 선례).
 */
import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";

// ── 도메인 타입 (schema $type 과 일치) ─────────────────────────
export type KnowledgeSourceKind =
  | "ops_interview"
  | "user_feedback_report"
  | "official_announcement"
  | "program_faq";
export type KnowledgeSourceStatus = "registered" | "extracted" | "curated";

export type LessonTarget =
  | "classification"
  | "criteria"
  | "field_interpretation"
  | "fill_value"
  | "guide"
  | "evaluation";
export type LessonSourceKind = "reviewer_correction" | "field_question" | "ops_report";
export type EvidenceTier = "official_document" | "staff_confirmed" | "ops_inference";
export type LessonStatus = "proposed" | "approved" | "rejected" | "retired";

export interface LessonScope {
  program?: string;
  institution?: string;
  formTemplateId?: string;
  documentCategory?: string;
  fieldPattern?: string;
  condition?: string;
}
export interface LessonSourceRef {
  sourceId: string;
  page: number | null;
  quote: string;
}
export interface NonLessonItem {
  kind: string;
  content: string;
  quote: string;
  page: number | null;
}

// ── 화이트리스트 (서버측 검증 — 추출 결과 신뢰 금지) ─────────────
export const KNOWLEDGE_SOURCE_KINDS: readonly KnowledgeSourceKind[] = [
  "ops_interview",
  "user_feedback_report",
  "official_announcement",
  "program_faq",
];
export const KNOWLEDGE_SOURCE_STATUSES: readonly KnowledgeSourceStatus[] = [
  "registered",
  "extracted",
  "curated",
];
export const LESSON_TARGETS: readonly LessonTarget[] = [
  "classification",
  "criteria",
  "field_interpretation",
  "fill_value",
  "guide",
  "evaluation",
];
export const LESSON_SOURCE_KINDS: readonly LessonSourceKind[] = [
  "reviewer_correction",
  "field_question",
  "ops_report",
];
export const EVIDENCE_TIERS: readonly EvidenceTier[] = [
  "official_document",
  "staff_confirmed",
  "ops_inference",
];
export const LESSON_STATUSES: readonly LessonStatus[] = [
  "proposed",
  "approved",
  "rejected",
  "retired",
];
/** scope 가 최소 1개 축을 가지는지(과일반화·빈 scope 승격 방지). */
export const LESSON_SCOPE_AXES: readonly (keyof LessonScope)[] = [
  "program",
  "institution",
  "formTemplateId",
  "documentCategory",
  "fieldPattern",
  "condition",
];

// ── 행 타입 (text 컬럼을 union 으로 좁힘 — reviewQuestionsRepo.toRow 선례) ──
export type KnowledgeSourceRow = Omit<
  typeof schema.knowledgeSources.$inferSelect,
  "kind" | "status"
> & {
  kind: KnowledgeSourceKind;
  status: KnowledgeSourceStatus;
};
export type ReviewLessonRow = Omit<
  typeof schema.reviewLessons.$inferSelect,
  "target" | "sourceKind" | "evidenceTier" | "status"
> & {
  target: LessonTarget;
  sourceKind: LessonSourceKind;
  evidenceTier: EvidenceTier;
  status: LessonStatus;
};

function toSourceRow(r: typeof schema.knowledgeSources.$inferSelect): KnowledgeSourceRow {
  return { ...r, kind: r.kind as KnowledgeSourceKind, status: r.status as KnowledgeSourceStatus };
}
function toLessonRow(r: typeof schema.reviewLessons.$inferSelect): ReviewLessonRow {
  return {
    ...r,
    target: r.target as LessonTarget,
    sourceKind: r.sourceKind as LessonSourceKind,
    evidenceTier: r.evidenceTier as EvidenceTier,
    status: r.status as LessonStatus,
  };
}

/** scope 가 최소 1개 축(비어있지 않은 문자열)을 가지는지. */
export function scopeHasAxis(scope: LessonScope | null | undefined): boolean {
  if (!scope || typeof scope !== "object") return false;
  return LESSON_SCOPE_AXES.some((k) => {
    const v = scope[k];
    return typeof v === "string" && v.trim().length > 0;
  });
}

// ── knowledge_sources ─────────────────────────────────────────
export interface InsertKnowledgeSourceInput {
  kind: KnowledgeSourceKind;
  title: string;
  sha256: string;
  r2Key: string;
  extractedTextKey?: string | null;
  extractionJsonKey?: string | null;
  programHint?: string | null;
  institutionHint?: string | null;
  sourceDate: string;
  uploadedBy: string;
  status?: KnowledgeSourceStatus;
  extractionModel?: string | null;
  extractionPromptVer?: string | null;
  nonLessonItems?: NonLessonItem[];
}

/** 원천 문서 등록. status 기본 'registered'. sha256 중복은 uniqueIndex 가 차단(호출 전 findSourceBySha256 권장). */
export async function insertKnowledgeSource(
  input: InsertKnowledgeSourceInput,
): Promise<KnowledgeSourceRow> {
  if (!(KNOWLEDGE_SOURCE_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`invalid knowledge source kind: ${input.kind}`);
  }
  const db = getCunoteDb();
  const [row] = await db
    .insert(schema.knowledgeSources)
    .values({
      kind: input.kind,
      title: input.title,
      sha256: input.sha256,
      r2Key: input.r2Key,
      extractedTextKey: input.extractedTextKey ?? null,
      extractionJsonKey: input.extractionJsonKey ?? null,
      programHint: input.programHint ?? null,
      institutionHint: input.institutionHint ?? null,
      sourceDate: input.sourceDate,
      uploadedBy: input.uploadedBy,
      status: input.status ?? "registered",
      extractionModel: input.extractionModel ?? null,
      extractionPromptVer: input.extractionPromptVer ?? null,
      nonLessonItems: input.nonLessonItems ?? [],
    })
    .returning();
  if (!row) throw new Error("insertKnowledgeSource: no row returned");
  return toSourceRow(row);
}

/** sha256 로 원천 문서 조회(멱등 등록 판단). 없으면 null. */
export async function findSourceBySha256(sha256: string): Promise<KnowledgeSourceRow | null> {
  const db = getCunoteDb();
  const rows = await db
    .select()
    .from(schema.knowledgeSources)
    .where(eq(schema.knowledgeSources.sha256, sha256))
    .limit(1);
  return rows[0] ? toSourceRow(rows[0]) : null;
}

/** 원천 문서 목록. kind/status 필터. 최신순. */
export async function listKnowledgeSources(
  filter: { kind?: KnowledgeSourceKind; status?: KnowledgeSourceStatus } = {},
): Promise<KnowledgeSourceRow[]> {
  const db = getCunoteDb();
  const conds: SQL[] = [];
  if (filter.kind) conds.push(eq(schema.knowledgeSources.kind, filter.kind));
  if (filter.status) conds.push(eq(schema.knowledgeSources.status, filter.status));
  const rows = await db
    .select()
    .from(schema.knowledgeSources)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.knowledgeSources.createdAt));
  return rows.map(toSourceRow);
}

// ── review_lessons ───────────────────────────────────────────
export interface ProposedLessonInput {
  target: LessonTarget;
  scope: LessonScope;
  instruction: string;
  rationale: string;
  sourceKind?: LessonSourceKind; // 기본 'ops_report'
  evidenceTier: EvidenceTier;
  sourceRefs: LessonSourceRef[];
  sourceId?: string | null;
  goldenCaseRef?: string | null;
  programRound?: string | null;
  reviewBy?: Date | null;
  lessonVer?: string;
}

/** 제안 lesson 후보의 필수 필드·화이트리스트·scope 축을 검증(위반 인덱스 수집). */
function assertValidProposedLessons(items: ProposedLessonInput[]): void {
  const errors: string[] = [];
  items.forEach((it, i) => {
    if (!(LESSON_TARGETS as readonly string[]).includes(it.target)) errors.push(`[${i}] target:${it.target}`);
    if (!(EVIDENCE_TIERS as readonly string[]).includes(it.evidenceTier)) errors.push(`[${i}] evidenceTier:${it.evidenceTier}`);
    if (it.sourceKind && !(LESSON_SOURCE_KINDS as readonly string[]).includes(it.sourceKind)) {
      errors.push(`[${i}] sourceKind:${it.sourceKind}`);
    }
    if (!it.instruction?.trim()) errors.push(`[${i}] empty_instruction`);
    if (!it.rationale?.trim()) errors.push(`[${i}] empty_rationale`);
    if (!scopeHasAxis(it.scope)) errors.push(`[${i}] empty_scope`);
  });
  if (errors.length) throw new Error(`invalid proposed lessons: ${errors.join(", ")}`);
}

/** lesson 후보를 status='proposed' 로 batch insert. 삽입된 행을 반환. */
export async function insertProposedLessons(
  items: ProposedLessonInput[],
): Promise<ReviewLessonRow[]> {
  if (items.length === 0) return [];
  assertValidProposedLessons(items);
  const db = getCunoteDb();
  const rows = await db
    .insert(schema.reviewLessons)
    .values(
      items.map((it) => ({
        target: it.target,
        scope: it.scope,
        instruction: it.instruction,
        rationale: it.rationale,
        sourceKind: it.sourceKind ?? "ops_report",
        evidenceTier: it.evidenceTier,
        sourceRefs: it.sourceRefs ?? [],
        sourceId: it.sourceId ?? null,
        goldenCaseRef: it.goldenCaseRef ?? null,
        programRound: it.programRound ?? null,
        ...(it.reviewBy ? { reviewBy: it.reviewBy } : {}),
        status: "proposed" as const,
        lessonVer: it.lessonVer ?? "v1",
      })),
    )
    .returning();
  return rows.map(toLessonRow);
}

/** lesson 목록. status/target/sourceId 필터. 최신순. */
export async function listLessons(
  filter: { status?: LessonStatus; target?: LessonTarget; sourceId?: string } = {},
): Promise<ReviewLessonRow[]> {
  const db = getCunoteDb();
  const conds: SQL[] = [];
  if (filter.status) conds.push(eq(schema.reviewLessons.status, filter.status));
  if (filter.target) conds.push(eq(schema.reviewLessons.target, filter.target));
  if (filter.sourceId) conds.push(eq(schema.reviewLessons.sourceId, filter.sourceId));
  const rows = await db
    .select()
    .from(schema.reviewLessons)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.reviewLessons.createdAt));
  return rows.map(toLessonRow);
}

/**
 * approved 상태 & 같은 target & scope 가 겹치는 lesson 조회(승격 시 충돌 경고용).
 * 겹침 정의: 같은 formTemplateId, 또는 같은 program+fieldPattern, 또는 같은 institution+fieldPattern.
 * 입력 scope 에 해당 축이 없으면 그 겹침 규칙은 건너뛴다. 적용 규칙이 하나도 없으면 [] 반환.
 */
export async function findConflictingLessons(
  target: LessonTarget,
  scope: LessonScope,
  options: { excludeId?: string } = {},
): Promise<ReviewLessonRow[]> {
  const t = schema.reviewLessons;
  const overlap: SQL[] = [];
  const val = (k: keyof LessonScope) => {
    const v = scope[k];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  };
  const formTemplateId = val("formTemplateId");
  const program = val("program");
  const institution = val("institution");
  const fieldPattern = val("fieldPattern");

  if (formTemplateId) {
    overlap.push(sql`${t.scope} ->> 'formTemplateId' = ${formTemplateId}`);
  }
  if (program && fieldPattern) {
    overlap.push(
      sql`(${t.scope} ->> 'program' = ${program} and ${t.scope} ->> 'fieldPattern' = ${fieldPattern})`,
    );
  }
  if (institution && fieldPattern) {
    overlap.push(
      sql`(${t.scope} ->> 'institution' = ${institution} and ${t.scope} ->> 'fieldPattern' = ${fieldPattern})`,
    );
  }
  if (overlap.length === 0) return [];

  const conds: SQL[] = [eq(t.status, "approved"), eq(t.target, target)];
  const overlapClause = overlap.length === 1 ? overlap[0]! : or(...overlap)!;
  conds.push(overlapClause);
  if (options.excludeId) conds.push(sql`${t.id} <> ${options.excludeId}`);

  const db = getCunoteDb();
  const rows = await db
    .select()
    .from(t)
    .where(and(...conds))
    .orderBy(desc(t.createdAt));
  return rows.map(toLessonRow);
}

export interface LessonCurationInput {
  status: LessonStatus;
  instruction?: string;
  scope?: LessonScope;
  curationNote?: string | null;
  curatedBy: string;
}

/**
 * lesson 큐레이션(승인/기각/수정/철회).
 * - approved 전이 승격 가드: 결과 상태의 sourceRefs 비어있지 않음 또는 goldenCaseRef 존재 필수 → 위반 시 에러.
 * - approved/rejected 전이 시 curatedAt 을 세팅한다(승인·기각 시점 기록). curatedBy/curationNote 도 기록.
 * - instruction/scope 가 주어지면(수정) 함께 반영. scope 는 최소 1개 축 검증.
 */
export async function updateLessonCuration(
  id: string,
  input: LessonCurationInput,
): Promise<ReviewLessonRow> {
  if (!(LESSON_STATUSES as readonly string[]).includes(input.status)) {
    throw new Error(`invalid lesson status: ${input.status}`);
  }
  const db = getCunoteDb();
  const existingRows = await db
    .select()
    .from(schema.reviewLessons)
    .where(eq(schema.reviewLessons.id, id))
    .limit(1);
  const existing = existingRows[0];
  if (!existing) throw new Error(`lesson not found: ${id}`);

  if (input.scope !== undefined && !scopeHasAxis(input.scope)) {
    throw new Error("lesson scope must have at least one axis");
  }

  // 승격 가드: approved 전이는 원문 인용(sourceRefs) 또는 goldenCaseRef 중 하나 필수.
  if (input.status === "approved") {
    const refs = Array.isArray(existing.sourceRefs) ? existing.sourceRefs : [];
    const hasRefs = refs.length > 0;
    const hasGolden = typeof existing.goldenCaseRef === "string" && existing.goldenCaseRef.trim().length > 0;
    if (!hasRefs && !hasGolden) {
      throw new Error("promotion guard: approved requires non-empty sourceRefs or a goldenCaseRef");
    }
  }

  const set: Partial<typeof schema.reviewLessons.$inferInsert> = {
    status: input.status,
    curatedBy: input.curatedBy,
    curationNote: input.curationNote ?? null,
    updatedAt: new Date(),
  };
  if (input.instruction !== undefined) set.instruction = input.instruction;
  if (input.scope !== undefined) set.scope = input.scope;
  if (input.status === "approved" || input.status === "rejected") {
    set.curatedAt = new Date();
  }

  const [row] = await db
    .update(schema.reviewLessons)
    .set(set)
    .where(eq(schema.reviewLessons.id, id))
    .returning();
  if (!row) throw new Error(`updateLessonCuration: no row returned for ${id}`);
  return toLessonRow(row);
}
