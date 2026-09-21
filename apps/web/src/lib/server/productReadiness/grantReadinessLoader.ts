import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadDeepAnalysisSourceBindings } from "../deep-analysis/prepareInput";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { validatePromotionReleaseManifest } from "../analysis-serving/promotionReleaseContract";
import { resolvePromotionServingEvidence } from "../analysis-serving/promotionServing";
import {
  type PromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
  toPromotionQuestionSnapshot,
} from "../analysis-serving/promotionSnapshot";
import { matchingQuestionBinding } from "../matches/annotateConfirmationQuestions";
import { isNonMatchingApplicationCriterion } from "@cunote/core";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import {
  CONFIRMATION_EVALUATION_V2,
  classifyGrantReadiness,
  summarizeGrantReadiness,
  type GrantReadiness,
  type GrantReadinessInput,
  type GrantReadinessSummary,
} from "./grantReadiness";

const KST_TIME_ZONE = "Asia/Seoul";
const DEFAULT_INVENTORY_LIMIT = 20_000;
const ACCEPTED_REVIEW_STATES = new Set([
  "human_reviewed",
  "analysis_launch_independent_review",
]);

export interface GrantReadinessInventoryRow {
  readonly id: string;
  readonly status: string;
  readonly servingState: string;
  readonly applyStart: Date | null;
  readonly applyEnd: Date | null;
}

/**
 * DB query 결과에서 prompt, raw payload, 회사/사용자 식별자를 제거한 준비도 증거다.
 * 이 함수는 fixture만으로 검증 가능하며 네트워크나 DB를 호출하지 않는다.
 */
export interface GrantReadinessEvidenceRow {
  readonly grant: GrantReadinessInventoryRow;
  readonly source: {
    readonly rawRowPresent: boolean;
    readonly rawSha256: string | null;
    readonly collectedAt: Date | null;
    readonly hasAttachments: boolean;
    readonly sourceRevisionSha256: string | null;
  };
  readonly criteria: readonly { readonly stableKey: string | null; readonly needsReview: boolean }[];
  readonly questions: readonly {
    readonly criterionStableKey: string | null;
    readonly evaluationContractVersion: string | null;
    readonly invalidatedAt: Date | null;
    readonly sourceRevisionSha256: string | null;
    readonly sourceRawSha256: string | null;
    /** 런타임과 같은 v2 단일선택·3상태·검수·serving run·source predicate 결과. */
    readonly runtimeBindingEligible: boolean;
  }[];
  /** 활성 release manifest와 applied item의 exact 결속을 대조한 뒤에만 채운다. */
  readonly promotion: {
    readonly runId: string;
    readonly sourceRevisionSha256: string;
    readonly attachmentManifestSha256: string | null;
    readonly reviewState: string;
    readonly plannedCriterionStableKeys: readonly string[];
    readonly plannedV2QuestionStableKeys: readonly string[];
  } | null;
}

export interface LoadedGrantReadiness {
  readonly grantId: string;
  readonly input: GrantReadinessInput;
  readonly readiness: GrantReadiness;
}

export interface GrantReadinessReport {
  readonly schema: "grant-product-readiness-report-v1";
  readonly asOf: string;
  readonly kstDate: string;
  readonly inventoryCount: number;
  readonly summary: GrantReadinessSummary;
  /** 식별자만 담은 bounded sample. 제목·prompt·원문·회사/사용자 데이터는 반환하지 않는다. */
  readonly blockerSamples: Readonly<Partial<Record<string, readonly string[]>>>;
}

/** KST 날짜가 신청 시작일과 마감일(양 끝 포함) 사이인지 판정한다. */
export function isCurrentKstApplicationWindow(
  row: Pick<GrantReadinessInventoryRow, "applyStart" | "applyEnd">,
  asOf: Date,
): boolean {
  if (!row.applyStart || !row.applyEnd || !isValidDate(asOf)) return false;
  const current = kstDate(asOf);
  return kstDate(row.applyStart) <= current && current <= kstDate(row.applyEnd);
}

export function isOpenVisibleCurrentGrant(
  row: GrantReadinessInventoryRow,
  asOf: Date,
): boolean {
  return row.status === "open"
    && row.servingState === "visible"
    && isCurrentKstApplicationWindow(row, asOf);
}

