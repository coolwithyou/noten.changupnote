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
/** lesson 노출 표면: 공고 상세 유의사항 패널 | 작성 필드 인라인 팁. */
export type LessonExposureSurface = "grant_panel" | "field_tip";

export interface LessonScope {
  program?: string;
  institution?: string;
  formTemplateId?: string;
  documentCategory?: string;
  fieldPattern?: string;
  /**
   * Gate 1 표준 필드 key(정규화된 필드 식별자 — fieldKeyDictionary 화이트리스트).
   * fieldPattern 이 자유 문자열이라면 fieldKey 는 그 항목의 정규 key 다("직원 수"·"상시근로자 수"가
   * 모두 employee_count). 필드 팁 매칭에서 fieldPattern 문자열 포함보다 우선하는 동등성 축.
   */
  fieldKey?: string;
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
export const LESSON_EXPOSURE_SURFACES: readonly LessonExposureSurface[] = [
  "grant_panel",
  "field_tip",
];
/** scope 가 최소 1개 축을 가지는지(과일반화·빈 scope 승격 방지). */
export const LESSON_SCOPE_AXES: readonly (keyof LessonScope)[] = [
  "program",
  "institution",
  "formTemplateId",
  "documentCategory",
  "fieldPattern",
  "fieldKey",
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

/** 원천 문서 단건 조회(id). 없으면 null. */
export async function getKnowledgeSourceById(id: string): Promise<KnowledgeSourceRow | null> {
  const db = getCunoteDb();
  const rows = await db
    .select()
    .from(schema.knowledgeSources)
    .where(eq(schema.knowledgeSources.id, id))
    .limit(1);
  return rows[0] ? toSourceRow(rows[0]) : null;
}

/** 추출 결과 반영 패치(부분 갱신). status 는 필수, 나머지는 전달된 키만 갱신. updatedAt 은 항상 갱신. */
export interface KnowledgeSourceExtractionPatch {
  status: KnowledgeSourceStatus;
  extractedTextKey?: string | null;
  extractionJsonKey?: string | null;
  extractionModel?: string | null;
  extractionPromptVer?: string | null;
  nonLessonItems?: NonLessonItem[];
}

/**
 * 추출 결과를 원천 문서에 반영한다(GUI 추출 API 가 lesson 적재 성공 후 호출).
 * 전달된 키만 set 하고 updatedAt 을 갱신한다(exactOptionalPropertyTypes: undefined 미전달).
 */
export async function updateKnowledgeSourceExtraction(
  id: string,
  patch: KnowledgeSourceExtractionPatch,
): Promise<KnowledgeSourceRow> {
  if (!(KNOWLEDGE_SOURCE_STATUSES as readonly string[]).includes(patch.status)) {
    throw new Error(`invalid knowledge source status: ${patch.status}`);
  }
  const db = getCunoteDb();
  const set: Partial<typeof schema.knowledgeSources.$inferInsert> = {
    status: patch.status,
    updatedAt: new Date(),
  };
  if (patch.extractedTextKey !== undefined) set.extractedTextKey = patch.extractedTextKey;
  if (patch.extractionJsonKey !== undefined) set.extractionJsonKey = patch.extractionJsonKey;
  if (patch.extractionModel !== undefined) set.extractionModel = patch.extractionModel;
  if (patch.extractionPromptVer !== undefined) set.extractionPromptVer = patch.extractionPromptVer;
  if (patch.nonLessonItems !== undefined) set.nonLessonItems = patch.nonLessonItems;

  const [row] = await db
    .update(schema.knowledgeSources)
    .set(set)
    .where(eq(schema.knowledgeSources.id, id))
    .returning();
  if (!row) throw new Error(`updateKnowledgeSourceExtraction: no row returned for ${id}`);
  return toSourceRow(row);
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

/** 원천 문서 1건에 딸린 lesson 의 status 별 경량 집계(대시보드 sources 목록용). */
export interface LessonStatusCounts {
  total: number;
  proposed: number;
  approved: number;
  rejected: number;
  retired: number;
}

/** sourceId 로 review_lessons 를 status 별 count 집계(전량 로드 없이 SQL group by). */
export async function countLessonsBySource(sourceId: string): Promise<LessonStatusCounts> {
  const db = getCunoteDb();
  const rows = await db
    .select({ status: schema.reviewLessons.status, n: sql<number>`count(*)::int` })
    .from(schema.reviewLessons)
    .where(eq(schema.reviewLessons.sourceId, sourceId))
    .groupBy(schema.reviewLessons.status);

  const out: LessonStatusCounts = { total: 0, proposed: 0, approved: 0, rejected: 0, retired: 0 };
  for (const row of rows) {
    const n = Number(row.n) || 0;
    out.total += n;
    if (row.status === "proposed") out.proposed += n;
    else if (row.status === "approved") out.approved += n;
    else if (row.status === "rejected") out.rejected += n;
    else if (row.status === "retired") out.retired += n;
  }
  return out;
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

// ── lesson_exposure_events (경량 노출 텔레메트리) ─────────────────
// 설계: docs/plans/2026-07-06-knowledge-loop-next-session.md K1.
// 노출 1회 = 페이지 뷰 1회 raw 기록. 중복 제거는 하지 않고(집계에서 처리),
// Step 4 효과 측정·"죽은 지식(노출 0)" 탐지의 분모로 쓴다.

/** 노출 이벤트 1건(기록 계층 입력). companyId/userId 는 경량 — 없으면 null. */
export interface LessonExposureInput {
  lessonId: string;
  grantId: string;
  surface: LessonExposureSurface;
  anchorLabel?: string | null;
  companyId?: string | null;
  userId?: string | null;
}

/**
 * 노출 이벤트를 batch insert 한다(단일 INSERT). 빈 배열이면 no-op(0 반환).
 * 삽입한 행 수를 반환한다. 중복 제거 없음 — 같은 lesson 이 여러 라벨에 매칭되면 여러 건이 정상.
 */
export async function recordLessonExposures(events: LessonExposureInput[]): Promise<number> {
  if (events.length === 0) return 0;
  const db = getCunoteDb();
  const rows = await db
    .insert(schema.lessonExposureEvents)
    .values(
      events.map((e) => ({
        lessonId: e.lessonId,
        grantId: e.grantId,
        surface: e.surface,
        anchorLabel: e.anchorLabel ?? null,
        companyId: e.companyId ?? null,
        userId: e.userId ?? null,
      })),
    )
    .returning({ id: schema.lessonExposureEvents.id });
  return rows.length;
}

/** lessonId 별 노출 집계(최근 windowDays 창 + 전체). 전량 로드 없이 SQL group by. */
export interface LessonExposureCounts {
  /** lessonId → 최근 windowDays 일 노출 수. */
  recent: Map<string, number>;
  /** lessonId → 전체 노출 수(죽은 지식 판정용). */
  total: Map<string, number>;
}

/**
 * lesson 별 노출 수를 최근 창(recent)과 전체(total)로 한 번에 집계한다.
 * 이벤트는 무한 성장 테이블이므로 전량 로드 금지 — group by 로 lessonId 별 카운트만 받는다.
 * recent 는 count(*) filter 로 한 쿼리에서 함께 뽑는다(추가 왕복 없음).
 */
export async function getLessonExposureCounts(
  options: { windowDays?: number } = {},
): Promise<LessonExposureCounts> {
  const windowDays = options.windowDays ?? 30;
  // 커트오프는 ISO 문자열로 바인딩 후 ::timestamptz 캐스트한다(원시 sql 프래그먼트에는
  // 컬럼 타입 컨텍스트가 없어 postgres-js 가 JS Date 를 직접 바인딩하지 못함).
  const cutoffIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const db = getCunoteDb();
  const t = schema.lessonExposureEvents;
  const rows = await db
    .select({
      lessonId: t.lessonId,
      total: sql<number>`count(*)::int`,
      recent: sql<number>`count(*) filter (where ${t.createdAt} >= ${cutoffIso}::timestamptz)::int`,
    })
    .from(t)
    .groupBy(t.lessonId);

  const recent = new Map<string, number>();
  const total = new Map<string, number>();
  for (const row of rows) {
    total.set(row.lessonId, Number(row.total) || 0);
    recent.set(row.lessonId, Number(row.recent) || 0);
  }
  return { recent, total };
}
