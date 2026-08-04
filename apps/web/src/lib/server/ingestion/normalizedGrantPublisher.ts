import { and, eq, inArray, isNotNull, notInArray } from "drizzle-orm";
import type {
  Grant,
  GrantCriterion,
  GrantExtractionWarningCode,
  GrantRaw,
  GrantSource,
  MatchExtractionReadiness,
  NormalizedGrant,
} from "@cunote/contracts";
import { buildGrantExtractionManifest } from "@cunote/core";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import {
  registerAttachmentConversions,
  type ArchivedAttachmentRef,
} from "../conversion/registerAttachmentConversions";
import { readDetectedSurfaceFormat } from "./grantAttachmentArchive";
import { hashGrantRawPayload } from "./grantRawHash";
import { acquireGrantPublicationLock } from "./grantPublicationLock";
import {
  classifyPublishedGrantRevision,
  expandConfirmedGrantComponentIds,
  matchingAttachmentRevisionProjection,
  type PublishedGrantRevisionKind,
  type PublishedGrantRevisionSnapshot,
} from "./grantRevisionInvalidation";
import { runGrantRevisionScopedRefresh } from "../matches/grantRevisionScopedRefreshCore";

export interface NormalizedGrantPublishPlan {
  source: GrantSource;
  rawCount: number;
  grantCount: number;
  criteriaCount: number;
  rawHashes: string[];
  extractionReadinessCounts: Record<MatchExtractionReadiness, number>;
  extractionWarningCounts: Partial<Record<GrantExtractionWarningCode, number>>;
}

export interface NormalizedGrantPublishResult extends NormalizedGrantPublishPlan {
  publishedAt: string;
  revisionCounts: Record<PublishedGrantRevisionKind, number>;
  matchStateInvalidatedCount: number;
  matchStateRefreshedCount: number;
  matchStateRefreshRequired: boolean;
  /** grant-scope 재계산 대상. confirmed member 변경 시 canonical component도 포함한다. */
  matchStateRefreshGrantIds: string[];
  /**
   * P1 승격 보호(promotion-protected): 기존 criteria에 stable_key 행이 있어 criteria 교체를
   * 스킵하고 승격 큐레이션 세트를 보존한 grant 수.
   * (docs/research/2026-08-04-운영-딥분석-크론과-로컬-구독-겹침-조사.md §1.5·§3 P1)
   */
  promotionProtectedCount: number;
  /** 보호가 발동한 공고 source_id 목록 — 수집 크론 로그·감사에서 보호 발동 확인용. */
  promotionProtectedSourceIds: string[];
  /** T7 후크: surface 생성/변환 job 등록 중 발생한 경고 (아카이브는 성공). */
  conversionWarnings?: string[];
}

export function planNormalizedGrantPublication<TPayload>(
  source: GrantSource,
  entries: Array<NormalizedGrant<TPayload>>,
): NormalizedGrantPublishPlan {
  assertEntriesUseSource(source, entries);
  const manifests = entries.map((entry) => buildGrantExtractionManifest(entry));

  return {
    source,
    rawCount: entries.length,
    grantCount: entries.length,
    criteriaCount: entries.reduce((sum, entry) => sum + entry.criteria.length, 0),
    rawHashes: entries.map((entry) => hashGrantRawPayload(entry.raw.payload)),
    extractionReadinessCounts: histogram(
      manifests.map((manifest) => manifest.readiness),
      ["reviewed", "structured_unreviewed", "partial", "unstructured"],
    ),
    extractionWarningCounts: histogram(
      manifests.flatMap((manifest) => manifest.warnings),
    ),
  };
}

