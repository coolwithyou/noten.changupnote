// P1 수집 publisher 승격 보호(promotion-protected) 가드 검증 — DB 없이 유닛/픽스처로만.
// 근거: docs/research/2026-08-04-운영-딥분석-크론과-로컬-구독-겹침-조사.md §1.5·§3 P1
//
// 검증 항목:
//  ① 보호 grant → criteria 무접촉(delete·insert 0회) + criteria 차이만으로는 revision unchanged
//  ② 비보호 grant → P1-b 대칭 지문과 바이트 단위 동일. baseline* 은 P1-b 기준 지문 구현의
//     **동결 사본**(해시·첨부 projection까지 인라인 — 라이브 모듈 변경도 잡아내는 회귀 핀).
//     주의: P1-b 에서 stored 측을 매칭 필드로 절단하는 **의도된 동작 변경**이 있었고, 이
//     baseline 은 그 변경을 반영해 갱신됐다(P1 이전 전체 행 spread 기준이 아님).
//  ②-b P1-b 대칭 효과: 비보호 same-raw 재발행 + DB 행 잡음(updatedAt·servingState·embedding)만
//     → unchanged, 실변화(제목·rawHash)는 changed 유지
//  ③ 롤백 복원 상태(전부 NULL stable_key) → 보호 해제, delete→insert 재개
//  ④ 수동 CLI 가드 경고 경로(stderr 1줄) + selectPromotionProtectedGrantIds 쿼리 경로
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { classifyPublishedGrantRevision } from "./grantRevisionInvalidation";
import { hashGrantRawPayload } from "./grantRawHash";
import {
  computePublishRevisionSnapshots,
  hasPromotionProtectedCriteria,
  promotionProtectedSkipWarning,
  publishNormalizedGrants,
  selectPromotionProtectedGrantIds,
  warnPromotionProtectedSkip,
} from "./normalizedGrantPublisher";

const GRANT_ID = "11111111-1111-4111-8111-111111111111";
const RICH_GRANT_ID = "33333333-3333-4333-8333-333333333333";
const COLLECTED_AT = new Date("2026-08-04T01:00:00.000Z");

// ---------------------------------------------------------------------------
// 픽스처
// ---------------------------------------------------------------------------

type StoredGrantRow = typeof schema.grants.$inferSelect;
type StoredCriterionRow = typeof schema.grantCriteria.$inferSelect;
type RawAttachmentList = NonNullable<NormalizedGrant["raw"]["attachments"]>;

function makeEntry(overrides: {
  title?: string;
  criteria?: GrantCriterion[];
} = {}): NormalizedGrant<Record<string, unknown>> {
  return {
    raw: {
      source: "kstartup",
      source_id: "PBLN_TEST_1",
      payload: { intg_pbanc_biz_nm: "테스트 공고", body: "본문" },
      status: "published",
    },
    grant: {
      source: "kstartup",
      source_id: "PBLN_TEST_1",
      title: overrides.title ?? "테스트 공고",
      url: "https://example.com/announcement/1",
      apply_start: "2026-08-01T00:00:00.000Z",
      apply_end: "2026-08-31T00:00:00.000Z",
      status: "open",
      f_regions: ["서울"],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      f_apply_methods: ["online"],
      f_authoring_mode: "unknown",
      overall_confidence: 0.5,
      parser_version: "parser-1",
    },
    criteria: overrides.criteria ?? [parserCriterion()],
  };
}

function parserCriterion(): GrantCriterion {
  return {
    dimension: "region",
    operator: "in",
    value: { regions: ["서울"] },
    kind: "required",
    confidence: 0.8,
    raw_text: "서울 소재 기업",
    parser_version: "parser-1",
  };
}

/** 희소성 해소 픽스처: 첨부 1개 + jsonb 값(applyMethod·supportAmount·benefits) + criteria 2건. */
function richAttachment(): RawAttachmentList[number] {
  return {
    filename: "사업계획서 양식.hwp",
    url: "https://example.com/files/2",
    source_uri: "https://example.com/files/2",
    archive_url: "https://archive.example.com/files/2",
    storage_key: "grants/kstartup/PBLN_TEST_2/2.hwp",
    content_type: "application/x-hwp",
    bytes: 123456,
    sha256: "a".repeat(64),
    fetched_at: "2026-08-01T00:00:00.000Z",
    conversion: {
      status: "converted",
      markdown_url: "https://archive.example.com/files/2.md",
      markdown_storage_key: "grants/kstartup/PBLN_TEST_2/2.md",
      markdown_sha256: "b".repeat(64),
      markdown_bytes: 2345,
      converter: "libreoffice-h2orestart",
      converted_at: "2026-08-01T01:00:00.000Z",
    },
  };
}