/**
 * 현재 DB evidence를 P4 순수 계약으로 축소한다. source revision이 현재 raw hash를 포함해
 * 계산되므로 revision이 일치할 때만 analysis의 raw binding도 현재 raw로 확정한다.
 */
export function normalizeGrantReadinessEvidence(row: GrantReadinessEvidenceRow): GrantReadinessInput {
  const promotion = row.promotion;
  const currentRevision = row.source.sourceRevisionSha256;
  const sourceAvailable = row.source.rawRowPresent;
  const promotionMatchesCurrent = Boolean(
    promotion
    && currentRevision
    && promotion.sourceRevisionSha256 === currentRevision,
  );
  const criteriaKeys = row.criteria.map((criterion) => criterion.stableKey);
  const expectedCriteria = promotion?.plannedCriterionStableKeys ?? [];
  const stableCriteriaMatch = sameUniqueNonEmptyValues(criteriaKeys, expectedCriteria);
  const reviewApproved = Boolean(promotion && ACCEPTED_REVIEW_STATES.has(promotion.reviewState));
  const attachmentStatus = !row.source.hasAttachments
    ? "not_required" as const
    : promotion?.attachmentManifestSha256 ? "complete" as const : "missing" as const;

  return {
    grantId: row.grant.id,
    source: {
      availability: sourceAvailable ? "available" : "missing",
      collectedAt: row.source.collectedAt?.toISOString() ?? null,
      revisionSha256: currentRevision,
      rawSha256: row.source.rawSha256,
      attachmentStatus,
      attachmentManifestSha256: attachmentStatus === "complete"
        ? promotion?.attachmentManifestSha256 ?? null
        : null,
    },
    analysis: {
      status: promotion ? "present" : "missing",
      sourceRevisionSha256: promotion?.sourceRevisionSha256 ?? null,
      // grant_deep_analysis_runs does not retain raw hash separately. A matching
      // current source revision cryptographically commits this raw hash; when it
      // differs, revision drift remains the primary fail-closed evidence.
      sourceRawSha256: row.source.rawSha256,
      attachmentManifestSha256: attachmentStatus === "complete"
        ? promotion?.attachmentManifestSha256 ?? null
        : null,
      structure: promotionMatchesCurrent && stableCriteriaMatch ? "complete" : "incomplete",
      criteriaReview: promotionMatchesCurrent && stableCriteriaMatch && reviewApproved
        && row.criteria.every((criterion) => !criterion.needsReview)
        ? "reviewed" : "incomplete",
      eligibleQuestionCriterionStableKeys: promotion?.plannedV2QuestionStableKeys ?? [],
    },
    questions: row.questions.map((question) => ({
      criterionStableKey: question.criterionStableKey,
      evaluationContractVersion: question.evaluationContractVersion,
      reviewed: question.runtimeBindingEligible,
      invalidated: question.invalidatedAt !== null,
      sourceRevisionSha256: question.sourceRevisionSha256,
      sourceRawSha256: question.sourceRawSha256,
    })),
  };
}