function histogram<T extends string>(values: T[], keys: T[] = []): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export async function publishNormalizedGrants<TPayload>(
  db: CunoteDb,
  entries: Array<NormalizedGrant<TPayload>>,
  options: {
    source: GrantSource;
    page?: number;
    collectedAt?: Date;
  },
): Promise<NormalizedGrantPublishResult> {
  const collectedAt = options.collectedAt ?? new Date();
  assertEntriesUseSource(options.source, entries);

  const conversionWarnings: string[] = [];

  const result = await db.transaction(async (tx) => {
    const confirmedLinks = await tx
      .select({
        canonicalGrantId: schema.dedupLinks.canonicalGrantId,
        memberGrantId: schema.dedupLinks.memberGrantId,
      })
      .from(schema.dedupLinks)
      .where(eq(schema.dedupLinks.confirmed, true));
    const revisionCounts: Record<PublishedGrantRevisionKind, number> = {
      new: 0,
      unchanged: 0,
      changed: 0,
    };
    const refreshGrantIds = new Set<string>();
    const invalidatedStateKeys = new Set<string>();
    const invalidatedCompanyIds = new Set<string>();
    const promotionProtectedSourceIds: string[] = [];

    for (const entry of entries) {
      const nextRawHash = hashGrantRawPayload(entry.raw.payload);
      const loadPrevious = async () => {
        const [row] = await tx
          .select({
            grant: schema.grants,
            grantId: schema.grants.id,
            rawHash: schema.grantRaw.rawHash,
            attachments: schema.grantRaw.attachments,
            parserVersion: schema.grants.parserVersion,
            modelVer: schema.grants.modelVer,
            promptVer: schema.grants.promptVer,
          })
          .from(schema.grants)
          .leftJoin(schema.grantRaw, and(
            eq(schema.grantRaw.source, schema.grants.source),
            eq(schema.grantRaw.sourceId, schema.grants.sourceId),
          ))
          .where(and(
            eq(schema.grants.source, entry.grant.source),
            eq(schema.grants.sourceId, entry.grant.source_id),
          ))
          .limit(1);
        return row;
      };
      let previous = await loadPrevious();
      if (previous?.grantId) {
        await acquireGrantPublicationLock(tx, previous.grantId);
        // lock 대기 중 다른 publisher가 완료됐을 수 있으므로 revision baseline을 다시 읽는다.
        previous = await loadPrevious();
      }
      const previousCriteria = previous
        ? await tx.select().from(schema.grantCriteria)
          .where(eq(schema.grantCriteria.grantId, previous.grantId))
        : [];
      // P1 승격 보호(promotion-protected) 판별 — 추가 쿼리 없이, 위에서 이미 읽은
      // previousCriteria(advisory lock 획득 후 재조회 baseline)를 재사용한다.
      const promotionProtected = hasPromotionProtectedCriteria(previousCriteria);
      const { stored, incoming } = computePublishRevisionSnapshots({
        previous,
        previousCriteria,
        entry,
        nextRawHash,
        promotionProtected,
      });
      const revisionKind = classifyPublishedGrantRevision(stored, incoming);
      revisionCounts[revisionKind] += 1;

      await tx
        .insert(schema.grantRaw)
        .values({
          source: entry.raw.source,
          sourceId: entry.raw.source_id,
          payload: entry.raw.payload as unknown as Record<string, unknown>,
          attachments: rawAttachments(entry.raw.attachments),
          rawHash: nextRawHash,
          collectedAt,
          status: "published",
        })
        .onConflictDoUpdate({
          target: [schema.grantRaw.source, schema.grantRaw.sourceId],
          set: {
            payload: entry.raw.payload as unknown as Record<string, unknown>,
            attachments: rawAttachments(entry.raw.attachments),
            rawHash: nextRawHash,
            collectedAt,
            status: "published",
          },
        });

      if (revisionKind !== "unchanged") {
        await tx
          .insert(schema.grantCollectionEvents)
          .values({
            source: entry.raw.source,
            sourceId: entry.raw.source_id,
            rawHash: nextRawHash,
            revisionKind,
            collectedAt,
          })
          .onConflictDoNothing({
            target: [
              schema.grantCollectionEvents.source,
              schema.grantCollectionEvents.sourceId,
              schema.grantCollectionEvents.rawHash,
            ],
          });
      }

      const [grant] = await tx
        .insert(schema.grants)
        .values(grantInsertValues(entry.grant, collectedAt))
        .onConflictDoUpdate({
          target: [schema.grants.source, schema.grants.sourceId],
          set: grantUpdateValues(entry.grant, collectedAt),
        })
        .returning({ id: schema.grants.id });

      if (!grant) {
        throw new Error(`${options.source} grant publish failed: ${entry.grant.source_id}`);
      }

      if (revisionKind === "changed" && previous?.grantId) {
        const affectedGrantIds = expandConfirmedGrantComponentIds([previous.grantId], confirmedLinks);
        for (const grantId of affectedGrantIds) refreshGrantIds.add(grantId);
        const deleted = await tx
          .delete(schema.matchState)
          .where(inArray(schema.matchState.grantId, affectedGrantIds))
          .returning({
            companyId: schema.matchState.companyId,
            grantId: schema.matchState.grantId,
          });
        for (const row of deleted) {
          invalidatedStateKeys.add(`${row.companyId}:${row.grantId}`);
          invalidatedCompanyIds.add(row.companyId);
        }
      }

      if (promotionProtected) {
        // P1 승격 보호: delete·insert 모두 스킵해 승격 큐레이션 세트를 완전 보존한다.
        // 파서 criteria 를 병존 삽입하면 의미가 겹치는 행이 이중 매칭을 만들므로 금지.
        // 이 grant 의 criteria 갱신은 재분석→재승격(lab:promote) 경로만 허용한다.
        promotionProtectedSourceIds.push(entry.grant.source_id);
      } else {
        await tx.delete(schema.grantCriteria).where(eq(schema.grantCriteria.grantId, grant.id));
        if (entry.criteria.length > 0) {
          await tx.insert(schema.grantCriteria).values(
            entry.criteria.map((criterion) => criterionInsertValues(grant.id, criterion)),
          );
        }
      }

      const archivedAttachments = grantAttachmentArchiveRows(entry);
      if (archivedAttachments.length > 0) {
        await tx
          .delete(schema.grantAttachmentArchives)
          .where(and(
            eq(schema.grantAttachmentArchives.source, entry.raw.source),
            eq(schema.grantAttachmentArchives.sourceId, entry.raw.source_id),
            notInArray(
              schema.grantAttachmentArchives.sourceUri,
              archivedAttachments.map((attachment) => attachment.sourceUri ?? ""),
            ),
          ));
        for (const attachment of archivedAttachments) {
          await tx
            .insert(schema.grantAttachmentArchives)
            .values(attachment)
            .onConflictDoUpdate({
              target: [
                schema.grantAttachmentArchives.source,
                schema.grantAttachmentArchives.sourceId,
                schema.grantAttachmentArchives.filename,
                schema.grantAttachmentArchives.sourceUri,
              ],
              set: {
                archiveUrl: attachment.archiveUrl,
                storageKey: attachment.storageKey,
                contentType: attachment.contentType,
                bytes: attachment.bytes,
                sha256: attachment.sha256,
                fetchedAt: attachment.fetchedAt,
                conversionStatus: attachment.conversionStatus,
                markdownUrl: attachment.markdownUrl,
                markdownStorageKey: attachment.markdownStorageKey,
                markdownSha256: attachment.markdownSha256,
                markdownBytes: attachment.markdownBytes,
                converter: attachment.converter,
                convertedAt: attachment.convertedAt,
                conversionError: attachment.conversionError,
                updatedAt: collectedAt,
              },
            });
        }
      }

      // T7: 아카이브 완료 후크 — 변환 대상 첨부에 surface 생성 + 변환 job 등록 (계획 8.1~8.2).
      //   grantId 가 확보된 지점. 실패는 warning 으로 삼키고 아카이브(publish)는 성공 처리한다.
      try {
        const attachmentRefs = conversionAttachmentRefs(entry);
        if (attachmentRefs.length > 0) {
          const hook = await registerAttachmentConversions(tx as unknown as CunoteDbSession, {
            grantId: grant.id,
            source: entry.raw.source,
            sourceId: entry.raw.source_id,
            attachments: attachmentRefs,
          });
          conversionWarnings.push(...hook.warnings);
        }
      } catch (error) {
        // 후크 전체 실패도 아카이브를 막지 않는다.
        conversionWarnings.push(
          `변환 후크 실패 (${entry.raw.source_id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await tx
      .insert(schema.sourceCursor)
      .values({
        source: options.source,
        lastPage: options.page ?? 1,
        lastCollectedAt: collectedAt,
      })
      .onConflictDoUpdate({
        target: schema.sourceCursor.source,
        set: {
          lastPage: options.page ?? 1,
          lastCollectedAt: collectedAt,
        },
      });

    let matchStateRefreshedCount = 0;
    if (refreshGrantIds.size > 0 && invalidatedCompanyIds.size > 0) {
      const refresh = await runGrantRevisionScopedRefresh({
        db: tx as unknown as CunoteDb,
        grantIds: [...refreshGrantIds],
        companyIds: [...invalidatedCompanyIds],
        companyLimit: invalidatedCompanyIds.size,
        asOf: collectedAt,
        write: true,
      });
      matchStateRefreshedCount = numberField(refresh.savedCount);
      if (matchStateRefreshedCount !== invalidatedCompanyIds.size * numberField(refresh.candidateGrantCount)) {
        throw new Error(
          `incomplete grant revision match-state refresh: invalidated=${invalidatedStateKeys.size}, refreshed=${matchStateRefreshedCount}`,
        );
      }
    }

    return {
      ...planNormalizedGrantPublication(options.source, entries),
      publishedAt: collectedAt.toISOString(),
      revisionCounts,
      matchStateInvalidatedCount: invalidatedStateKeys.size,
      matchStateRefreshedCount,
      matchStateRefreshRequired: invalidatedStateKeys.size > 0 && matchStateRefreshedCount === 0,
      matchStateRefreshGrantIds: [...refreshGrantIds].sort(),
      promotionProtectedCount: promotionProtectedSourceIds.length,
      promotionProtectedSourceIds: [...promotionProtectedSourceIds].sort(),
      ...(conversionWarnings.length > 0 ? { conversionWarnings } : {}),
    };
  });

  if (result.promotionProtectedCount > 0) {
    // 관측성: 수집 크론(Vercel) 함수 로그에 보호 발동을 1줄로 남긴다 — 커밋된 publish에만 기록.
    console.warn(
      `[grant-publish] source=${options.source} promotionProtected=${result.promotionProtectedCount} `
      + `sourceIds=${result.promotionProtectedSourceIds.join(",")} — 승격 보호 grant는 criteria 교체 스킵(큐레이션 세트 보존)`,
    );
  }
  return result;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * P1 승격 보호(promotion-protected) 판별 — grant의 기존 criteria에 stable_key(NOT NULL) 행이
 * 하나라도 있으면 딥분석 승격 큐레이션 세트가 서빙 중인 상태다.
 *
 * 이 판별이 스키마 확장 없이 자기정합적인 근거:
 *  1) 승격 엔진(analysis-lab/promote-cli)은 발행하는 모든 행에 stableKey를 부여하고,
 *     승격 세트 밖의 stale 행(파서가 남긴 NULL 행 포함)을 삭제한다 → 승격 후 전 행 NOT NULL.
 *  2) 수집 파서 발행(criterionInsertValues 직행)은 stableKey를 세팅하지 않는다(NULL).
 *  3) 승격 롤백은 승격 전 원본(NULL) 행을 복원한다 → 롤백 즉시 보호 해제.
 */
export function hasPromotionProtectedCriteria(
  criteria: Array<Pick<typeof schema.grantCriteria.$inferSelect, "stableKey">>,
): boolean {
  return criteria.some((criterion) => criterion.stableKey !== null);
}

/**
 * 수동 CLI(재정규화·reviewed 재발행)용 배치 판별 — grantIds 중 승격 보호 상태인 id 집합.
 * publisher 경로는 이미 읽는 previousCriteria를 재사용하므로 이 쿼리를 쓰지 않는다(추가 비용 0).
 */
export async function selectPromotionProtectedGrantIds(
  db: CunoteDbSession,
  grantIds: string[],
): Promise<Set<string>> {
  if (grantIds.length === 0) return new Set();
  const rows = await db
    .select({ grantId: schema.grantCriteria.grantId })
    .from(schema.grantCriteria)
    .where(and(
      inArray(schema.grantCriteria.grantId, grantIds),
      isNotNull(schema.grantCriteria.stableKey),
    ))
    .groupBy(schema.grantCriteria.grantId);
  return new Set(rows.map((row) => row.grantId));
}

/** 수동 CLI 공통: 승격 보호 grant의 criteria 교체를 스킵할 때 남기는 stderr 경고 1줄. */
export function promotionProtectedSkipWarning(grantRef: string): string {
  return `[promotion-protected] ${grantRef}: 승격 보호로 criteria 유지(교체 스킵) — 갱신은 재분석→재승격(lab:promote) 경로로`;
}

export function warnPromotionProtectedSkip(grantRef: string): void {
  process.stderr.write(`${promotionProtectedSkipWarning(grantRef)}\n`);
}

interface StoredGrantRevisionRow {
  grant: typeof schema.grants.$inferSelect;
  rawHash: string | null;
  attachments: unknown;
  parserVersion: string | null;
  modelVer: string | null;
  promptVer: string | null;
}

/**
 * revision 지문(snapshot) 계산.
 *
 * stored·incoming 양측 grant projection은 동일한 매칭 필드 집합으로 대칭 계산한다(P1-b, 전 공고).
 * 이전에는 stored 쪽이 DB 행 전체를 spread 해 id·updatedAt·servingState·embedding 등 비교
 * 대상이 아닌 잡음이 지문에 섞였고("수집 시각은 의도적으로 비교하지 않는다"는
 * grantRevisionInvalidation 의 의도와 상충), 기존 grant 재발행은 구조적으로 unchanged 가 될 수
 * 없었다. rawHash 는 스냅샷에 그대로 포함되므로 원문 실변화 시 changed 판정은 불변이며, 이
 * 대칭화로 판정이 달라지는 것은 same-raw 재발행(원문 동일 재발행) 경로뿐이다 —
 * 2026-08 메인 세션 30일 실측: unchanged 0건·changed 86건 전수 raw_hash 실변화,
 * same-raw 재발행 0건(비대칭은 휴면 상태였고, 이 변경은 뇌관 제거 + P1 보호/비보호 비일관성 해소).
 *
 * 승격 보호 grant는 추가로 criteria를 양측 대칭 제외한다(빈 배열로 {grant, criteria} 형태 보존) —
 * 승격분≠파서분 차이만으로 매 사이클 changed가 되는 영구 재분류를 차단하고, 본문·필드·첨부·
 * 추출기 버전의 실변화만 changed 신호로 남긴다.
 */
export function computePublishRevisionSnapshots<TPayload>(input: {
  previous: StoredGrantRevisionRow | null | undefined;
  previousCriteria: Array<typeof schema.grantCriteria.$inferSelect>;
  entry: NormalizedGrant<TPayload>;
  nextRawHash: string;
  promotionProtected: boolean;
}): { stored: PublishedGrantRevisionSnapshot | null; incoming: PublishedGrantRevisionSnapshot } {
  const { previous, previousCriteria, entry, nextRawHash, promotionProtected } = input;
  const storedProjection = previous
    ? storedMatchingProjection(previous.grant, promotionProtected ? [] : previousCriteria)
    : null;
  const incomingProjection = promotionProtected
    ? {
      grant: normalizedGrantProjection(incomingGrantProjectionInput(entry)),
      criteria: normalizedCriteriaProjection([]),
    }
    : incomingMatchingProjection(entry);
  return {
    stored: previous ? {
      rawHash: previous.rawHash,
      matchingProjectionHash: hashGrantRawPayload(storedProjection),
      attachments: matchingAttachmentRevisionProjection(previous.attachments),
      parserVersion: previous.parserVersion,
      modelVer: previous.modelVer,
      promptVer: previous.promptVer,
    } : null,
    incoming: {
      rawHash: nextRawHash,
      matchingProjectionHash: hashGrantRawPayload(incomingProjection),
      attachments: matchingAttachmentRevisionProjection(rawAttachments(entry.raw.attachments)),
      parserVersion: entry.grant.parser_version ?? null,
      modelVer: entry.grant.model_ver ?? null,
      promptVer: entry.grant.prompt_ver ?? null,
    },
  };
}

/**
 * stored grant 행을 매칭 projection 필드로만 좁힌다 — stored·incoming 지문 대칭의 기준 필드
 * 집합(P1-b 부터 보호 여부와 무관하게 전 공고에 적용).
 */
function pickStoredGrantProjectionFields(
  grant: typeof schema.grants.$inferSelect,
): Parameters<typeof normalizedGrantProjection>[0] {
  return {
    title: grant.title,
    url: grant.url,
    agencyJurisdiction: grant.agencyJurisdiction,
    agencyOperator: grant.agencyOperator,
    agencyPrimary: grant.agencyPrimary,
    categoryL1: grant.categoryL1,
    categoryL2: grant.categoryL2,
    applyStart: grant.applyStart,
    applyEnd: grant.applyEnd,
    applyMethod: grant.applyMethod,
    supportAmount: grant.supportAmount,
    benefits: grant.benefits,
    requiredDocuments: grant.requiredDocuments,
    status: grant.status,
    fRegions: grant.fRegions,
    fIndustries: grant.fIndustries,
    fBizAgeMinMonths: grant.fBizAgeMinMonths,
    fBizAgeMaxMonths: grant.fBizAgeMaxMonths,
    fSizes: grant.fSizes,
    fFounderTraits: grant.fFounderTraits,
    fRequiredCerts: grant.fRequiredCerts,
    fApplyMethods: grant.fApplyMethods,
    fAuthoringMode: grant.fAuthoringMode,
    // 잠재 리스크: overallConfidence 는 float4(real) 왕복 값 — 파서가 소수 2자리 round 를 유지하는
    // 한 incoming 과 대칭이지만, 그 불변식이 깨지면 보호 grant 가 상시 changed 로 흐를 수 있다.
    overallConfidence: grant.overallConfidence,
  };
}

function incomingGrantProjectionInput<TPayload>(
  entry: NormalizedGrant<TPayload>,
): Parameters<typeof normalizedGrantProjection>[0] {
  return {
    title: entry.grant.title,
    url: entry.grant.url ?? null,
    agencyJurisdiction: entry.grant.agency_jurisdiction ?? null,
    agencyOperator: entry.grant.agency_operator ?? null,
    agencyPrimary: entry.grant.agency_primary ?? null,
    categoryL1: entry.grant.category_l1 ?? null,
    categoryL2: entry.grant.category_l2 ?? null,
    applyStart: dateValue(entry.grant.apply_start),
    applyEnd: dateValue(entry.grant.apply_end),
    applyMethod: entry.grant.apply_method ?? null,
    supportAmount: entry.grant.support_amount ?? null,
    benefits: entry.grant.benefits ?? null,
    requiredDocuments: entry.grant.required_documents ?? null,
    status: entry.grant.status,
    fRegions: entry.grant.f_regions,
    fIndustries: entry.grant.f_industries,
    fBizAgeMinMonths: entry.grant.f_biz_age_min_months ?? null,
    fBizAgeMaxMonths: entry.grant.f_biz_age_max_months ?? null,
    fSizes: entry.grant.f_sizes,
    fFounderTraits: entry.grant.f_founder_traits,
    fRequiredCerts: entry.grant.f_required_certs,
    fApplyMethods: entry.grant.f_apply_methods ?? [],
    fAuthoringMode: entry.grant.f_authoring_mode ?? "unknown",
    overallConfidence: entry.grant.overall_confidence,
  };
}

function incomingMatchingProjection<TPayload>(entry: NormalizedGrant<TPayload>): Record<string, unknown> {
  return {
    grant: normalizedGrantProjection(incomingGrantProjectionInput(entry)),
    criteria: normalizedCriteriaProjection(entry.criteria.map((criterion) => ({
      dimension: criterion.dimension,
      operator: criterion.operator,
      value: criterion.value,
      kind: criterion.kind,
      weight: criterion.weight ?? null,
      confidence: criterion.confidence,
      sourceSpan: criterion.source_span ?? null,
      rawText: criterion.raw_text ?? null,
      sourceField: criterion.source_field ?? null,
      needsReview: criterion.needs_review ?? false,
      parserVersion: criterion.parser_version ?? null,
    }))),
  };
}

function storedMatchingProjection(
  grant: typeof schema.grants.$inferSelect,
  criteria: Array<typeof schema.grantCriteria.$inferSelect>,
): Record<string, unknown> {
  return {
    // P1-b: DB 행 전체 spread 금지 — 매칭 projection 필드로 절단해 incoming 과 대칭 계산한다.
    // (이전에는 id·updatedAt·servingState·embedding 등 잡음이 stored 지문에 섞여 기존 grant
    //  재발행이 구조적으로 unchanged 가 될 수 없었다. rawHash 는 스냅샷에 그대로 포함되므로
    //  원문 실변화 시 changed 는 불변 — 판정이 달라지는 것은 same-raw 재발행뿐이며, 30일 실측
    //  unchanged 0·changed 86 전수 raw 실변화·same-raw 재발행 0으로 휴면 경로였다.)
    grant: normalizedGrantProjection(pickStoredGrantProjectionFields(grant)),
    criteria: normalizedCriteriaProjection(criteria.map((criterion) => ({
      dimension: criterion.dimension,
      operator: criterion.operator,
      value: criterion.value,
      kind: criterion.kind,
      weight: criterion.weight,
      confidence: criterion.confidence,
      sourceSpan: criterion.sourceSpan,
      rawText: criterion.rawText,
      sourceField: criterion.sourceField,
      needsReview: criterion.needsReview,
      parserVersion: criterion.parserVersion,
    }))),
  };
}

function normalizedGrantProjection(grant: {
  title: string;
  url: string | null;
  agencyJurisdiction: string | null;
  agencyOperator: string | null;
  agencyPrimary: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  applyStart: Date | null;
  applyEnd: Date | null;
  applyMethod: unknown;
  supportAmount: unknown;
  benefits: unknown;
  requiredDocuments: unknown;
  status: string;
  fRegions: string[];
  fIndustries: string[];
  fBizAgeMinMonths: number | null;
  fBizAgeMaxMonths: number | null;
  fSizes: string[];
  fFounderTraits: string[];
  fRequiredCerts: string[];
  fApplyMethods: string[];
  fAuthoringMode: string;
  overallConfidence: number;
}): Record<string, unknown> {
  return {
    ...grant,
    applyStart: grant.applyStart?.toISOString() ?? null,
    applyEnd: grant.applyEnd?.toISOString() ?? null,
    fRegions: [...grant.fRegions].sort(),
    fIndustries: [...grant.fIndustries].sort(),
    fSizes: [...grant.fSizes].sort(),
    fFounderTraits: [...grant.fFounderTraits].sort(),
    fRequiredCerts: [...grant.fRequiredCerts].sort(),
    fApplyMethods: [...grant.fApplyMethods].sort(),
  };
}

function normalizedCriteriaProjection(criteria: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return criteria
    .map((criterion) => ({ ...criterion }))
    .sort((left, right) => hashGrantRawPayload(left).localeCompare(hashGrantRawPayload(right)));
}

/**
 * publish 대상 grant 의 아카이브된 첨부에서 변환 후크 입력(sha256/archive_url)을 뽑는다.
 * archive_url + sha256 이 있는 첨부만 변환 서버가 다운로드·캐시할 수 있다.
 */
function conversionAttachmentRefs<TPayload>(
  entry: NormalizedGrant<TPayload>,
): ArchivedAttachmentRef[] {
  return (entry.raw.attachments ?? []).flatMap((attachment) => {
    const filename = textValue(attachment.filename);
    if (!filename) return [];
    const archiveIdentity = normalizedAttachmentArchiveIdentity(attachment);
    // 아카이브 시점 매직 바이트 검출 결과가 첨부 JSON 에 실려 있으면 그대로 넘긴다.
    // 없으면(byte-less 경로) detectedFormat 를 생략해 registerAttachmentConversions 가 확장자로 폴백한다.
    const detectedFormat = readDetectedSurfaceFormat(attachment);
    return [{
      filename,
      ...archiveIdentity,
      ...(detectedFormat !== undefined ? { detectedFormat } : {}),
    }];
  });
}

/**
 * 원본 첨부 URL과 실제 아카이브 URL을 분리한다.
 *
 * `url`은 아카이브 전에는 원본 제공처 URL일 수 있으므로 archiveUrl의 fallback으로
 * 사용하면 안 된다. 실제 아카이브 완료 여부는 storageKey/sha256과 함께 판단한다.
 */
export function normalizedAttachmentArchiveIdentity(
  attachment: Record<string, unknown>,
): Pick<ArchivedAttachmentRef, "storageKey" | "archiveUrl" | "sourceUri" | "sha256"> {
  return {
    storageKey: textValue(attachment.storage_key),
    archiveUrl: textValue(attachment.archive_url),
    sourceUri: textValue(attachment.source_uri) ?? textValue(attachment.url),
    sha256: textValue(attachment.sha256),
  };
}

function grantInsertValues(grant: Grant, updatedAt: Date): typeof schema.grants.$inferInsert {
  return {
    ...grantUpdateValues(grant, updatedAt),
    source: grant.source,
    sourceId: grant.source_id,
  };
}

function grantUpdateValues(
  grant: Grant,
  updatedAt: Date,
): Omit<typeof schema.grants.$inferInsert, "id" | "source" | "sourceId"> {
  return {
    title: grant.title,
    url: grant.url ?? null,
    agencyJurisdiction: grant.agency_jurisdiction ?? null,
    agencyOperator: grant.agency_operator ?? null,
    agencyPrimary: grant.agency_primary ?? null,
    categoryL1: grant.category_l1 ?? null,
    categoryL2: grant.category_l2 ?? null,
    applyStart: dateValue(grant.apply_start),
    applyEnd: dateValue(grant.apply_end),
    applyMethod: grant.apply_method ?? null,
    supportAmount: (grant.support_amount ?? null) as Record<string, unknown> | null,
    benefits: (grant.benefits ?? null) as Array<Record<string, unknown>> | null,
    requiredDocuments: (grant.required_documents ?? null) as Array<Record<string, unknown>> | null,
    status: grant.status,
    fRegions: grant.f_regions,
    fIndustries: grant.f_industries,
    fBizAgeMinMonths: grant.f_biz_age_min_months ?? null,
    fBizAgeMaxMonths: grant.f_biz_age_max_months ?? null,
    fSizes: grant.f_sizes,
    fFounderTraits: grant.f_founder_traits,
    fRequiredCerts: grant.f_required_certs,
    fApplyMethods: grant.f_apply_methods ?? [],
    fAuthoringMode: grant.f_authoring_mode ?? "unknown",
    overallConfidence: grant.overall_confidence,
    modelVer: grant.model_ver ?? null,
    promptVer: grant.prompt_ver ?? null,
    parserVersion: grant.parser_version ?? null,
    updatedAt,
  };
}

// export: analysis-lab 승격 CLI(promote-cli)가 동일 매핑을 재사용한다 — 발행 경로 이중 구현 금지.
export function criterionInsertValues(
  grantId: string,
  criterion: GrantCriterion,
): typeof schema.grantCriteria.$inferInsert {
  return {
    grantId,
    dimension: criterion.dimension,
    operator: criterion.operator,
    value: criterion.value as Record<string, unknown>,
    kind: criterion.kind,
    weight: criterion.weight ?? null,
    confidence: criterion.confidence,
    sourceSpan: criterion.source_span ?? null,
    rawText: criterion.raw_text ?? null,
    sourceField: criterion.source_field ?? null,
    needsReview: criterion.needs_review ?? false,
    parserVersion: criterion.parser_version ?? null,
  };
}

function dateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rawAttachments(
  value: GrantRaw["attachments"] | undefined | null,
): Array<Record<string, unknown>> | null {
  if (!value || value.length === 0) return null;
  return value as Array<Record<string, unknown>>;
}

function grantAttachmentArchiveRows<TPayload>(
  entry: NormalizedGrant<TPayload>,
): Array<typeof schema.grantAttachmentArchives.$inferInsert> {
  return (entry.raw.attachments ?? []).flatMap((attachment) => {
    const filename = textValue(attachment.filename);
    if (!filename) return [];
    const archiveIdentity = normalizedAttachmentArchiveIdentity(attachment);
    const conversion = attachment.conversion;
    const row: typeof schema.grantAttachmentArchives.$inferInsert = {
      source: entry.raw.source,
      sourceId: entry.raw.source_id,
      filename,
      sourceUri: archiveIdentity.sourceUri ?? "",
      archiveUrl: archiveIdentity.archiveUrl,
      storageKey: archiveIdentity.storageKey,
      contentType: textValue(attachment.content_type),
      bytes: numberValue(attachment.bytes),
      sha256: archiveIdentity.sha256,
      fetchedAt: dateValue(textValue(attachment.fetched_at)),
      conversionStatus: conversion?.status ?? null,
      markdownUrl: textValue(conversion?.markdown_url),
      markdownStorageKey: textValue(conversion?.markdown_storage_key),
      markdownSha256: textValue(conversion?.markdown_sha256),
      markdownBytes: numberValue(conversion?.markdown_bytes),
      converter: textValue(conversion?.converter),
      convertedAt: dateValue(textValue(conversion?.converted_at)),
      conversionError: textValue(conversion?.error),
    };
    return [row];
  });
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertEntriesUseSource<TPayload>(
  source: GrantSource,
  entries: Array<NormalizedGrant<TPayload>>,
): void {
  for (const entry of entries) {
    if (entry.raw.source !== source || entry.grant.source !== source) {
      throw new Error(
        `Normalized grant source mismatch: expected ${source}, got raw=${entry.raw.source}, grant=${entry.grant.source}, source_id=${entry.grant.source_id}`,
      );
    }
  }
}