function makeRichEntry(): NormalizedGrant<Record<string, unknown>> {
  return {
    raw: {
      source: "kstartup",
      source_id: "PBLN_TEST_2",
      payload: { intg_pbanc_biz_nm: "리치 공고", detail: { body: "상세 본문" } },
      attachments: [richAttachment()],
      status: "published",
    },
    grant: {
      source: "kstartup",
      source_id: "PBLN_TEST_2",
      title: "리치 공고",
      url: "https://example.com/announcement/2",
      agency_jurisdiction: "중소벤처기업부",
      agency_primary: "창업진흥원",
      category_l1: "사업화",
      apply_start: "2026-08-05T00:00:00.000Z",
      apply_end: "2026-09-05T00:00:00.000Z",
      apply_method: { online: "https://apply.example.com", visit: null },
      support_amount: { max: 50_000_000, unit: "KRW", per: "기업", label: "최대 5천만원" },
      benefits: [{ family: "funding", label: "사업화 자금", source: "structured" }],
      required_documents: [{ name: "사업계획서", required: true, source: "self" }],
      status: "open",
      f_regions: ["서울", "경기"],
      f_industries: ["J"],
      f_biz_age_max_months: 84,
      f_sizes: ["small"],
      f_founder_traits: [],
      f_required_certs: [],
      f_apply_methods: ["online"],
      f_authoring_mode: "unknown",
      overall_confidence: 0.85,
      model_ver: "model-1",
      prompt_ver: "prompt-1",
      parser_version: "parser-2",
    },
    criteria: [
      {
        dimension: "region",
        operator: "in",
        value: { regions: ["서울", "경기"] },
        kind: "required",
        confidence: 0.9,
        raw_text: "서울·경기 소재",
        parser_version: "parser-2",
      },
      {
        dimension: "biz_age",
        operator: "lte",
        value: { months: 84 },
        kind: "required",
        weight: 0.5,
        confidence: 0.8,
        source_field: "biz_enyy",
        parser_version: "parser-2",
      },
    ],
  };
}

/** 저장된 grants 행 — 실제 DB 행처럼 projection 밖 컬럼(id·servingState·updatedAt 등)을 전부 갖는다. */
function makeStoredGrantRow(overrides: Partial<StoredGrantRow> = {}): StoredGrantRow {
  return {
    id: GRANT_ID,
    source: "kstartup",
    sourceId: "PBLN_TEST_1",
    title: "테스트 공고",
    url: "https://example.com/announcement/1",
    agencyJurisdiction: null,
    agencyOperator: null,
    agencyPrimary: null,
    categoryL1: null,
    categoryL2: null,
    applyStart: new Date("2026-08-01T00:00:00.000Z"),
    applyEnd: new Date("2026-08-31T00:00:00.000Z"),
    applyMethod: null,
    supportAmount: null,
    benefits: null,
    requiredDocuments: null,
    status: "open",
    servingState: "visible",
    fRegions: ["서울"],
    fIndustries: [],
    fBizAgeMinMonths: null,
    fBizAgeMaxMonths: null,
    fSizes: [],
    fFounderTraits: [],
    fRequiredCerts: [],
    fApplyMethods: ["online"],
    fAuthoringMode: "unknown",
    embedding: null,
    overallConfidence: 0.5,
    modelVer: null,
    promptVer: null,
    parserVersion: "parser-1",
    updatedAt: new Date("2026-08-03T12:00:00.000Z"),
    ...overrides,
  };
}

function makeRichStoredGrantRow(overrides: Partial<StoredGrantRow> = {}): StoredGrantRow {
  return makeStoredGrantRow({
    id: RICH_GRANT_ID,
    sourceId: "PBLN_TEST_2",
    title: "리치 공고",
    url: "https://example.com/announcement/2",
    agencyJurisdiction: "중소벤처기업부",
    agencyPrimary: "창업진흥원",
    categoryL1: "사업화",
    applyStart: new Date("2026-08-05T00:00:00.000Z"),
    applyEnd: new Date("2026-09-05T00:00:00.000Z"),
    applyMethod: { online: "https://apply.example.com", visit: null },
    supportAmount: { max: 50_000_000, unit: "KRW", per: "기업", label: "최대 5천만원" },
    benefits: [{ family: "funding", label: "사업화 자금", source: "structured" }],
    requiredDocuments: [{ name: "사업계획서", required: true, source: "self" }],
    fRegions: ["서울", "경기"],
    fIndustries: ["J"],
    fBizAgeMaxMonths: 84,
    fSizes: ["small"],
    overallConfidence: 0.85,
    modelVer: "model-1",
    promptVer: "prompt-1",
    parserVersion: "parser-2",
    ...overrides,
  });
}

function makeStoredCriterionRow(overrides: Partial<StoredCriterionRow> = {}): StoredCriterionRow {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    grantId: GRANT_ID,
    dimension: "region",
    operator: "in",
    value: { regions: ["서울", "경기"] },
    kind: "required",
    weight: null,
    confidence: 0.9,
    sourceSpan: null,
    rawText: "서울·경기 소재 기업 (승격 큐레이션)",
    sourceField: null,
    stableKey: null,
    needsReview: false,
    parserVersion: "lab-promote-1",
    ...overrides,
  };
}