/** Read-only DB loader. 현재 open·visible이며 KST 신청 기간 안인 공고만 반환한다. */
export async function loadCurrentGrantReadiness(input: {
  db: CunoteDbSession;
  asOf?: Date;
  limit?: number;
}): Promise<LoadedGrantReadiness[]> {
  const asOf = input.asOf ?? new Date();
  const limit = input.limit ?? DEFAULT_INVENTORY_LIMIT;
  if (!isValidDate(asOf) || !Number.isInteger(limit) || limit < 1 || limit > DEFAULT_INVENTORY_LIMIT) {
    throw new Error(`limit은 1~${DEFAULT_INVENTORY_LIMIT.toLocaleString("en-US")} 정수여야 합니다.`);
  }
  const { start, end } = kstDayBounds(asOf);
  const grants = await input.db.select({
    id: schema.grants.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    status: schema.grants.status,
    servingState: schema.grants.servingState,
    applyStart: schema.grants.applyStart,
    applyEnd: schema.grants.applyEnd,
  }).from(schema.grants).where(and(
    eq(schema.grants.status, "open"),
    eq(schema.grants.servingState, "visible"),
    lte(schema.grants.applyStart, end),
    gte(schema.grants.applyEnd, start),
  )).orderBy(desc(schema.grants.updatedAt), desc(schema.grants.id)).limit(limit + 1);
  if (grants.length > limit) throw new Error("준비도 inventory 상한 초과: 부분 집계를 반환하지 않습니다.");
  const inventory = grants.filter((grant) => isOpenVisibleCurrentGrant(grant, asOf));
  if (inventory.length === 0) return [];

  const grantIds = inventory.map((grant) => grant.id);
  const sources = [...new Set(inventory.map((grant) => grant.source))];
  const sourceIds = [...new Set(inventory.map((grant) => grant.sourceId))];
  const [rawRows, archiveRows, criteria, questions, promotionRows, sourceBindings] = await Promise.all([
    input.db.select({
      source: schema.grantRaw.source,
      sourceId: schema.grantRaw.sourceId,
      rawHash: schema.grantRaw.rawHash,
      attachments: schema.grantRaw.attachments,
      collectedAt: schema.grantRaw.collectedAt,
    }).from(schema.grantRaw).where(and(
      inArray(schema.grantRaw.source, sources),
      inArray(schema.grantRaw.sourceId, sourceIds),
    )),
    input.db.select({
      source: schema.grantAttachmentArchives.source,
      sourceId: schema.grantAttachmentArchives.sourceId,
    }).from(schema.grantAttachmentArchives).where(and(
      inArray(schema.grantAttachmentArchives.source, sources),
      inArray(schema.grantAttachmentArchives.sourceId, sourceIds),
    )),
    input.db.select({
      grantId: schema.grantCriteria.grantId,
      stableKey: schema.grantCriteria.stableKey,
      needsReview: schema.grantCriteria.needsReview,
    }).from(schema.grantCriteria).where(inArray(schema.grantCriteria.grantId, grantIds)),
    input.db.select({
      grantId: schema.grantConfirmationQuestions.grantId,
      criterionId: schema.grantCriteria.id,
      criterionStableKey: schema.grantCriteria.stableKey,
      dimension: schema.grantCriteria.dimension,
      kind: schema.grantCriteria.kind,
      operator: schema.grantCriteria.operator,
      sourceSpan: schema.grantCriteria.sourceSpan,
      needsReview: schema.grantCriteria.needsReview,
      evaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
      invalidatedAt: schema.grantConfirmationQuestions.invalidatedAt,
      sourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
      sourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
      answerType: schema.grantConfirmationQuestions.answerType,
      options: schema.grantConfirmationQuestions.options,
      reusable: schema.grantConfirmationQuestions.reusable,
      provenance: schema.grantConfirmationQuestions.provenance,
    }).from(schema.grantConfirmationQuestions)
      .innerJoin(
        schema.grantCriteria,
        eq(
          schema.grantCriteria.id,
          sql`coalesce(${schema.grantConfirmationQuestions.evaluationCriterionId}, ${schema.grantConfirmationQuestions.grantCriteriaId})`,
        ),
      )
      .where(and(
        inArray(schema.grantConfirmationQuestions.grantId, grantIds),
        isNull(schema.grantConfirmationQuestions.invalidatedAt),
      )),
    input.db.select({
      grantId: schema.analysisLabPromotionItems.grantId,
      runId: schema.analysisLabPromotionItems.runId,
      appliedAt: schema.analysisLabPromotionItems.appliedAt,
      deepAnalysisRunId: schema.analysisLabPromotionItems.deepAnalysisRunId,
      planSha256: schema.analysisLabPromotionItems.planSha256,
      afterSha256: schema.analysisLabPromotionItems.afterSha256,
      manifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
      manifest: schema.analysisLabPromotionReleases.manifest,
      deepRunStatus: schema.grantDeepAnalysisRuns.status,
      deepRunSourceRevisionSha256: schema.grantDeepAnalysisRuns.sourceRevisionSha256,
      deepRunAttachmentManifestSha256: schema.grantDeepAnalysisRuns.attachmentManifestSha256,
    }).from(schema.analysisLabPromotionItems).innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionItems.releaseDbId, schema.analysisLabPromotionReleases.id),
    ).leftJoin(
      schema.grantDeepAnalysisRuns,
      eq(schema.analysisLabPromotionItems.deepAnalysisRunId, schema.grantDeepAnalysisRuns.id),
    ).where(and(
      inArray(schema.analysisLabPromotionItems.grantId, grantIds),
      eq(schema.analysisLabPromotionItems.status, "applied"),
      isNull(schema.analysisLabPromotionItems.rolledBackAt),
      inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
    )).orderBy(desc(schema.analysisLabPromotionItems.appliedAt)),
    loadDeepAnalysisSourceBindings({ db: input.db, grantIds }),
  ]);

  const rawBySource = new Map(rawRows.map((raw) => [sourceKey(raw.source, raw.sourceId), raw]));
  const archiveSourceKeys = new Set(archiveRows.map((archive) => sourceKey(archive.source, archive.sourceId)));
  const criteriaByGrant = groupBy(criteria, (criterion) => criterion.grantId);
  const promotionByGrant = await loadCurrentValidPromotions(input.db, promotionRows);
  const servingRunIdsByGrant = new Map([...promotionByGrant].map(([grantId, promotion]) => [
    grantId,
    new Set([promotion.runId]),
  ]));
  const questionsByGrant = groupBy(questions.map((question) => ({
    ...question,
    runtimeBindingEligible: !isNonMatchingApplicationCriterion({
      dimension: question.dimension,
      kind: question.kind,
      operator: question.operator,
      source_span: question.sourceSpan,
    }) && matchingQuestionBinding(
      question,
      servingRunIdsByGrant,
      sourceBindings,
    ) !== null,
  })), (question) => question.grantId);

  return inventory.map((grant) => {
    const raw = rawBySource.get(sourceKey(grant.source, grant.sourceId));
    const binding = sourceBindings.get(grant.id);
    const evidence: GrantReadinessEvidenceRow = {
      grant,
      source: {
        rawRowPresent: Boolean(raw),
        rawSha256: raw?.rawHash ?? null,
        collectedAt: raw?.collectedAt ?? null,
        hasAttachments: hasDeclaredAttachments(raw?.attachments) || archiveSourceKeys.has(sourceKey(grant.source, grant.sourceId)),
        sourceRevisionSha256: binding?.sourceRevisionSha256 ?? null,
      },
      criteria: criteriaByGrant.get(grant.id) ?? [],
      questions: (questionsByGrant.get(grant.id) ?? []).map((question) => ({
        criterionStableKey: question.criterionStableKey,
        evaluationContractVersion: question.evaluationContractVersion,
        invalidatedAt: question.invalidatedAt,
        sourceRevisionSha256: question.sourceRevisionSha256,
        sourceRawSha256: question.sourceRawSha256,
        runtimeBindingEligible: question.runtimeBindingEligible,
      })),
      promotion: promotionByGrant.get(grant.id) ?? null,
    };
    const readinessInput = normalizeGrantReadinessEvidence(evidence);
    return Object.freeze({ grantId: grant.id, input: readinessInput, readiness: classifyGrantReadiness(readinessInput) });
  });
}