/** parserCriterion() 의 발행 결과를 그대로 반영한 stored 행 — same-raw 재발행(무변화) 픽스처용. */
function makeParserMirrorCriterionRow(overrides: Partial<StoredCriterionRow> = {}): StoredCriterionRow {
  return makeStoredCriterionRow({
    value: { regions: ["서울"] },
    confidence: 0.8,
    rawText: "서울 소재 기업",
    parserVersion: "parser-1",
    stableKey: null,
    ...overrides,
  });
}

function makePreviousRow(
  entry: NormalizedGrant<Record<string, unknown>>,
  grant: StoredGrantRow,
  attachments: Array<Record<string, unknown>> | null = null,
) {
  return {
    grant,
    grantId: grant.id,
    rawHash: hashGrantRawPayload(entry.raw.payload),
    attachments,
    parserVersion: grant.parserVersion,
    modelVer: grant.modelVer,
    promptVer: grant.promptVer,
  };
}

// ---------------------------------------------------------------------------
// ③ 보호 판별: 승격 상태(stable_key NOT NULL) ↔ 롤백 복원 상태(전부 NULL)
// ---------------------------------------------------------------------------

assert.equal(hasPromotionProtectedCriteria([]), false, "criteria 없음 → 비보호");
assert.equal(
  hasPromotionProtectedCriteria([{ stableKey: null }, { stableKey: null }]),
  false,
  "롤백 복원 상태(전부 NULL stable_key) → 보호 해제",
);
assert.equal(
  hasPromotionProtectedCriteria([{ stableKey: "region:in:abc123" }]),
  true,
  "승격 행(stable_key NOT NULL) 1개면 보호",
);
assert.equal(
  hasPromotionProtectedCriteria([{ stableKey: null }, { stableKey: "sk-1" }]),
  true,
  "혼재 시에도 보호(승격 행이 하나라도 있으면)",
);

// ---------------------------------------------------------------------------
// ② 비보호 grant 지문: P1-b 대칭 지문 동결 사본(baseline)과 바이트 단위 동일
// ---------------------------------------------------------------------------
// 아래 baseline* 함수들은 P1-b 기준 지문 구현의 동결 사본이며, 해시(grantRawHash.ts)와
// 첨부 projection(grantRevisionInvalidation.ts)까지 **동결 인라인**한다 — 라이브 모듈이
// 나중에 바뀌어도 이 핀은 P1-b 시점 지문을 그대로 재현해 회귀를 잡는다.
// (의도된 동작 변경: P1-b 에서 stored 측 grant 를 전체 행 spread 대신 매칭 projection 필드로
//  절단하도록 바꿨고, 이 baseline 사본도 그 기준으로 갱신됐다.)

function baselineStableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => baselineStableJsonStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${baselineStableJsonStringify(record[key])}`)
    .join(",")}}`;
}

function baselineHashGrantRawPayload(payload: unknown): string {
  return createHash("sha256").update(baselineStableJsonStringify(payload)).digest("hex");
}

function baselineStableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(baselineStableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${baselineStableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function baselineRecordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function baselineTextValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function baselineFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function baselineMatchingAttachmentRevisionProjection(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((item) => {
    const attachment = baselineRecordValue(item);
    const conversion = baselineRecordValue(attachment.conversion);
    return {
      filename: baselineTextValue(attachment.filename),
      sourceIdentity: baselineTextValue(attachment.source_uri) ?? baselineTextValue(attachment.url),
      archivePresent: Boolean(baselineTextValue(attachment.archive_url) || baselineTextValue(attachment.storage_key)),
      storageKey: baselineTextValue(attachment.storage_key),
      sha256: baselineTextValue(attachment.sha256),
      contentType: baselineTextValue(attachment.content_type),
      bytes: baselineFiniteNumber(attachment.bytes),
      conversion: {
        status: baselineTextValue(conversion.status),
        markdownPresent: Boolean(
          baselineTextValue(conversion.markdown_url) || baselineTextValue(conversion.markdown_storage_key),
        ),
        markdownStorageKey: baselineTextValue(conversion.markdown_storage_key),
        markdownSha256: baselineTextValue(conversion.markdown_sha256),
        markdownBytes: baselineFiniteNumber(conversion.markdown_bytes),
        converter: baselineTextValue(conversion.converter),
        error: baselineTextValue(conversion.error),
      },
    };
  }).sort((left, right) => baselineStableStringify(left).localeCompare(baselineStableStringify(right)));
}

function baselineRawAttachments(
  value: NormalizedGrant["raw"]["attachments"],
): Array<Record<string, unknown>> | null {
  if (!value || value.length === 0) return null;
  return value as Array<Record<string, unknown>>;
}

function baselineDateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function baselineNormalizedGrantProjection(grant: {
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

function baselineNormalizedCriteriaProjection(
  criteria: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return criteria
    .map((criterion) => ({ ...criterion }))
    .sort((left, right) => baselineHashGrantRawPayload(left).localeCompare(baselineHashGrantRawPayload(right)));
}

/** P1-b 의도된 동작 변경 반영: stored 측은 매칭 projection 필드로 절단한다(전체 행 spread 아님). */
function baselinePickStoredGrantProjectionFields(grant: StoredGrantRow) {
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
    overallConfidence: grant.overallConfidence,
  };
}

function baselineStoredMatchingProjection(
  grant: StoredGrantRow,
  criteria: StoredCriterionRow[],
): Record<string, unknown> {
  return {
    grant: baselineNormalizedGrantProjection(baselinePickStoredGrantProjectionFields(grant)),
    criteria: baselineNormalizedCriteriaProjection(criteria.map((criterion) => ({
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

function baselineIncomingMatchingProjection(
  entry: NormalizedGrant<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    grant: baselineNormalizedGrantProjection({
      title: entry.grant.title,
      url: entry.grant.url ?? null,
      agencyJurisdiction: entry.grant.agency_jurisdiction ?? null,
      agencyOperator: entry.grant.agency_operator ?? null,
      agencyPrimary: entry.grant.agency_primary ?? null,
      categoryL1: entry.grant.category_l1 ?? null,
      categoryL2: entry.grant.category_l2 ?? null,
      applyStart: baselineDateValue(entry.grant.apply_start),
      applyEnd: baselineDateValue(entry.grant.apply_end),
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
    }),
    criteria: baselineNormalizedCriteriaProjection(entry.criteria.map((criterion) => ({
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

function assertUnprotectedSnapshotsMatchBaseline(
  entry: NormalizedGrant<Record<string, unknown>>,
  storedGrant: StoredGrantRow,
  previousCriteria: StoredCriterionRow[],
  storedAttachments: Array<Record<string, unknown>> | null,
  label: string,
): void {
  const previous = makePreviousRow(entry, storedGrant, storedAttachments);
  const nextRawHash = hashGrantRawPayload(entry.raw.payload);
  const snapshots = computePublishRevisionSnapshots({
    previous,
    previousCriteria,
    entry,
    nextRawHash,
    promotionProtected: false,
  });
  const baselineStored = {
    rawHash: previous.rawHash,
    matchingProjectionHash: baselineHashGrantRawPayload(
      baselineStoredMatchingProjection(storedGrant, previousCriteria),
    ),
    attachments: baselineMatchingAttachmentRevisionProjection(previous.attachments),
    parserVersion: previous.parserVersion,
    modelVer: previous.modelVer,
    promptVer: previous.promptVer,
  };
  const baselineIncoming = {
    rawHash: nextRawHash,
    matchingProjectionHash: baselineHashGrantRawPayload(baselineIncomingMatchingProjection(entry)),
    attachments: baselineMatchingAttachmentRevisionProjection(baselineRawAttachments(entry.raw.attachments)),
    parserVersion: entry.grant.parser_version ?? null,
    modelVer: entry.grant.model_ver ?? null,
    promptVer: entry.grant.prompt_ver ?? null,
  };
  assert.deepEqual(snapshots.stored, baselineStored, `${label}: 비보호 stored 지문은 P1 이전과 바이트 동일`);
  assert.deepEqual(snapshots.incoming, baselineIncoming, `${label}: 비보호 incoming 지문은 P1 이전과 바이트 동일`);
  assert.equal(
    snapshots.stored?.matchingProjectionHash,
    baselineStored.matchingProjectionHash,
    `${label}: stored projection hash 바이트 동일`,
  );
  assert.equal(
    snapshots.incoming.matchingProjectionHash,
    baselineIncoming.matchingProjectionHash,
    `${label}: incoming projection hash 바이트 동일`,
  );
}

// 단순 픽스처(첨부 없음·jsonb null·criteria 1건)
assertUnprotectedSnapshotsMatchBaseline(
  makeEntry(),
  makeStoredGrantRow(),
  [makeStoredCriterionRow({ stableKey: null })],
  null,
  "단순 픽스처",
);

// 리치 픽스처(첨부 1개·jsonb 값·criteria 2건)
{
  const richEntry = makeRichEntry();
  assertUnprotectedSnapshotsMatchBaseline(
    richEntry,
    makeRichStoredGrantRow(),
    [
      makeStoredCriterionRow({ grantId: RICH_GRANT_ID, stableKey: null }),
      makeStoredCriterionRow({
        id: "44444444-4444-4444-8444-444444444444",
        grantId: RICH_GRANT_ID,
        dimension: "biz_age",
        operator: "lte",
        value: { months: 84 },
        weight: 0.5,
        confidence: 0.8,
        sourceField: "biz_enyy",
        stableKey: null,
        parserVersion: "parser-2",
      }),
    ],
    baselineRawAttachments(richEntry.raw.attachments),
    "리치 픽스처",
  );
}

// ---------------------------------------------------------------------------
// ②-b P1-b 대칭 효과(비보호 지문): same-raw 재발행 + DB 행 잡음만 → unchanged,
//     실변화(제목·rawHash)는 changed 유지
// ---------------------------------------------------------------------------

{
  const entry = makeEntry();
  // DB 행 잡음: 매칭 projection 밖 컬럼만 다르다(updatedAt·servingState·embedding).
  const noisyStored = makeStoredGrantRow({
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    servingState: "staged",
    embedding: [0.1, 0.2],
  });
  const previous = makePreviousRow(entry, noisyStored);
  const nextRawHash = hashGrantRawPayload(entry.raw.payload);
  const mirroredCriteria = [makeParserMirrorCriterionRow()];

  const snapshots = computePublishRevisionSnapshots({
    previous,
    previousCriteria: mirroredCriteria,
    entry,
    nextRawHash,
    promotionProtected: false,
  });
  assert.equal(
    snapshots.stored?.matchingProjectionHash,
    snapshots.incoming.matchingProjectionHash,
    "P1-b: 24필드·criteria 동일 시 stored·incoming projection hash 가 일치해야 한다(잡음 절단)",
  );
  assert.equal(
    classifyPublishedGrantRevision(snapshots.stored, snapshots.incoming),
    "unchanged",
    "P1-b: 비보호 same-raw 재발행 + DB 행 잡음만으로는 unchanged 여야 한다",
  );

  // 실변화는 그대로 changed: 제목 변경.
  const titleChanged = makeEntry({ title: "테스트 공고 (연장)" });
  const titleSnapshots = computePublishRevisionSnapshots({
    previous: makePreviousRow(titleChanged, noisyStored),
    previousCriteria: mirroredCriteria,
    entry: titleChanged,
    nextRawHash: hashGrantRawPayload(titleChanged.raw.payload),
    promotionProtected: false,
  });
  assert.equal(
    classifyPublishedGrantRevision(titleSnapshots.stored, titleSnapshots.incoming),
    "changed",
    "P1-b: 비보호 grant 의 24필드 실변화(제목)는 changed 를 유지해야 한다",
  );

  // 실변화는 그대로 changed: 원문(rawHash) 변경 — rawHash 는 스냅샷에 직접 포함된다.
  const rawChangedEntry = makeEntry();
  rawChangedEntry.raw.payload = { ...rawChangedEntry.raw.payload, body: "본문 수정" };
  const rawSnapshots = computePublishRevisionSnapshots({
    previous, // rawHash 는 원래 payload 기준
    previousCriteria: mirroredCriteria,
    entry: rawChangedEntry,
    nextRawHash: hashGrantRawPayload(rawChangedEntry.raw.payload),
    promotionProtected: false,
  });
  assert.equal(
    classifyPublishedGrantRevision(rawSnapshots.stored, rawSnapshots.incoming),
    "changed",
    "P1-b: 비보호 grant 의 원문(rawHash) 실변화는 changed 를 유지해야 한다",
  );
}

// ---------------------------------------------------------------------------
// ① 보호 grant 지문: criteria 차이만으로는 unchanged, 실변화(제목·원문·첨부)는 changed 유지
// ---------------------------------------------------------------------------

{
  const entry = makeEntry(); // 파서 criteria 는 승격 criteria 와 다르다(value 상이)
  const storedGrant = makeStoredGrantRow();
  const promotedCriteria = [makeStoredCriterionRow({ stableKey: "region:in:sk1" })];
  const previous = makePreviousRow(entry, storedGrant);
  const nextRawHash = hashGrantRawPayload(entry.raw.payload);

  const protectedSnapshots = computePublishRevisionSnapshots({
    previous,
    previousCriteria: promotedCriteria,
    entry,
    nextRawHash,
    promotionProtected: true,
  });
  assert.equal(
    protectedSnapshots.stored?.matchingProjectionHash,
    protectedSnapshots.incoming.matchingProjectionHash,
    "보호 grant: criteria 를 양측 대칭 제외하면 grant 필드 동일 시 projection hash 가 일치해야 한다",
  );
  assert.equal(
    classifyPublishedGrantRevision(protectedSnapshots.stored, protectedSnapshots.incoming),
    "unchanged",
    "보호 grant: 승격분≠파서분 criteria 차이만으로는 changed 가 되지 않아야 한다(영구 재분류 차단)",
  );

  // 동일 입력을 비보호로 계산하면 승격분≠파서분 criteria 차이로 changed — 가드 효과 대조.
  // (P1-b 이후 stored 잡음은 지문에 없으므로 changed 원인은 순수하게 criteria 차이다.)
  const unprotectedSnapshots = computePublishRevisionSnapshots({
    previous,
    previousCriteria: promotedCriteria,
    entry,
    nextRawHash,
    promotionProtected: false,
  });
  assert.equal(
    classifyPublishedGrantRevision(unprotectedSnapshots.stored, unprotectedSnapshots.incoming),
    "changed",
    "같은 입력이 비보호 계산에서는 changed (보호 지문의 효과 확인)",
  );

  // 실변화는 보호 중에도 changed 로 남아야 한다: 제목 변경.
  const titleChanged = makeEntry({ title: "테스트 공고 (연장)" });
  const titleSnapshots = computePublishRevisionSnapshots({
    previous: makePreviousRow(titleChanged, storedGrant),
    previousCriteria: promotedCriteria,
    entry: titleChanged,
    nextRawHash: hashGrantRawPayload(titleChanged.raw.payload),
    promotionProtected: true,
  });
  assert.equal(
    classifyPublishedGrantRevision(titleSnapshots.stored, titleSnapshots.incoming),
    "changed",
    "보호 grant 라도 본문·필드 실변화는 changed 신호를 유지해야 한다",
  );

  // 원문(rawHash) 변화도 보호 중 changed 유지.
  const rawChangedEntry = makeEntry();
  rawChangedEntry.raw.payload = { ...rawChangedEntry.raw.payload, body: "본문 수정" };
  const rawSnapshots = computePublishRevisionSnapshots({
    previous, // rawHash 는 원래 payload 기준
    previousCriteria: promotedCriteria,
    entry: rawChangedEntry,
    nextRawHash: hashGrantRawPayload(rawChangedEntry.raw.payload),
    promotionProtected: true,
  });
  assert.equal(
    classifyPublishedGrantRevision(rawSnapshots.stored, rawSnapshots.incoming),
    "changed",
    "보호 grant 라도 원문(rawHash) 변화는 changed 신호를 유지해야 한다",
  );
}

// 리치 픽스처 보호 지문: 승격 criteria 3건 ↔ 파서 criteria 2건 차이만으로는 unchanged,
// 첨부 변환 내용 실변화는 changed 유지.
{
  const entry = makeRichEntry();
  const storedGrant = makeRichStoredGrantRow();
  const storedAttachments = baselineRawAttachments(entry.raw.attachments);
  const promotedCriteria = [
    makeStoredCriterionRow({ grantId: RICH_GRANT_ID, stableKey: "region:in:r1", value: { regions: ["서울"] } }),
    makeStoredCriterionRow({
      id: "55555555-5555-4555-8555-555555555555",
      grantId: RICH_GRANT_ID,
      dimension: "biz_age",
      operator: "lte",
      value: { months: 60 },
      stableKey: "biz_age:lte:b1",
    }),
    makeStoredCriterionRow({
      id: "66666666-6666-4666-8666-666666666666",
      grantId: RICH_GRANT_ID,
      dimension: "sanction",
      operator: "exists",
      kind: "exclusion",
      value: {},
      stableKey: "sanction:exists:s1",
    }),
  ];
  const previous = makePreviousRow(entry, storedGrant, storedAttachments);
  const nextRawHash = hashGrantRawPayload(entry.raw.payload);

  const snapshots = computePublishRevisionSnapshots({
    previous,
    previousCriteria: promotedCriteria,
    entry,
    nextRawHash,
    promotionProtected: true,
  });
  assert.equal(
    classifyPublishedGrantRevision(snapshots.stored, snapshots.incoming),
    "unchanged",
    "리치 보호 grant: 승격 3건↔파서 2건 criteria 차이만으로는 unchanged (jsonb·첨부 대칭 포함)",
  );

  const baseAttachment = richAttachment();
  const changedAttachment = {
    ...baseAttachment,
    conversion: { ...baseAttachment.conversion!, markdown_sha256: "c".repeat(64) },
  };
  const attachmentSnapshots = computePublishRevisionSnapshots({
    previous: { ...previous, attachments: [changedAttachment as unknown as Record<string, unknown>] },
    previousCriteria: promotedCriteria,
    entry,
    nextRawHash,
    promotionProtected: true,
  });
  assert.equal(
    classifyPublishedGrantRevision(attachmentSnapshots.stored, attachmentSnapshots.incoming),
    "changed",
    "보호 grant 라도 첨부 변환 내용(markdown_sha256) 실변화는 changed 신호를 유지해야 한다",
  );
}

// ---------------------------------------------------------------------------
// ①·③ publishNormalizedGrants 통합(fake tx): 보호 → criteria 무접촉 / 롤백 복원 → 교체 재개
// ---------------------------------------------------------------------------

interface RecordedOp {
  op: "select" | "insert" | "delete" | "execute";
  table: unknown;
}

function createFakeDb(fixture: {
  previousRow: ReturnType<typeof makePreviousRow> | null;
  previousCriteria: StoredCriterionRow[];
}) {
  const ops: RecordedOp[] = [];
  const thenable = (result: unknown) => ({
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  });
  const selectResult = (table: unknown): unknown[] => {
    if (table === schema.dedupLinks) return [];
    if (table === schema.grants) return fixture.previousRow ? [fixture.previousRow] : [];
    if (table === schema.grantCriteria) return fixture.previousCriteria;
    throw new Error("unexpected select table in fake tx");
  };
  const tx = {
    select(_fields?: unknown) {
      let table: unknown;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        from(t: unknown) {
          table = t;
          ops.push({ op: "select", table: t });
          return chain;
        },
        leftJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(selectResult(table)).then(onFulfilled, onRejected),
      });
      return chain;
    },
    insert(table: unknown) {
      ops.push({ op: "insert", table });
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        values: () => chain,
        onConflictDoUpdate: () => chain,
        onConflictDoNothing: () => chain,
        returning: () => thenable(table === schema.grants ? [{ id: GRANT_ID }] : []),
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(undefined).then(onFulfilled, onRejected),
      });
      return chain;
    },
    delete(table: unknown) {
      ops.push({ op: "delete", table });
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        where: () => chain,
        returning: () => thenable([]),
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(undefined).then(onFulfilled, onRejected),
      });
      return chain;
    },
    execute() {
      ops.push({ op: "execute", table: null });
      return thenable([]);
    },
  };
  const db = {
    transaction: (fn: (transaction: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as CunoteDb;
  return { db, ops };
}

const countOps = (ops: RecordedOp[], op: RecordedOp["op"], table: unknown) =>
  ops.filter((item) => item.op === op && item.table === table).length;

// (A) 보호 grant: criteria 무접촉 + unchanged + 요약 카운트/로그
{
  const entry = makeEntry();
  const storedGrant = makeStoredGrantRow();
  const previousRow = makePreviousRow(entry, storedGrant);
  const { db, ops } = createFakeDb({
    previousRow,
    previousCriteria: [makeStoredCriterionRow({ stableKey: "region:in:sk1" })],
  });

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let result: Awaited<ReturnType<typeof publishNormalizedGrants>>;
  try {
    result = await publishNormalizedGrants(db, [entry], {
      source: "kstartup",
      collectedAt: COLLECTED_AT,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(
    countOps(ops, "delete", schema.grantCriteria),
    0,
    "보호 grant: grant_criteria delete 가 실행되면 안 된다",
  );
  assert.equal(
    countOps(ops, "insert", schema.grantCriteria),
    0,
    "보호 grant: grant_criteria insert(파서분 병존 삽입 포함)가 실행되면 안 된다",
  );
  assert.equal(countOps(ops, "insert", schema.grants), 1, "grant 코어 필드 upsert 는 유지된다");
  assert.equal(countOps(ops, "insert", schema.grantRaw), 1, "grant_raw upsert 는 유지된다");
  assert.equal(result.promotionProtectedCount, 1, "요약 카운트에 보호 발동 수가 실려야 한다");
  assert.deepEqual(result.promotionProtectedSourceIds, ["PBLN_TEST_1"]);
  assert.deepEqual(
    result.revisionCounts,
    { new: 0, unchanged: 1, changed: 0 },
    "보호 grant: 승격분≠파서분 criteria 차이만으로는 unchanged 여야 한다",
  );
  assert.equal(
    countOps(ops, "insert", schema.grantCollectionEvents),
    0,
    "unchanged 이므로 수집 이벤트도 없어야 한다",
  );
  assert.equal(countOps(ops, "delete", schema.matchState), 0, "unchanged 이므로 match_state 무효화 없음");
  assert.equal(warnings.length, 1, "보호 발동 시 요약 로그 1줄");
  assert.ok(
    warnings[0]?.includes("promotionProtected=1") && warnings[0]?.includes("PBLN_TEST_1"),
    `보호 요약 로그에 카운트·source_id 병기: ${warnings[0]}`,
  );
}

// (B) 롤백 복원 상태(전부 NULL stable_key): 보호 해제 → 기존 delete→insert 동작 재개
{
  const entry = makeEntry();
  const storedGrant = makeStoredGrantRow();
  const previousRow = makePreviousRow(entry, storedGrant);
  const { db, ops } = createFakeDb({
    previousRow,
    previousCriteria: [makeStoredCriterionRow({ stableKey: null })],
  });

  const result = await publishNormalizedGrants(db, [entry], {
    source: "kstartup",
    collectedAt: COLLECTED_AT,
  });

  assert.equal(countOps(ops, "delete", schema.grantCriteria), 1, "비보호 grant: criteria delete 재개");
  assert.equal(countOps(ops, "insert", schema.grantCriteria), 1, "비보호 grant: criteria insert 재개");
  assert.equal(result.promotionProtectedCount, 0);
  assert.deepEqual(result.promotionProtectedSourceIds, []);
  // 복원된 stored criteria(승격 큐레이션 내용) ≠ 파서 criteria 이므로 changed —
  // P1-b 이후 stored 잡음은 지문에 없고, changed 원인은 순수하게 criteria 차이다.
  assert.deepEqual(result.revisionCounts, { new: 0, unchanged: 0, changed: 1 });
}

// (D) P1-b 대칭 효과 통합: 비보호 same-raw 재발행 + DB 행 잡음만 → unchanged.
// criteria 교체(delete→insert)는 revisionKind 와 무관하게 기존대로 수행되고,
// match_state 무효화·수집 이벤트는 발생하지 않아야 한다.
{
  const entry = makeEntry();
  const noisyStored = makeStoredGrantRow({
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    servingState: "staged",
    embedding: [0.1, 0.2],
  });
  const previousRow = makePreviousRow(entry, noisyStored);
  const { db, ops } = createFakeDb({
    previousRow,
    previousCriteria: [makeParserMirrorCriterionRow()],
  });

  const result = await publishNormalizedGrants(db, [entry], {
    source: "kstartup",
    collectedAt: COLLECTED_AT,
  });

  assert.deepEqual(
    result.revisionCounts,
    { new: 0, unchanged: 1, changed: 0 },
    "P1-b: 비보호 same-raw 재발행에서 DB 행 잡음(updatedAt·servingState·embedding)만으로는 unchanged",
  );
  assert.equal(countOps(ops, "delete", schema.grantCriteria), 1, "unchanged 여도 criteria 교체는 기존대로 수행");
  assert.equal(countOps(ops, "insert", schema.grantCriteria), 1, "unchanged 여도 criteria 교체는 기존대로 수행");
  assert.equal(countOps(ops, "insert", schema.grantCollectionEvents), 0, "unchanged 이므로 수집 이벤트 없음");
  assert.equal(countOps(ops, "delete", schema.matchState), 0, "unchanged 이므로 match_state 무효화 없음");
  assert.equal(result.promotionProtectedCount, 0);
}

// (C) 보호 grant 라도 실변화(제목)는 changed + match_state 무효화 경로 유지, criteria 는 여전히 무접촉
{
  const entry = makeEntry({ title: "테스트 공고 (연장)" });
  const storedGrant = makeStoredGrantRow(); // 제목은 기존 그대로 → 실변화
  const previousRow = makePreviousRow(entry, storedGrant);
  const { db, ops } = createFakeDb({
    previousRow,
    previousCriteria: [makeStoredCriterionRow({ stableKey: "region:in:sk1" })],
  });

  const originalWarn = console.warn;
  console.warn = () => {};
  let result: Awaited<ReturnType<typeof publishNormalizedGrants>>;
  try {
    result = await publishNormalizedGrants(db, [entry], {
      source: "kstartup",
      collectedAt: COLLECTED_AT,
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(result.revisionCounts, { new: 0, unchanged: 0, changed: 1 });
  assert.equal(countOps(ops, "delete", schema.grantCriteria), 0, "실변화여도 criteria 는 무접촉");
  assert.equal(countOps(ops, "insert", schema.grantCriteria), 0, "실변화여도 파서 criteria 삽입 금지");
  assert.equal(countOps(ops, "delete", schema.matchState), 1, "실변화는 match_state 무효화를 유지");
  assert.equal(result.promotionProtectedCount, 1);
}

// ---------------------------------------------------------------------------
// ④ 수동 CLI 가드: selectPromotionProtectedGrantIds 쿼리 경로 + stderr 경고 경로
// ---------------------------------------------------------------------------

{
  let selectCalls = 0;
  const tables: unknown[] = [];
  const fakeDb = {
    select(_fields?: unknown) {
      selectCalls += 1;
      let table: unknown;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        from(t: unknown) {
          table = t;
          tables.push(t);
          return chain;
        },
        where: () => chain,
        groupBy: () => chain,
        then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve(table === schema.grantCriteria ? [{ grantId: "g-protected" }] : [])
            .then(onFulfilled, onRejected),
      });
      return chain;
    },
  } as unknown as CunoteDbSession;

  const found = await selectPromotionProtectedGrantIds(fakeDb, ["g-protected", "g-free"]);
  assert.deepEqual([...found], ["g-protected"], "stable_key 보유 grant id 만 반환");
  assert.equal(selectCalls, 1, "배치 판별은 쿼리 1회");
  assert.equal(tables[0], schema.grantCriteria, "grant_criteria 를 조회해야 한다");

  const empty = await selectPromotionProtectedGrantIds(fakeDb, []);
  assert.equal(empty.size, 0, "빈 입력은 빈 집합");
  assert.equal(selectCalls, 1, "빈 입력은 쿼리를 발행하지 않는다");
}

{
  const message = promotionProtectedSkipWarning("kstartup:PBLN_TEST_1 (grant g-1)");
  assert.ok(message.includes("kstartup:PBLN_TEST_1"), "경고에 공고 참조 포함");
  assert.ok(message.includes("승격 보호로 criteria 유지"), "경고에 보존 사유 포함");
  assert.ok(message.includes("재분석→재승격"), "경고에 올바른 갱신 경로 안내 포함");

  const written: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    warnPromotionProtectedSkip("kstartup:PBLN_TEST_1 (grant g-1)");
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(written.length, 1, "stderr 경고는 정확히 1줄");
  assert.equal(written[0], `${message}\n`);
}

console.log("normalizedGrantPublisher.promotion-protection.test.ts: all assertions passed");