export function buildGrantReadinessReport(input: {
  asOf: Date;
  rows: readonly LoadedGrantReadiness[];
  sampleLimit?: number;
}): GrantReadinessReport {
  const sampleLimit = input.sampleLimit ?? 10;
  if (!isValidDate(input.asOf) || !Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 100) {
    throw new Error("보고서 기준일 또는 sampleLimit을 확인해주세요.");
  }
  const samples = new Map<string, string[]>();
  for (const row of input.rows) {
    for (const blocker of row.readiness.blockerCodes) {
      const values = samples.get(blocker) ?? [];
      if (values.length < sampleLimit) values.push(row.grantId);
      samples.set(blocker, values);
    }
  }
  return Object.freeze({
    schema: "grant-product-readiness-report-v1",
    asOf: input.asOf.toISOString(),
    kstDate: kstDate(input.asOf),
    inventoryCount: input.rows.length,
    summary: summarizeGrantReadiness(input.rows.map((row) => row.input)),
    blockerSamples: Object.freeze(Object.fromEntries(
      [...samples.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([blocker, ids]) => [blocker, Object.freeze([...ids])]),
    )),
  });
}

/** DATABASE_URL 계열로 연결하되 PostgreSQL transaction을 read-only 기본값으로 고정한다. */
export async function loadReadOnlyGrantReadinessReport(input: {
  asOf?: Date;
  limit?: number;
  sampleLimit?: number;
} = {}): Promise<GrantReadinessReport> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    connection: { options: "-c default_transaction_read_only=on" },
  });
  try {
    const db = drizzle(client, { schema });
    const asOf = input.asOf ?? new Date();
    return await db.transaction(async (tx) => {
      const rows = await loadCurrentGrantReadiness({
        db: tx,
        asOf,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return buildGrantReadinessReport({
        asOf,
        rows,
        ...(input.sampleLimit === undefined ? {} : { sampleLimit: input.sampleLimit }),
      });
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  } finally {
    await client.end({ timeout: 5 });
  }
}

type GrantReadinessPromotionRow = {
  grantId: string;
  runId: string;
  appliedAt: Date | null;
  deepAnalysisRunId: string | null;
  planSha256: string;
  afterSha256: string | null;
  manifestSha256: string;
  manifest: Record<string, unknown>;
  deepRunStatus: string | null;
  deepRunSourceRevisionSha256: string | null;
  deepRunAttachmentManifestSha256: string | null;
};

/** 최신 serving item이 손상됐을 때 과거 item으로 폴백하지 않고, 최신 시각 동률도 닫는다. */
export function selectUniqueLatestPromotionRows<T extends { grantId: string; appliedAt: Date | null }>(
  rows: readonly T[],
): Map<string, T> {
  const grouped = groupBy(rows, (row) => row.grantId);
  const result = new Map<string, T>();
  for (const [grantId, candidates] of grouped) {
    const ordered = [...candidates]
      .filter((row): row is T & { appliedAt: Date } => row.appliedAt instanceof Date)
      .sort((left, right) => right.appliedAt.getTime() - left.appliedAt.getTime());
    const newest = ordered[0];
    if (!newest || ordered[1]?.appliedAt.getTime() === newest.appliedAt.getTime()) continue;
    result.set(grantId, newest);
  }
  return result;
}

async function loadCurrentValidPromotions(
  db: CunoteDbSession,
  rows: readonly GrantReadinessPromotionRow[],
): Promise<Map<string, NonNullable<GrantReadinessEvidenceRow["promotion"]>>> {
  const latest = selectUniqueLatestPromotionRows(rows);
  const candidates = [...latest.entries()].flatMap(([grantId, row]) => {
    if (!row.afterSha256 || (row.deepAnalysisRunId && row.deepRunStatus !== "passed")) return null;
    const evidence = promotionEvidence(row);
    if (!evidence) return null;
    return [{ grantId, row, evidence }];
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const currentStateShaByGrant = await loadPromotionStateShaByGrant(
    db,
    candidates.map((candidate) => candidate.grantId),
  );
  return new Map(candidates.flatMap(({ grantId, row, evidence }) => (
    currentStateShaByGrant.get(grantId) === row.afterSha256
      ? [[grantId, evidence] as const]
      : []
  )));
}

/** current-state hash에 필요한 행을 전체 공고 배치로 읽는다. 답변 내용/식별자는 hash 계약에 포함되지 않는다. */
async function loadPromotionStateShaByGrant(
  db: CunoteDbSession,
  grantIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(grantIds)];
  if (ids.length === 0) return new Map();
  const [grantRows, criterionRows, questionRows, confirmedLinks] = await Promise.all([
    db.select({
      id: schema.grants.id,
      authoringGuide: schema.grants.authoringGuide,
    }).from(schema.grants).where(inArray(schema.grants.id, ids)),
    db.select().from(schema.grantCriteria).where(inArray(schema.grantCriteria.grantId, ids)),
    db.select().from(schema.grantConfirmationQuestions)
      .where(inArray(schema.grantConfirmationQuestions.grantId, ids)),
    db.select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true)),
  ]);
  const grantsById = new Map(grantRows.map((row) => [row.id, row]));
  const criteriaByGrant = groupBy(criterionRows, (row) => row.grantId);
  const questionsByGrant = groupBy(questionRows, (row) => row.grantId);
  const result = new Map<string, string>();
  for (const grantId of ids) {
    const componentGrantIds = expandConfirmedGrantComponentIds([grantId], confirmedLinks);
    const componentSet = new Set(componentGrantIds);
    const componentLinks = confirmedLinks
      .filter((link) => componentSet.has(link.canonicalGrantId) && componentSet.has(link.memberGrantId))
      .sort((left, right) => `${left.canonicalGrantId}:${left.memberGrantId}`
        .localeCompare(`${right.canonicalGrantId}:${right.memberGrantId}`));
    const snapshot: PromotionGrantSnapshot = {
      grantId,
      authoringGuide: grantsById.get(grantId)?.authoringGuide ?? null,
      criteria: [...(criteriaByGrant.get(grantId) ?? [])]
        .sort((left, right) => left.id.localeCompare(right.id)),
      questions: (questionsByGrant.get(grantId) ?? [])
        .map(toPromotionQuestionSnapshot)
        .sort((left, right) => left.id.localeCompare(right.id)),
      answerBindings: [],
      dedupComponentGrantIds: componentGrantIds,
      dedupLinks: componentLinks,
    };
    result.set(grantId, promotionGrantSnapshotStateSha256(snapshot));
  }
  return result;
}

function promotionEvidence(
  row: GrantReadinessPromotionRow,
): NonNullable<GrantReadinessEvidenceRow["promotion"]> | null {
  try {
    const servingEvidence = resolvePromotionServingEvidence({
      grantId: row.grantId,
      runId: row.runId,
      planSha256: row.planSha256,
      deepAnalysisRunId: row.deepAnalysisRunId,
      releaseManifestSha256: row.manifestSha256,
      manifest: row.manifest,
      deepRunSourceRevisionSha256: row.deepRunSourceRevisionSha256,
    });
    if (!servingEvidence) return null;
    const manifest = validatePromotionReleaseManifest(row.manifest);
    if (manifest.manifestSha256 !== row.manifestSha256) return null;
    const plan = manifest.plans.find((item) => item.grantId === row.grantId && item.promotionPlan.runId === row.runId);
    const artifact = manifest.sourceArtifacts.find((item) => item.grantId === row.grantId && item.runId === row.runId);
    if (!plan || !artifact || plan.planSha256 !== row.planSha256) return null;
    const sourceRevisionSha256 = artifact.sourceRevisionSha256
      ?? artifact.localLabEvidence?.analysisLaunch?.sourceRevisionSha256
      ?? artifact.localLabEvidence?.deepRepair?.sourceRevisionSha256;
    const attachmentManifestSha256 = artifact.localLabEvidence?.analysisLaunch?.attachmentManifestSha256
      ?? artifact.localLabEvidence?.deepRepair?.attachmentManifestSha256
      ?? row.deepRunAttachmentManifestSha256
      ?? null;
    if (!isSha256(sourceRevisionSha256)) return null;
    if (row.deepAnalysisRunId && (
      artifact.deepAnalysisRunId !== row.deepAnalysisRunId
      || row.deepRunSourceRevisionSha256 !== sourceRevisionSha256
      || row.deepRunAttachmentManifestSha256 !== attachmentManifestSha256
    )) return null;
    return {
      runId: row.runId,
      sourceRevisionSha256,
      attachmentManifestSha256: isSha256(attachmentManifestSha256) ? attachmentManifestSha256 : null,
      reviewState: plan.promotionPlan.auditState,
      plannedCriterionStableKeys: plan.promotionPlan.criterionStableKeys,
      plannedV2QuestionStableKeys: plan.promotionPlan.questions
        .filter((question) => question.evaluationContractVersion === CONFIRMATION_EVALUATION_V2)
        .map((question) => question.criterionStableKey),
    };
  } catch {
    return null;
  }
}

function sameUniqueNonEmptyValues(actual: readonly (string | null)[], expected: readonly string[]): boolean {
  const normalizedActual = uniqueNonEmpty(actual);
  const normalizedExpected = uniqueNonEmpty(expected);
  return normalizedActual.length === actual.length
    && normalizedExpected.length === expected.length
    && normalizedActual.length === normalizedExpected.length
    && normalizedActual.every((value, index) => value === normalizedExpected[index]);
}

function uniqueNonEmpty(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))].sort();
}

function hasDeclaredAttachments(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) result.set(key(row), [...(result.get(key(row)) ?? []), row]);
  return result;
}

function sourceKey(source: string, sourceId: string): string {
  return `${source}\u0000${sourceId}`;
}

function isSha256(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function kstDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function kstDayBounds(value: Date): { start: Date; end: Date } {
  const day = kstDate(value);
  return {
    start: new Date(`${day}T00:00:00.000+09:00`),
    end: new Date(`${day}T23:59:59.999+09:00`),
  };
}
