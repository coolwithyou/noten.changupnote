import { createHash } from "node:crypto";
import { maskCorpNum } from "@cunote/core";
import {
  activeUnknownQuestionDimensions,
  classifyEvidenceSourceKind,
  countByEligibility,
  defaultAxisCompleteness,
  buildCompanyProfileFromCodef,
  checkFscCorpFinance,
  checkFscPersonalFinance,
  checkKcomwelEmployment,
  checkKiprisApplicant,
  checkKiprisRights,
  checkStartupConfirmation,
  checkNiceCorpCredit,
  checkNiceCorpIndicator,
  DISQUALIFICATION_FLAGS,
  DISQUALIFICATION_EXCEPTION_LABELS,
  DISQUALIFICATION_EXCEPTIONS,
  DISQUALIFICATION_FLAG_LABELS,
  DISQUALIFICATION_QUESTIONS,
  EXCEPTION_FLAG_COVERAGE,
  grantKey,
  isProfileResolvableCriterion,
  matchRegistry,
  matchGrantCriteria,
  normalizeCompanyName,
  planProfileQuestions,
  PROCUREMENT_DEBARMENT_SOURCE,
  questionDefinitionFor,
  requireProfileFieldKey,
  resolveGrantExtractionManifest,
} from "@cunote/core";
import type {
  AutofillGrantWeights,
  AxisCompleteness,
  CorporateRegistrationFacts,
  DisqualificationAxis,
  DisqualificationFlag,
  EnrichmentCacheEntry,
  NtsBusinessStatusData,
  SmppCertificates,
  VatBaseFacts,
  EvidenceSourceKind,
  KiprisApplicantMatch,
  KiprisRightsSummary,
  ProfileFieldKey,
  StartupConfirmationLookup,
  DartFinancialSnapshot,
  CompanyProfileFieldUpdate,
  QuestionDefinitionId,
  RegistryMatch,
} from "@cunote/core";
import { sanitizeCorpNum } from "@cunote/core/popbill/check-biz-info";
import {
  CRITERION_DIMENSIONS,
  type CompanyEvidence,
  type CompanyProfile,
  type CriterionDimension,
  type Eligibility,
  type GrantCriterion,
  type MatchExtractionReadiness,
  type MatchRecommendationTier,
  type MatchReviewReason,
  type MatchResult,
  type NextQuestionDto,
  type NormalizedGrant,
} from "@cunote/contracts";
import {
  APICK_BIZ_DETAIL,
  APICK_BIZ_DETAIL_GUARD,
  loadApickBizDetailCompanyProfile,
} from "./apickBizDetail";
import { resolveDataGoKrServiceKey } from "./dataGoKrServiceKey";
import {
  resolveDartCompanyBridge,
  type DartCompanyBridgeLookup,
} from "./dartCompanyBridge";
import { resolveLatestDartOverlay } from "./dartOverlay";
import {
  applySmppCertificatesToProfile,
  getServiceRepositories,
  loadCompanyProfileFromSourceWithEvidence,
  loadServiceGrantUniverse,
  ntsClosedLabel,
  ServiceDataError,
} from "./serviceData";
import {
  buildBizAgeProfileUpdates,
  buildCertificationProfileUpdates,
  buildDisqualificationProfileUpdates,
  buildEmployeesProfileUpdates,
  buildFinancialHealthProfileUpdates,
  buildDevFinalCompanyProfile,
  buildFounderAgeProfileUpdates,
  buildFounderTraitProfileUpdates,
  buildIndustryProfileUpdates,
  buildInsuredWorkforceProfileUpdates,
  buildInvestmentProfileUpdates,
  buildIpProfileUpdates,
  buildRegionProfileUpdates,
  buildRevenueProfileUpdates,
  buildTargetTypeProfileUpdates,
  DEV_QNA_DIMENSIONS,
  type DevFinancialHealthValue,
  type DevInvestmentValue,
  type DevQnaDimension,
  type DevServiceDataNormalizationFailure,
  type DevServiceDataProfileMetadata,
  type DevServiceDataProfileNormalization,
  type DevFinalCompanyProfileResult,
} from "./devServiceDataProfile";
import { getRepositoryAdapterName } from "./repositories/factory";

// ─────────────────────────────────────────────────────────────────────────────
// 개발 전용 사업자 데이터 모니터. 실제 조회 파이프라인(팝빌·국세청·공공구매종합정보망)과 Apick을
// 항상 태워(저장 프로필 short-circuit 없이) 캐시/라이브 원천을 투명하게 드러낸다.
// production 에서는 노출 금지 — 모든 진입점은 assertDevOnly 가드를 통과해야 한다.
// ─────────────────────────────────────────────────────────────────────────────

/** production 환경이면 예외를 던진다(라우트/페이지에서 404·notFound 처리). */
export function assertDevOnly(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("dev-only endpoint");
  }
}

export type ServiceDataFieldSource = "popbill" | "apick" | "nts" | "smpp";
export type ServiceDataProvider = "popbill" | "apick";
export type ServiceDataTraceOrigin = "live" | "cache";

export interface ServiceDataRowSummary {
  provider: string;
  scope: string;
  checkedAt: string | null;
  fetchedAt: string;
  expiresAt: string | null;
  expired: boolean;
  resultCode: string | null;
  resultMessage: string | null;
}

export interface ServiceDataInspectResult {
  bizNo: string;
  maskedBizNo: string;
  provider: ServiceDataProvider | "all";
  hasCache: boolean;
  rows: ServiceDataRowSummary[];
}

export interface ServiceDataField {
  key: string;
  label: string;
  value: string | null;
  source: ServiceDataFieldSource | null;
  confidence: number | null;
  available: boolean;
  /** 원천이 값을 관측·확인한 기준시각. 알 수 없으면 null. */
  asOf: string | null;
}

export interface ServiceDataTraceEntry {
  provider: string;
  scope: string;
  origin: ServiceDataTraceOrigin;
  checkedAt: string | null;
  fetchedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  resultCode: string | null;
  resultMessage: string | null;
  rawPayload: Record<string, unknown> | null;
  canonicalPayload: Record<string, unknown> | null;
}

export interface ServiceDataLookupError {
  code: string;
  message: string;
  status: number;
}

// ── 22축 커버리지 하네스 (매칭 데이터 소싱 검증) ─────────────────────────────
// 소싱 설계 docs/plans/2026-07-11-matching-data-sourcing.md §4, 키 매니페스트
// docs/plans/2026-07-11-sourcing-keys-manifest.md 를 화면으로 옮긴 상태 모델.

/** 데이터 접근 물리학(소싱 설계 §2): A층=사업자번호 조회, B층=동의·증빙, reserved=예약축. */
export type FieldTier = "A" | "B" | "reserved";

/** 사업자 유형(법인/개인). n/a(법인 전용축) 판정에 쓴다. 사업자번호 중간자리로 추론. */
export type SubjectType = "corporation" | "individual" | "unknown";

/**
 * 필드 상태 모델(키 매니페스트): 키 누락→pending, 데이터 어긋남→failed.
 * self-declared 는 서버가 아니라 클라이언트 Q&A 오버레이가 부여한다(이 함수는 나머지 5개를 결정).
 */
export type FieldCoverageStatus = "self-declared" | "pending" | "live" | "cache" | "failed" | "n/a";

/** 커넥터 호출 결과의 의미. status와 분리해 정상 빈값·전제 미충족·API 오류를 구별한다. */
export type ConnectorOutcome = "value" | "empty" | "prerequisite" | "error";

/** 라이브/추론 원천 참조(배지용). */
export type FieldSourceRef =
  | ServiceDataFieldSource
  | "derived"
  | "kcomwel"
  | "kipris"
  | "kised"
  | "dart"
  | "fsc"
  | "nice"
  | "codef"
  | "registry";

/**
 * Phase 2 커넥터가 상태 판정 함수에 넘기는 결과. Phase 1 에선 항상 null 이라 외부소스는 pending 고정.
 * - empty → 정상 빈값(pending), ok=false | schemaMismatch → failed 로 전이.
 * - skipped=true → 조회 전제 미충족(법인번호 없음 등)이라 pending 유지(crash/failed 아님).
 * - ok=true → live. value/confidence/source 는 화면 표시에 사용된다.
 */
export interface ConnectorResult {
  ok: boolean;
  empty?: boolean;
  schemaMismatch?: boolean;
  /** 조회 전제 미충족 → pending 유지(failed 금지). */
  skipped?: boolean;
  /** 30일 캐시 등 외부 커넥터 자체 캐시 출처. 미지정이면 live. */
  origin?: ServiceDataTraceOrigin;
  reason?: string;
  value?: string | null;
  confidence?: number | null;
  /** 라이브일 때 배지에 표시할 원천. */
  source?: FieldSourceRef;
  /** 물리 provider와 분리한 증거 분류. 미지정이면 provider 정책으로 계산한다. */
  sourceKind?: EvidenceSourceKind;
  /** 해당 값의 기준시각. 조회처가 제공하지 않으면 null/미지정. */
  asOf?: string | null;
  /** present-only/fuzzy 등으로 부모축 전체를 판정할 수 없으면 partial. */
  axisCompleteness?: AxisCompleteness;
  /** 표시값과 함께 matcher 경계 검증을 통과한 canonical update. */
  profileUpdates?: CompanyProfileFieldUpdate[];
  /** provider/API 성공 의미를 바꾸지 않는 typed 변환 실패 진단. */
  normalizationFailure?: DevServiceDataNormalizationFailure;
  /** partial empty/no-update까지 포함한 typed normalizer 실행 영수증. */
  profileNormalization?: "normalized" | "failed";
  /** 라이브 행에 표시할 부가 표식(예: "NICE 데모앱(무계약)"). buildFieldCoverage 가 row.note 로 옮긴다. */
  note?: string | null;
}

export function attachConnectorProfileNormalization(
  result: ConnectorResult,
  normalization: DevServiceDataProfileNormalization,
): ConnectorResult {
  if (!normalization.ok) {
    return {
      ...result,
      normalizationFailure: normalization.failure,
      profileNormalization: "failed",
    };
  }
  if (normalization.profileUpdates.length === 0) {
    return { ...result, profileNormalization: "normalized" };
  }
  return {
    ...result,
    profileUpdates: normalization.profileUpdates,
    profileNormalization: "normalized",
  };
}

function profileMetadata(
  result: ConnectorResult,
  provider: string,
  fallbackCompleteness: "partial" | "complete",
): DevServiceDataProfileMetadata {
  return {
    sourceKind: result.sourceKind ?? "authoritative_api",
    provider,
    asOf: result.asOf ?? null,
    confidence: result.confidence ?? null,
    axisCompleteness:
      result.axisCompleteness === "partial" || result.axisCompleteness === "complete"
        ? result.axisCompleteness
        : fallbackCompleteness,
  };
}

function withRevenueProfileUpdate(
  result: ConnectorResult,
  revenueWon: unknown,
  provider: string,
): ConnectorResult {
  return attachConnectorProfileNormalization(
    result,
    buildRevenueProfileUpdates(revenueWon, profileMetadata(result, provider, "complete")),
  );
}

function withEmployeesProfileUpdate(
  result: ConnectorResult,
  employees: unknown,
  provider: string,
): ConnectorResult {
  return attachConnectorProfileNormalization(
    result,
    buildEmployeesProfileUpdates(employees, profileMetadata(result, provider, "complete")),
  );
}

function withFinancialHealthProfileUpdate(
  result: ConnectorResult,
  value: DevFinancialHealthValue,
  provider: string,
): ConnectorResult {
  return attachConnectorProfileNormalization(
    result,
    buildFinancialHealthProfileUpdates(value, profileMetadata(result, provider, "partial")),
  );
}

function withDisqualificationProfileUpdate(
  result: ConnectorResult,
  field: "tax_compliance" | "credit_status" | "sanction",
  value: unknown,
  provider: string,
): ConnectorResult {
  return attachConnectorProfileNormalization(
    result,
    buildDisqualificationProfileUpdates(field, value, profileMetadata(result, provider, "partial")),
  );
}

function withInvestmentProfileUpdate(
  result: ConnectorResult,
  value: DevInvestmentValue,
  provider: string,
): ConnectorResult {
  return attachConnectorProfileNormalization(
    result,
    buildInvestmentProfileUpdates(value, profileMetadata(result, provider, "partial")),
  );
}

function withCertificationProfileUpdates(
  result: ConnectorResult,
  certifications: readonly unknown[],
  provider: string,
): ConnectorResult {
  return attachConnectorProfileNormalization(
    result,
    buildCertificationProfileUpdates(certifications, profileMetadata(result, provider, "partial")),
  );
}

function withInsuredWorkforceProfileUpdates(
  result: ConnectorResult,
  value: Parameters<typeof buildInsuredWorkforceProfileUpdates>[0],
  provider: string,
): ConnectorResult {
  return attachConnectorProfileNormalization(
    result,
    buildInsuredWorkforceProfileUpdates(value, profileMetadata(result, provider, "partial")),
  );
}

export interface FieldCoverageRow {
  /** 행 식별자(축 키 또는 하위 플래그/서브필드 유사키). */
  key: string;
  /** 하위 플래그·서브필드 행이면 소속 축 dimension 키. */
  parentKey: string | null;
  /** 22축 dimension(하위 행은 부모 dimension 을 참조하되 flag/subField 로 구분). */
  dimension: CriterionDimension | null;
  /** 결격 하위 플래그(canonical). 없으면 null. */
  flag: DisqualificationFlag | null;
  /** 재무·고용·투자 하위 서브필드 키. 없으면 null. */
  subField: string | null;
  label: string;
  tier: FieldTier;
  /** 계획 소스 라벨(소싱 설계 §4). 라이브가 아니어도 항상 노출. */
  plannedSource: string;
  status: FieldCoverageStatus;
  /** 외부 조회 결과의 의미. 정상 빈값을 failed와 구분하는 표시·진단용 메타데이터. */
  connectorOutcome: ConnectorOutcome | null;
  value: string | null;
  confidence: number | null;
  /** 실제 원천. 정상 빈값·조회 실패도 호출한 원천을 알 수 있으면 보존한다. */
  source: FieldSourceRef | null;
  /** 공식 API/공개명단/인증입력/자가응답/파생값의 의미 분류. */
  sourceKind: EvidenceSourceKind | null;
  /** 값의 원천 기준시각. */
  asOf: string | null;
  /** 하위 플래그 일부가 부모축 전체 확정으로 과대 집계되지 않게 하는 완전성. */
  axisCompleteness: AxisCompleteness;
  /** pending 사유("키 없음"/"배치 파이프라인" 등)·failed 사유. */
  note: string | null;
  /** Q&A 로 채울 수 있는 축인지(클라이언트 오버레이 대상). */
  selfDeclarable: boolean;
}

// 자가신고 Q&A 스키마(canonical 파생). page.tsx(서버 컴포넌트)가 만들어 클라이언트에 props 로 넘긴다
// — 클라이언트 번들에 @cunote/core(서버 코드)를 끌어들이지 않기 위함.
export interface QnaFlagSchema {
  flag: DisqualificationFlag;
  label: string;
}
export interface QnaQuestionSchema {
  id: string;
  label: string;
  flags: QnaFlagSchema[];
}
export interface QnaAxisSchema {
  axis: DisqualificationAxis;
  label: string;
  questions: QnaQuestionSchema[];
}
export interface QnaExceptionSchema {
  key: string;
  label: string;
  /** 이 예외가 면제하는 canonical 플래그(EXCEPTION_FLAG_COVERAGE). 클라이언트가 축별 표시 필터에 쓴다. */
  flags: DisqualificationFlag[];
}
export interface QnaSchema {
  definitionIds: Record<DevQnaDimension, QuestionDefinitionId>;
  disqualification: QnaAxisSchema[];
  exceptions: QnaExceptionSchema[];
}

export interface ServiceDataLookupResult {
  bizNo: string;
  maskedBizNo: string;
  /** 사업자 유형 추론(법인 전용축 n/a 판정용). */
  subject: SubjectType;
  profile: CompanyProfile | null;
  evidence: CompanyEvidence | null;
  fields: ServiceDataField[];
  /** 22축 + 하위 플래그 커버리지(라이브/pending/n-a 상태). Q&A 는 클라이언트가 오버레이. */
  coverage: FieldCoverageRow[];
  /** G2B dev 경계: connector 표시 결과와 별도로 matcher 입력 가능한 typed update를 노출한다. */
  connectorProfileUpdates: CompanyProfileFieldUpdate[];
  connectorNormalizationFailures: DevServiceDataNormalizationFailure[];
  connectorProfileAudit: ConnectorProfileUpdateAudit;
  /** G3 dev-memory-only connector merge preview/proof. product_consumed stays pending. */
  profileMerge: DevFinalCompanyProfileResult;
  /** 현재 활성·검수 공고 criterion 빈도로 만든 19축 가중치. 불러오지 못하면 null. */
  coverageGrantWeights: AutofillGrantWeights | null;
  trace: ServiceDataTraceEntry[];
  error?: ServiceDataLookupError;
}

export interface ConnectorProfileUpdateAudit {
  valueProducingKeys: string[];
  typedDimensions: CriterionDimension[];
  sourcedDimensions: CriterionDimension[];
  normalizedDimensions: CriterionDimension[];
  missingTypedUpdateKeys: string[];
}

export type DevShadowMatchProductState =
  | "지원 가능성이 높음"
  | "정보 확인"
  | "원문 확인"
  | "지원 어려움";

export type DevShadowMatchGrantUnreadyReasonCode =
  | "extraction_not_reviewed"
  | "text_only_criterion_present"
  | "criterion_review_required"
  | "hard_criterion_evidence_missing"
  | "reserved_dimension"
  | "criterion_not_profile_resolvable"
  | "criterion_mapping_missing";

export interface DevShadowMatchGrantUnreadyReason {
  code: DevShadowMatchGrantUnreadyReasonCode;
  dimension?: CriterionDimension;
}

export interface DevShadowMatchCounts {
  engine: Record<Eligibility, number>;
  product: Record<DevShadowMatchProductState, number>;
}

export interface DevShadowMatchUnknownCauseSummary {
  profile_missing: {
    total: number;
    byDimension: Array<{ dimension: CriterionDimension; count: number }>;
  };
  grant_unready: {
    total: number;
    byDimension: Array<{ dimension: CriterionDimension; count: number }>;
  };
}

export interface DevShadowMatchDimensionDelta {
  dimension: CriterionDimension;
  before: { profile_missing: number; grant_unready: number };
  after: { profile_missing: number; grant_unready: number };
  profileMissingReduction: number;
  grantUnreadyReduction: number;
  /** Matching actually became less unknown for this profile dimension. */
  reduced: boolean;
  /** Every prior profile_missing occurrence for this dimension was resolved. */
  completed: boolean;
}

export interface DevShadowMatchGrantState {
  eligibility: Eligibility;
  recommendationTier: MatchRecommendationTier;
  extractionReadiness: MatchExtractionReadiness;
  productState: DevShadowMatchProductState;
  profileMissingDimensions: CriterionDimension[];
  grantUnreadyDimensions: CriterionDimension[];
  /** Concise extraction/criterion reasons that keep the product state fail-closed. */
  grantUnreadyReasons: DevShadowMatchGrantUnreadyReason[];
  /** Matcher review-gate diagnostics, including reviewed high-risk pass reasons. */
  reviewGateReasons: MatchReviewReason[];
}

export interface DevShadowMatchDetail {
  grantId: string;
  revision: string;
  before: DevShadowMatchGrantState;
  after: DevShadowMatchGrantState;
}

export interface DevServiceDataShadowMatchResult {
  schemaVersion: "dev-service-data-shadow-match-v1";
  asOf: string;
  universeSize: number;
  returnedCount: number;
  detailLimit: number;
  /** Stable hash of sorted grant ids plus matching-relevant review state; raw payload is never included. */
  universeRevisionSignature: string;
  counts: {
    before: DevShadowMatchCounts;
    after: DevShadowMatchCounts;
  };
  unknownCauses: {
    before: DevShadowMatchUnknownCauseSummary;
    after: DevShadowMatchUnknownCauseSummary;
  };
  unknownReductionByDimension: DevShadowMatchDimensionDelta[];
  nextQuestion: NextQuestionDto | null;
  details: DevShadowMatchDetail[];
}

export interface BuildDevServiceDataShadowMatchInput<TPayload = unknown> {
  baseProfile: CompanyProfile;
  finalProfile: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  /** Explicit replay time; never replaced with Date.now() inside the evaluator. */
  asOf: Date;
  detailLimit?: number;
}

export interface LoadDevServiceDataShadowMatchInput {
  baseProfile: CompanyProfile;
  finalProfile: CompanyProfile;
  /** Explicit replay time shared by universe loading, matching, ranking, and question planning. */
  asOf: Date;
  detailLimit?: number;
  scanLimit?: number;
}

export interface DevServiceDataShadowMatchDependencies {
  /** The only external port: confirmed-deduped active grants. No write dependency exists. */
  loadGrantUniverse?: (input: {
    asOf: Date;
    scanLimit?: number;
  }) => Promise<Array<NormalizedGrant<unknown>>>;
}

const DEFAULT_DEV_SHADOW_DETAIL_LIMIT = 50;
const MAX_DEV_SHADOW_DETAIL_LIMIT = 200;
const RESERVED_QUESTION_DIMENSIONS = new Set<CriterionDimension>([
  "premises",
  "export_performance",
  "other",
]);

interface EvaluatedShadowGrant<TPayload> {
  item: NormalizedGrant<TPayload>;
  grantId: string;
  revision: string;
  before: MatchResult;
  after: MatchResult;
  beforeState: DevShadowMatchGrantState;
  afterState: DevShadowMatchGrantState;
}

interface ShadowUnknownClassification {
  grantUnready: boolean;
  profileMissingDimensions: CriterionDimension[];
  grantUnreadyDimensions: CriterionDimension[];
  grantUnreadyReasons: DevShadowMatchGrantUnreadyReason[];
}

/**
 * Pure G4 evaluator. The deterministic matcher remains the sole eligibility authority;
 * this function only projects its result into safe product states and diagnostics.
 */
export function buildDevServiceDataShadowMatch<TPayload>(
  input: BuildDevServiceDataShadowMatchInput<TPayload>,
): DevServiceDataShadowMatchResult {
  if (Number.isNaN(input.asOf.getTime())) throw new Error("shadow match asOf가 유효하지 않습니다.");
  const detailLimit = devShadowDetailLimit(input.detailLimit);
  const asOf = input.asOf.toISOString();
  const grants = [...input.grants]
    .map((item) => ({
      item,
      grantId: grantKey(item.grant),
      manifest: resolveGrantExtractionManifest(item),
    }))
    .sort((left, right) =>
      stableStringCompare(left.grantId, right.grantId) ||
      stableStringCompare(left.manifest.revision, right.manifest.revision));
  const evaluated = grants.map<EvaluatedShadowGrant<TPayload>>(({ item, grantId, manifest }) => {
    const before = matchGrantCriteria(item.criteria, input.baseProfile, {
      asOf: input.asOf,
      extractionManifest: manifest,
    });
    const after = matchGrantCriteria(item.criteria, input.finalProfile, {
      asOf: input.asOf,
      extractionManifest: manifest,
    });
    const beforeClassification = classifyShadowUnknowns(item, before);
    const afterClassification = classifyShadowUnknowns(item, after);
    return {
      item,
      grantId,
      revision: manifest.revision,
      before,
      after,
      beforeState: shadowGrantState(before, beforeClassification),
      afterState: shadowGrantState(after, afterClassification),
    };
  });
  const beforeUnknowns = evaluated.map((entry) => entry.beforeState);
  const afterUnknowns = evaluated.map((entry) => entry.afterState);
  const beforeUnknownSummary = shadowUnknownCauseSummary(beforeUnknowns);
  const afterUnknownSummary = shadowUnknownCauseSummary(afterUnknowns);
  const plannedAfter = planProfileQuestions(
    evaluated
      .filter((entry) => entry.after.quality.extractionReadiness === "reviewed")
      .map((entry) => ({ item: entry.item, match: entry.after })),
    {
      asOf: input.asOf,
      limit: 1,
      excludeDimensions: uniqueDimensions([
        ...activeUnknownQuestionDimensions(input.finalProfile, input.asOf),
        ...RESERVED_QUESTION_DIMENSIONS,
      ]),
    },
  )[0]?.question ?? null;
  const details = evaluated.slice(0, detailLimit).map<DevShadowMatchDetail>((entry) => ({
    grantId: entry.grantId,
    revision: entry.revision,
    before: entry.beforeState,
    after: entry.afterState,
  }));

  return {
    schemaVersion: "dev-service-data-shadow-match-v1",
    asOf,
    universeSize: evaluated.length,
    returnedCount: details.length,
    detailLimit,
    universeRevisionSignature: createHash("sha256")
      .update(JSON.stringify(grants.map(({ item, grantId, manifest }) => [
        grantId,
        manifest.revision,
        manifest.readiness,
        manifest.reviewedAt ?? null,
        manifest.extractorVersion,
        [...manifest.warnings].sort(stableStringCompare),
        matchingCriteriaSignature(item.criteria),
      ])))
      .digest("hex"),
    counts: {
      before: shadowMatchCounts(evaluated.map((entry) => entry.before), beforeUnknowns),
      after: shadowMatchCounts(evaluated.map((entry) => entry.after), afterUnknowns),
    },
    unknownCauses: {
      before: beforeUnknownSummary,
      after: afterUnknownSummary,
    },
    unknownReductionByDimension: CRITERION_DIMENSIONS.map((dimension) => {
      const beforeProfileMissing = dimensionCauseCount(beforeUnknownSummary.profile_missing.byDimension, dimension);
      const afterProfileMissing = dimensionCauseCount(afterUnknownSummary.profile_missing.byDimension, dimension);
      const beforeGrantUnready = dimensionCauseCount(beforeUnknownSummary.grant_unready.byDimension, dimension);
      const afterGrantUnready = dimensionCauseCount(afterUnknownSummary.grant_unready.byDimension, dimension);
      return {
        dimension,
        before: {
          profile_missing: beforeProfileMissing,
          grant_unready: beforeGrantUnready,
        },
        after: {
          profile_missing: afterProfileMissing,
          grant_unready: afterGrantUnready,
        },
        profileMissingReduction: beforeProfileMissing - afterProfileMissing,
        grantUnreadyReduction: beforeGrantUnready - afterGrantUnready,
        reduced: beforeProfileMissing > afterProfileMissing,
        completed: beforeProfileMissing > 0 && afterProfileMissing === 0,
      };
    }),
    nextQuestion: plannedAfter,
    details,
  };
}

/** Load the full active universe through the existing fail-closed scan helper, then evaluate read-only. */
export async function loadDevServiceDataShadowMatch(
  input: LoadDevServiceDataShadowMatchInput,
  dependencies: DevServiceDataShadowMatchDependencies = {},
): Promise<DevServiceDataShadowMatchResult> {
  const injectedLoadGrantUniverse = dependencies.loadGrantUniverse;
  if (!injectedLoadGrantUniverse && getRepositoryAdapterName() !== "drizzle") {
    throw new ServiceDataError(
      "shadow_match_universe_unavailable",
      "shadow match 전수 활성 공고는 drizzle 저장소에서만 불러올 수 있습니다.",
      503,
    );
  }
  const loadGrantUniverse = injectedLoadGrantUniverse ?? loadServiceGrantUniverse;
  const grants = await loadGrantUniverse({
    asOf: input.asOf,
    ...(input.scanLimit !== undefined ? { scanLimit: input.scanLimit } : {}),
  });
  return buildDevServiceDataShadowMatch({
    baseProfile: input.baseProfile,
    finalProfile: input.finalProfile,
    grants,
    asOf: input.asOf,
    ...(input.detailLimit !== undefined ? { detailLimit: input.detailLimit } : {}),
  });
}

function classifyShadowUnknowns<TPayload>(
  item: NormalizedGrant<TPayload>,
  match: MatchResult,
): ShadowUnknownClassification {
  const hardUnknowns = match.rule_trace
    .map((trace, index) => ({ trace, criterion: item.criteria[index] }))
    .filter(({ trace }) =>
      trace.result === "unknown" && (trace.kind === "required" || trace.kind === "exclusion"));
  const readinessUnready = match.quality.extractionReadiness !== "reviewed";
  const grantUnreadyDimensions = uniqueDimensions(hardUnknowns
    .filter(({ criterion }) =>
      readinessUnready || !criterion || !isProfileResolvableCriterion(criterion))
    .map(({ trace }) => trace.dimension));
  const profileMissingDimensions = uniqueDimensions(hardUnknowns
    .filter(({ criterion }) =>
      !readinessUnready && criterion !== undefined && isProfileResolvableCriterion(criterion))
    .map(({ trace }) => trace.dimension));
  const grantUnreadyReasons = shadowGrantUnreadyReasons(
    item.criteria,
    match.quality.extractionReadiness,
    hardUnknowns,
  );
  return {
    grantUnready: grantUnreadyReasons.length > 0 || grantUnreadyDimensions.length > 0,
    profileMissingDimensions,
    grantUnreadyDimensions,
    grantUnreadyReasons,
  };
}

function shadowGrantUnreadyReasons(
  criteria: GrantCriterion[],
  readiness: MatchExtractionReadiness,
  hardUnknowns: Array<{
    trace: MatchResult["rule_trace"][number];
    criterion: GrantCriterion | undefined;
  }>,
): DevShadowMatchGrantUnreadyReason[] {
  const reasons: DevShadowMatchGrantUnreadyReason[] = [];
  if (readiness !== "reviewed") reasons.push({ code: "extraction_not_reviewed" });
  for (const criterion of criteria) {
    if (criterion.kind !== "required" && criterion.kind !== "exclusion") continue;
    if (RESERVED_QUESTION_DIMENSIONS.has(criterion.dimension)) {
      reasons.push({ code: "reserved_dimension", dimension: criterion.dimension });
    }
    if (criterion.operator === "text_only") {
      reasons.push({ code: "text_only_criterion_present", dimension: criterion.dimension });
    }
    if (criterion.needs_review === true) {
      reasons.push({ code: "criterion_review_required", dimension: criterion.dimension });
    }
    if (!criterion.source_span?.trim() && !criterion.source_field?.trim()) {
      reasons.push({ code: "hard_criterion_evidence_missing", dimension: criterion.dimension });
    }
  }
  for (const { trace, criterion } of hardUnknowns) {
    if (!criterion) {
      reasons.push({ code: "criterion_mapping_missing", dimension: trace.dimension });
      continue;
    }
    if (!isProfileResolvableCriterion(criterion) && !hasSpecificGrantUnreadyReason(criterion)) {
      reasons.push({ code: "criterion_not_profile_resolvable", dimension: trace.dimension });
    }
  }
  const uniqueReasons = new Map<string, DevShadowMatchGrantUnreadyReason>();
  for (const reason of reasons) {
    uniqueReasons.set(`${reason.code}:${reason.dimension ?? ""}`, reason);
  }
  return [...uniqueReasons.values()].sort((left, right) =>
    stableStringCompare(left.code, right.code) ||
    stableStringCompare(left.dimension ?? "", right.dimension ?? ""));
}

function shadowGrantState(
  match: MatchResult,
  classification: ShadowUnknownClassification,
): DevShadowMatchGrantState {
  const recommendationTier = match.review_gate?.tier ?? fallbackShadowRecommendationTier(match);
  return {
    eligibility: match.eligibility,
    recommendationTier,
    extractionReadiness: match.quality.extractionReadiness,
    productState: shadowProductState(match, recommendationTier, classification.grantUnready),
    profileMissingDimensions: classification.profileMissingDimensions,
    grantUnreadyDimensions: classification.grantUnreadyDimensions,
    grantUnreadyReasons: classification.grantUnreadyReasons,
    reviewGateReasons: match.review_gate?.reasons.map((reason) => ({ ...reason })) ?? [],
  };
}

function shadowProductState(
  match: MatchResult,
  tier: MatchRecommendationTier,
  grantUnready: boolean,
): DevShadowMatchProductState {
  if (match.quality.extractionReadiness !== "reviewed") return "원문 확인";
  if (match.eligibility === "ineligible" || tier === "not_recommended") return "지원 어려움";
  if (grantUnready || tier === "needs_core_review") return "원문 확인";
  if (
    match.eligibility === "eligible" &&
    tier === "recommendable" &&
    match.quality.extractionReadiness === "reviewed"
  ) return "지원 가능성이 높음";
  if (match.eligibility === "conditional" || tier === "needs_profile_input") return "정보 확인";
  return "원문 확인";
}

function fallbackShadowRecommendationTier(match: MatchResult): MatchRecommendationTier {
  if (match.eligibility === "eligible") return "recommendable";
  if (match.eligibility === "ineligible") return "not_recommended";
  return "needs_profile_input";
}

function shadowMatchCounts(
  matches: MatchResult[],
  states: DevShadowMatchGrantState[],
): DevShadowMatchCounts {
  const product: Record<DevShadowMatchProductState, number> = {
    "지원 가능성이 높음": 0,
    "정보 확인": 0,
    "원문 확인": 0,
    "지원 어려움": 0,
  };
  for (const state of states) product[state.productState] += 1;
  return { engine: countByEligibility(matches), product };
}

function shadowUnknownCauseSummary(
  states: DevShadowMatchGrantState[],
): DevShadowMatchUnknownCauseSummary {
  const profileMissing = dimensionHistogram(states.flatMap((state) => state.profileMissingDimensions));
  const grantUnready = dimensionHistogram(states.flatMap((state) => state.grantUnreadyDimensions));
  return {
    profile_missing: {
      total: profileMissing.reduce((sum, entry) => sum + entry.count, 0),
      byDimension: profileMissing,
    },
    grant_unready: {
      total: grantUnready.reduce((sum, entry) => sum + entry.count, 0),
      byDimension: grantUnready,
    },
  };
}

function dimensionHistogram(dimensions: CriterionDimension[]): Array<{
  dimension: CriterionDimension;
  count: number;
}> {
  const counts = new Map<CriterionDimension, number>();
  for (const dimension of dimensions) counts.set(dimension, (counts.get(dimension) ?? 0) + 1);
  return CRITERION_DIMENSIONS.flatMap((dimension) => {
    const count = counts.get(dimension) ?? 0;
    return count > 0 ? [{ dimension, count }] : [];
  });
}

function dimensionCauseCount(
  values: Array<{ dimension: CriterionDimension; count: number }>,
  dimension: CriterionDimension,
): number {
  return values.find((entry) => entry.dimension === dimension)?.count ?? 0;
}

function uniqueDimensions(values: Iterable<CriterionDimension>): CriterionDimension[] {
  const included = new Set(values);
  return CRITERION_DIMENSIONS.filter((dimension) => included.has(dimension));
}

function stableStringCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasSpecificGrantUnreadyReason(criterion: GrantCriterion): boolean {
  return RESERVED_QUESTION_DIMENSIONS.has(criterion.dimension) ||
    criterion.operator === "text_only" ||
    criterion.needs_review === true ||
    (!criterion.source_span?.trim() && !criterion.source_field?.trim());
}

function matchingCriteriaSignature(criteria: GrantCriterion[]): string {
  return createHash("sha256")
    .update(JSON.stringify(stableJsonValue(criteria)))
    .digest("hex");
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => stableStringCompare(left, right))
      .map(([key, entry]) => [key, stableJsonValue(entry)]),
  );
}

function devShadowDetailLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_DEV_SHADOW_DETAIL_LIMIT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > MAX_DEV_SHADOW_DETAIL_LIMIT) {
    throw new Error(`shadow detailLimit은 1..${MAX_DEV_SHADOW_DETAIL_LIMIT} 정수여야 합니다.`);
  }
  return resolved;
}

// 필드 키 → confidence 축 매핑(신뢰도 표시용). corp_name 은 축이 없어 null.
const FIELD_DIMENSION: Record<string, CriterionDimension | null> = {
  corp_name: null,
  region: "region",
  biz_age: "biz_age",
  size: "size",
  industry: "industry",
  business_status: "business_status",
  founder_age: "founder_age",
  certification: "certification",
  employees: "employees",
  revenue: "revenue",
};

const POPBILL = { provider: "popbill", scope: "checkBizInfo" } as const;
const NTS = { provider: "nts", scope: "status" } as const;
const SMPP = { provider: "smpp", scope: "certs" } as const;

// dev 화면에서 동일 조회가 동시에 들어오면 전체 파이프라인을 하나로 합친다.
// 팝빌 자체 중복 과금뿐 아니라 NTS/SMPP/외부 커넥터와 DB 조회의 중복도 막는다.
const inflightServiceDataLookups = new Map<string, Promise<ServiceDataLookupResult>>();

function maskBizNoSafe(bizNo: string): string {
  try {
    return maskCorpNum(bizNo);
  } catch {
    return "**********";
  }
}

function isExpired(entry: Pick<EnrichmentCacheEntry, "expiresAt">, now: Date): boolean {
  return Boolean(entry.expiresAt && entry.expiresAt.getTime() <= now.getTime());
}

function toRowSummary(entry: EnrichmentCacheEntry, now: Date): ServiceDataRowSummary {
  return {
    provider: entry.provider,
    scope: entry.scope,
    checkedAt: entry.checkedAt?.toISOString() ?? null,
    fetchedAt: entry.fetchedAt.toISOString(),
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    expired: isExpired(entry, now),
    resultCode: entry.providerResultCode ?? null,
    resultMessage: entry.providerResultMessage ?? null,
  };
}

/** 만료 여부와 무관하게 사업자번호에 걸린 전체 캐시 행을 요약해 반환한다. */
export async function inspectServiceData(
  bizNo: string,
  provider?: ServiceDataProvider,
): Promise<ServiceDataInspectResult> {
  const normalized = sanitizeCorpNum(bizNo);
  const cache = getServiceRepositories().enrichmentCache;
  const rows = visibleCacheRows(await cache.listByBizNo(normalized), provider);
  const now = new Date();
  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    provider: provider ?? "all",
    hasCache: rows.length > 0,
    rows: rows.map((row) => toRowSummary(row, now)),
  };
}

/** 사업자번호(옵션: provider)로 캐시를 비우고 삭제 행 수를 반환한다. */
export async function clearServiceDataCache(
  bizNo: string,
  provider?: ServiceDataProvider,
): Promise<{ deleted: number }> {
  const normalized = sanitizeCorpNum(bizNo);
  const cache = getServiceRepositories().enrichmentCache;
  const rows = visibleCacheRows(await cache.listByBizNo(normalized), provider);
  let deleted = 0;
  for (const row of rows) {
    deleted += await cache.deleteByBizNo({
      bizNo: normalized,
      provider: row.provider,
      scope: row.scope,
    });
  }
  return { deleted };
}

function snapshotKey(provider: string, scope: string): string {
  return `${provider}:${scope}`;
}

function parsePopbillProfile(payload: Record<string, unknown> | null | undefined): CompanyProfile | null {
  if (!payload) return null;
  const profile = (payload as { profile?: unknown }).profile;
  return profile && typeof profile === "object" ? (profile as CompanyProfile) : null;
}

/**
 * 조회 파이프라인을 항상 실행(저장 프로필 우회 없음)하고, 캐시/라이브 원천을 재구성해 돌려준다.
 * - forceRefresh: 사업자번호에 걸린 캐시를 먼저 전부 비우고 조회 → 전 provider 라이브 재호출.
 * - before/after fetchedAt 스냅샷 비교로 provider 별 live/cache 판정.
 */
export function lookupServiceData(
  bizNo: string,
  options: { forceRefresh?: boolean; provider?: ServiceDataProvider } = {},
): Promise<ServiceDataLookupResult> {
  const normalized = sanitizeCorpNum(bizNo);
  const provider = options.provider ?? "popbill";
  const requestKey = `${provider}:${normalized}:${options.forceRefresh ? "refresh" : "cache"}`;
  return coalesceServiceDataLookup(requestKey, () => lookupServiceDataOnce(normalized, options));
}

/** 동일 key의 비동기 조회를 하나로 합치고 완료 후 포인터를 정리한다. */
export function coalesceServiceDataLookup(
  requestKey: string,
  run: () => Promise<ServiceDataLookupResult>,
): Promise<ServiceDataLookupResult> {
  const existing = inflightServiceDataLookups.get(requestKey);
  if (existing) return existing;

  const task = run().finally(() => {
    if (inflightServiceDataLookups.get(requestKey) === task) {
      inflightServiceDataLookups.delete(requestKey);
    }
  });
  inflightServiceDataLookups.set(requestKey, task);
  return task;
}

async function lookupServiceDataOnce(
  bizNo: string,
  options: { forceRefresh?: boolean; provider?: ServiceDataProvider } = {},
): Promise<ServiceDataLookupResult> {
  const normalized = sanitizeCorpNum(bizNo);
  if (options.provider === "apick") {
    return lookupApickServiceData(normalized, options);
  }

  const cache = getServiceRepositories().enrichmentCache;

  if (options.forceRefresh) {
    await clearServiceDataCache(normalized, "popbill");
  }

  // before 스냅샷: provider:scope → fetchedAt(ms). 이번 요청에서 재호출됐는지 판정 기준.
  const beforeRows = visibleCacheRows(await cache.listByBizNo(normalized), "popbill");
  const beforeFetched = new Map<string, number>();
  for (const row of beforeRows) {
    beforeFetched.set(snapshotKey(row.provider, row.scope), row.fetchedAt.getTime());
  }

  let profile: CompanyProfile | null = null;
  let evidence: CompanyEvidence | null = null;
  let error: ServiceDataLookupError | undefined;
  try {
    const resolution = await loadCompanyProfileFromSourceWithEvidence(normalized);
    profile = resolution.profile;
    evidence = resolution.evidence;
  } catch (caught) {
    // 폐업·미등록·캐시 불가 등 의미 있는 오류는 트레이스는 보여주되 흐름은 계속한다.
    if (caught instanceof ServiceDataError) {
      error = { code: caught.code, message: caught.message, status: caught.status };
    } else {
      throw caught;
    }
  }

  // after 스냅샷: 파이프라인이 채운(또는 재사용한) 캐시 행 전체.
  const afterRows = visibleCacheRows(await cache.listByBizNo(normalized), "popbill");
  const now = new Date();
  const rowByKey = new Map<string, EnrichmentCacheEntry>();
  for (const row of afterRows) {
    rowByKey.set(snapshotKey(row.provider, row.scope), row);
  }

  const trace: ServiceDataTraceEntry[] = afterRows.map((row) => {
    const key = snapshotKey(row.provider, row.scope);
    const before = beforeFetched.get(key);
    // before 에 없거나 fetchedAt 이 바뀌었으면 이번 요청에서 원소스를 실호출한 것(live).
    const origin: ServiceDataTraceOrigin =
      before === undefined || before !== row.fetchedAt.getTime() ? "live" : "cache";
    return {
      provider: row.provider,
      scope: row.scope,
      origin,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: isExpired(row, now),
      resultCode: row.providerResultCode ?? null,
      resultMessage: row.providerResultMessage ?? null,
      rawPayload: row.rawPayload ?? null,
      canonicalPayload: row.canonicalPayload ?? null,
    };
  });

  // 필드 원천 재구성(순수 함수 재적용). 팝빌 profile 을 base 로, NTS 휴·폐업이면 영업상태 원천=nts,
  // SMPP 확인서가 실제로 프로필을 바꿨으면(addedLabels) 인증/특성 원천=smpp.
  const popbillRow = rowByKey.get(snapshotKey(POPBILL.provider, POPBILL.scope));
  const popbillProfile = parsePopbillProfile(popbillRow?.canonicalPayload);
  const hasPopbill = Boolean(popbillRow);

  const ntsRow = rowByKey.get(snapshotKey(NTS.provider, NTS.scope));
  const ntsStatus = (ntsRow?.canonicalPayload ?? null) as NtsBusinessStatusData | null;
  const ntsClosed = ntsStatus ? ntsClosedLabel(ntsStatus.b_stt_cd) : null;

  const smppRow = rowByKey.get(snapshotKey(SMPP.provider, SMPP.scope));
  const smppCerts = (smppRow?.canonicalPayload ?? null) as SmppCertificates | null;
  const smppAddedLabels =
    popbillProfile && smppCerts
      ? applySmppCertificatesToProfile(popbillProfile, smppCerts).addedLabels
      : [];
  const smppChanged = smppAddedLabels.length > 0;

  const fieldSource = (key: string, available: boolean): ServiceDataFieldSource | null => {
    if (!available) return null;
    if (key === "business_status") {
      if (ntsStatus) return "nts";
      return hasPopbill ? "popbill" : null;
    }
    if (key === "certification") {
      return smppChanged ? "smpp" : hasPopbill ? "popbill" : null;
    }
    // 나머지 축(상호·소재지·업력·기업규모·업종 등)은 팝빌이 base.
    return hasPopbill ? "popbill" : null;
  };

  const confidenceFor = (key: string): number | null => {
    const dimension = FIELD_DIMENSION[key];
    if (!dimension || !profile?.confidence) return null;
    const value = profile.confidence[dimension];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  // evidence.fields 는 파이프라인이 최종 프로필로 계산한 10개 축(키/라벨/값/available)이라 그대로 재사용한다.
  const asOfBySource = asOfBySourceFromTrace(trace);
  const fields: ServiceDataField[] = (evidence?.fields ?? []).map((field) => {
    const ntsBusinessStatus =
      field.key === "business_status" && ntsStatus
        ? ntsClosed ?? ntsStatus.b_stt?.trim() ?? field.value
        : null;
    const available = field.available || Boolean(ntsBusinessStatus);
    const source = fieldSource(field.key, available);
    return {
      key: field.key,
      label: field.label,
      value: ntsBusinessStatus ?? field.value,
      available,
      source,
      confidence: confidenceFor(field.key),
      asOf: source ? asOfBySource.get(source) ?? null : null,
    };
  });

  const subject = resolveSubjectType(normalized);
  const [connectorResults, coverageGrantWeights] = await Promise.all([
    runExternalConnectors({ bizNo: normalized, subject, profile }),
    loadCoverageGrantWeights(),
  ]);
  const coverage = buildFieldCoverage({
    subject,
    profile,
    fields,
    originBySource: originBySourceFromTrace(trace),
    asOfBySource,
    connectorResults,
  });
  const connectorProfile = collectConnectorProfileUpdates(connectorResults);
  const profileMerge = buildDevFinalCompanyProfile({
    baseProfile: profile ?? { confidence: {} },
    connectorProfileUpdates: connectorProfile.profileUpdates,
    connectorSourcedDimensions: connectorProfile.audit.sourcedDimensions,
    connectorNormalizedDimensions: connectorProfile.audit.normalizedDimensions,
    connectorNormalizationFailures: connectorProfile.normalizationFailures,
  });

  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    subject,
    profile,
    evidence,
    fields,
    coverage,
    connectorProfileUpdates: connectorProfile.profileUpdates,
    connectorNormalizationFailures: connectorProfile.normalizationFailures,
    connectorProfileAudit: connectorProfile.audit,
    profileMerge,
    coverageGrantWeights,
    trace,
    ...(error ? { error } : {}),
  };
}

async function lookupApickServiceData(
  bizNo: string,
  options: { forceRefresh?: boolean } = {},
): Promise<ServiceDataLookupResult> {
  const normalized = sanitizeCorpNum(bizNo);
  const cache = getServiceRepositories().enrichmentCache;

  const beforeRows = visibleCacheRows(await cache.listByBizNo(normalized), "apick");
  const beforeFetched = new Map<string, number>();
  for (const row of beforeRows) {
    beforeFetched.set(snapshotKey(row.provider, row.scope), row.fetchedAt.getTime());
  }

  let profile: CompanyProfile | null = null;
  let evidence: CompanyEvidence | null = null;
  let error: ServiceDataLookupError | undefined;
  try {
    const resolution = await loadApickBizDetailCompanyProfile({
      bizNo: normalized,
      cache,
      ...(options.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {}),
    });
    profile = resolution.profile;
    evidence = resolution.evidence;
  } catch (caught) {
    if (caught instanceof ServiceDataError) {
      error = { code: caught.code, message: caught.message, status: caught.status };
    } else {
      throw caught;
    }
  }

  const afterRows = visibleCacheRows(await cache.listByBizNo(normalized), "apick");
  const trace = buildTrace(afterRows, beforeFetched);
  const asOfBySource = asOfBySourceFromTrace(trace);
  const fields: ServiceDataField[] = (evidence?.fields ?? []).map((field) => ({
    key: field.key,
    label: field.label,
    value: field.value,
    available: field.available,
    source: field.available ? "apick" : null,
    confidence: confidenceForProfileField(profile, field.key),
    asOf: field.available ? asOfBySource.get("apick") ?? null : null,
  }));

  const subject = resolveSubjectType(normalized);
  const [connectorResults, coverageGrantWeights] = await Promise.all([
    runExternalConnectors({ bizNo: normalized, subject, profile }),
    loadCoverageGrantWeights(),
  ]);
  const coverage = buildFieldCoverage({
    subject,
    profile,
    fields,
    originBySource: originBySourceFromTrace(trace),
    asOfBySource,
    connectorResults,
  });
  const connectorProfile = collectConnectorProfileUpdates(connectorResults);
  const profileMerge = buildDevFinalCompanyProfile({
    baseProfile: profile ?? { confidence: {} },
    connectorProfileUpdates: connectorProfile.profileUpdates,
    connectorSourcedDimensions: connectorProfile.audit.sourcedDimensions,
    connectorNormalizedDimensions: connectorProfile.audit.normalizedDimensions,
    connectorNormalizationFailures: connectorProfile.normalizationFailures,
  });

  return {
    bizNo: normalized,
    maskedBizNo: maskBizNoSafe(normalized),
    subject,
    profile,
    evidence,
    fields,
    coverage,
    connectorProfileUpdates: connectorProfile.profileUpdates,
    connectorNormalizationFailures: connectorProfile.normalizationFailures,
    connectorProfileAudit: connectorProfile.audit,
    profileMerge,
    coverageGrantWeights,
    trace,
    ...(error ? { error } : {}),
  };
}

/** 실제 최종 connector map의 값 생산축마다 typed update가 있는지 dev 응답에 영수증을 남긴다. */
export function collectConnectorProfileUpdates(results: Map<string, ConnectorResult>): {
  profileUpdates: CompanyProfileFieldUpdate[];
  normalizationFailures: DevServiceDataNormalizationFailure[];
  audit: ConnectorProfileUpdateAudit;
} {
  const profileUpdates = [...results.values()]
    .flatMap((result) => result.profileUpdates ?? [])
    .sort((a, b) => `${a.field}:${a.provider ?? ""}`.localeCompare(`${b.field}:${b.provider ?? ""}`));
  const normalizationFailures = [...results.values()]
    .flatMap((result) => result.normalizationFailure ? [result.normalizationFailure] : [])
    .sort((a, b) => `${a.field}:${a.message}`.localeCompare(`${b.field}:${b.message}`));
  const typedDimensions = [...new Set(profileUpdates.map((update) => update.field))];
  const typed = new Set<CriterionDimension>(typedDimensions);
  const valueProducingKeys = [...results]
    .filter(([, result]) => result.ok && typeof result.value === "string" && result.value.trim().length > 0)
    .map(([key]) => key)
    .sort();
  const dimensionByKey = new Map(FIELD_COVERAGE_PLAN.map((entry) => [entry.key, entry.dimension]));
  const sourcedDimensions = [...new Set(valueProducingKeys.flatMap((key) => {
    const dimension = dimensionByKey.get(key);
    return dimension ? [dimension] : [];
  }))].sort();
  const normalizedDimensions = [...new Set([...results].flatMap(([key, result]) => {
    if (result.profileNormalization !== "normalized") return [];
    const updateDimensions = (result.profileUpdates ?? []).map((update) => update.field);
    const dimension = dimensionByKey.get(key);
    return dimension ? [...updateDimensions, dimension] : updateDimensions;
  }))].sort();
  const missingTypedUpdateKeys = valueProducingKeys.filter((key) => {
    if (results.get(key)?.profileNormalization === "normalized") return false;
    const dimension = dimensionByKey.get(key);
    return dimension !== null && dimension !== undefined && !typed.has(dimension);
  });
  return {
    profileUpdates,
    normalizationFailures,
    audit: {
      valueProducingKeys,
      typedDimensions,
      sourcedDimensions,
      normalizedDimensions,
      missingTypedUpdateKeys,
    },
  };
}

function buildTrace(
  rows: EnrichmentCacheEntry[],
  beforeFetched: Map<string, number>,
): ServiceDataTraceEntry[] {
  const now = new Date();
  return rows.map((row) => {
    const key = snapshotKey(row.provider, row.scope);
    const before = beforeFetched.get(key);
    const origin: ServiceDataTraceOrigin =
      before === undefined || before !== row.fetchedAt.getTime() ? "live" : "cache";
    return {
      provider: row.provider,
      scope: row.scope,
      origin,
      checkedAt: row.checkedAt?.toISOString() ?? null,
      fetchedAt: row.fetchedAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      expired: isExpired(row, now),
      resultCode: row.providerResultCode ?? null,
      resultMessage: row.providerResultMessage ?? null,
      rawPayload: row.rawPayload ?? null,
      canonicalPayload: row.canonicalPayload ?? null,
    };
  });
}

function visibleCacheRows(
  rows: EnrichmentCacheEntry[],
  provider?: ServiceDataProvider,
): EnrichmentCacheEntry[] {
  return rows.filter((row) => {
    if (isApickGuard(row)) return false;
    if (!provider) return true;
    if (provider === "apick") {
      return row.provider === APICK_BIZ_DETAIL.provider && row.scope === APICK_BIZ_DETAIL.scope;
    }
    return row.provider === POPBILL.provider || row.provider === NTS.provider || row.provider === SMPP.provider;
  });
}

function isApickGuard(row: Pick<EnrichmentCacheEntry, "provider" | "scope">): boolean {
  return row.provider === APICK_BIZ_DETAIL_GUARD.provider && row.scope === APICK_BIZ_DETAIL_GUARD.scope;
}

function confidenceForProfileField(profile: CompanyProfile | null, key: string): number | null {
  const dimension = FIELD_DIMENSION[key];
  if (!dimension || !profile?.confidence) return null;
  const value = profile.confidence[dimension];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 22축 커버리지 하네스 — 무키(Phase 1) 뼈대
// 기존 라이브 소스(팝빌/NTS/SMPP/Apick)는 그대로 live/cache 로 동작(회귀 금지).
// 신규 외부소스(kcomwel·금융위·NICE·CODEF·명단 배치)는 커넥터 미배선이라 pending 고정 —
// 상태 판정은 computeFieldStatus 한 곳으로 수렴하고, Phase 2 커넥터가 connectorResults 로
// 결과를 넘기면 env 있음+에러/빈값/스키마 불일치 → failed 로 전이한다.
// ─────────────────────────────────────────────────────────────────────────────

// 계획 소스별 env 키(키 매니페스트 §B~D). 전부 존재해야 envPresent=true.
const ENV_KCOMWEL = ["CUNOTE_KCOMWEL_SERVICE_KEY"] as const;
const ENV_FSC = ["CUNOTE_FSC_FINANCE_SERVICE_KEY"] as const;
const ENV_MOEL = ["CUNOTE_MOEL_ACCIDENT_SERVICE_KEY"] as const;
const ENV_NICE = ["NICE_BIZ_CLIENT_APP_KEY", "NICE_BIZ_CLIENT_SECRET"] as const;
const ENV_CODEF = ["CODEF_CLIENT_ID", "CODEF_CLIENT_SECRET"] as const;
const ENV_KIPRIS = ["KIPRIS_SERVICE_KEY"] as const;

interface CoveragePlanEntry {
  key: string;
  profileFieldKey: ProfileFieldKey;
  parentKey: string | null;
  dimension: CriterionDimension | null;
  flag: DisqualificationFlag | null;
  subField: string | null;
  label: string;
  tier: FieldTier;
  plannedSource: string;
  /** evidence.fields 의 키(이미 배선된 라이브 소스가 채우는 축). */
  liveKey: string | null;
  /** 라이브 소스는 아니나 프로필/사업자번호에서 파생하는 축. */
  derived: "target_type" | "founder_trait" | null;
  /** 계획 외부소스의 env 키. */
  envKeys: readonly string[] | null;
  /** 배치 파이프라인(런타임 키 없음). */
  batch: boolean;
  /** 법인 전용축(개인 && !selfDeclarable → n/a). */
  corpOnly: boolean;
  /** 예약축(항상 n/a). */
  reserved: boolean;
  /** Q&A 로 채울 수 있는지. */
  selfDeclarable: boolean;
}

function planRow(
  e: Partial<CoveragePlanEntry> &
    Pick<CoveragePlanEntry, "key" | "label" | "tier" | "plannedSource">,
): CoveragePlanEntry {
  return {
    parentKey: null,
    dimension: null,
    flag: null,
    subField: null,
    liveKey: null,
    derived: null,
    envKeys: null,
    batch: false,
    corpOnly: false,
    reserved: false,
    selfDeclarable: false,
    ...e,
    profileFieldKey: e.profileFieldKey ?? requireProfileFieldKey(e.key),
  };
}

// canonical 라벨을 재사용한 결격 하위 플래그 행 팩토리.
function flagRow(
  parentKey: DisqualificationAxis,
  flag: DisqualificationFlag,
  opts: {
    tier: FieldTier;
    plannedSource: string;
    envKeys?: readonly string[];
    batch?: boolean;
    corpOnly?: boolean;
  },
): CoveragePlanEntry {
  return planRow({
    key: `${parentKey}.${flag}`,
    profileFieldKey: requireProfileFieldKey(`${parentKey}.flags`),
    parentKey,
    dimension: parentKey,
    flag,
    label: DISQUALIFICATION_FLAG_LABELS[flag],
    tier: opts.tier,
    plannedSource: opts.plannedSource,
    ...(opts.envKeys ? { envKeys: opts.envKeys } : {}),
    ...(opts.batch ? { batch: opts.batch } : {}),
    ...(opts.corpOnly ? { corpOnly: opts.corpOnly } : {}),
    selfDeclarable: true,
  });
}

const NICE_CORP = { tier: "A" as const, plannedSource: "NICE OCCD03(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true };

/** 22축(CRITERION_DIMENSIONS 순) + 하위 플래그·서브필드 커버리지 플랜. */
const FIELD_COVERAGE_PLAN: readonly CoveragePlanEntry[] = [
  planRow({ key: "region", dimension: "region", label: "소재지", tier: "A", plannedSource: "팝빌 주소", liveKey: "region" }),
  planRow({ key: "biz_age", dimension: "biz_age", label: "업력", tier: "A", plannedSource: "팝빌 개업일", liveKey: "biz_age" }),
  planRow({ key: "biz_age.is_preliminary", parentKey: "biz_age", dimension: "biz_age", subField: "is_preliminary", label: "예비창업 여부", tier: "B", plannedSource: "별도 시나리오 · 자가신고", selfDeclarable: true }),
  planRow({ key: "industry", dimension: "industry", label: "업종", tier: "A", plannedSource: "팝빌 업태·종목 → KSIC", liveKey: "industry" }),
  planRow({ key: "industry.industry_codes", parentKey: "industry", dimension: "industry", subField: "industry_codes", label: "KSIC 업종코드", tier: "A", plannedSource: "팝빌 업종코드 canonicalization" }),
  planRow({ key: "industry.list_completeness", parentKey: "industry", dimension: "industry", subField: "list_completeness", label: "업종 목록 완전성", tier: "A", plannedSource: "typed profile evidence" }),
  planRow({ key: "size", dimension: "size", label: "기업규모", tier: "A", plannedSource: "팝빌 기업규모(근사)", liveKey: "size" }),
  planRow({ key: "revenue", dimension: "revenue", label: "매출액", tier: "A", plannedSource: "금융위 재무 V2(법인) · CODEF(개인) · 자가신고", liveKey: "revenue", envKeys: ENV_FSC, selfDeclarable: true }),
  planRow({ key: "employees", dimension: "employees", label: "상시근로자", tier: "A", plannedSource: "근로복지공단 15059256 · 자가신고", liveKey: "employees", envKeys: ENV_KCOMWEL, selfDeclarable: true }),
  planRow({ key: "founder_age", dimension: "founder_age", label: "대표자 연령", tier: "B", plannedSource: "CODEF 간편인증 · 자가신고", liveKey: "founder_age", envKeys: ENV_CODEF, selfDeclarable: true }),
  planRow({ key: "founder_trait", dimension: "founder_trait", label: "대표자 특성", tier: "A", plannedSource: "SMPP(여성·장애인) · 자가신고(청년·시니어)", derived: "founder_trait", selfDeclarable: true }),
  planRow({ key: "founder_trait.list_completeness", parentKey: "founder_trait", dimension: "founder_trait", subField: "list_completeness", label: "대표자 특성 목록 완전성", tier: "B", plannedSource: "typed profile evidence" }),
  planRow({ key: "certification", dimension: "certification", label: "보유 인증·확인서", tier: "A", plannedSource: "SMPP + 창업진흥원 exact + 공개명단 배치 · 자가신고", liveKey: "certification", selfDeclarable: true }),
  planRow({ key: "certification.list_completeness", parentKey: "certification", dimension: "certification", subField: "list_completeness", label: "인증 목록 완전성", tier: "A", plannedSource: "typed profile evidence" }),
  planRow({ key: "prior_award", dimension: "prior_award", label: "수혜 이력", tier: "B", plannedSource: "통합 API 없음 · 자가신고", selfDeclarable: true }),
  planRow({ key: "prior_award.records", parentKey: "prior_award", dimension: "prior_award", subField: "records", label: "구조화 수혜 이력", tier: "B", plannedSource: "기관·사업명·상태·연도 자가신고", selfDeclarable: true }),
  planRow({ key: "prior_award.self_flags", parentKey: "prior_award", dimension: "prior_award", subField: "self_flags", label: "동일·유사 지원 범위", tier: "B", plannedSource: "범위별 자가신고", selfDeclarable: true }),
  planRow({ key: "prior_award.has_incubation_tenancy", parentKey: "prior_award", dimension: "prior_award", subField: "has_incubation_tenancy", label: "타 보육센터 입주", tier: "B", plannedSource: "자가신고", selfDeclarable: true }),
  planRow({ key: "prior_award.known_programs", parentKey: "prior_award", dimension: "prior_award", subField: "known_programs", label: "확인한 사업 범위", tier: "B", plannedSource: "질의 범위" }),
  planRow({ key: "prior_award.known_program_types", parentKey: "prior_award", dimension: "prior_award", subField: "known_program_types", label: "확인한 사업유형 범위", tier: "B", plannedSource: "질의 범위" }),
  planRow({ key: "prior_award.list_completeness", parentKey: "prior_award", dimension: "prior_award", subField: "list_completeness", label: "수혜 목록 완전성", tier: "B", plannedSource: "typed profile evidence" }),
  planRow({ key: "ip", dimension: "ip", label: "지식재산권", tier: "B", plannedSource: "KIPRIS Plus · 자가신고", envKeys: ENV_KIPRIS, selfDeclarable: true }),
  planRow({ key: "ip.right_kinds", parentKey: "ip", dimension: "ip", subField: "right_kinds", label: "권리 종류", tier: "B", plannedSource: "KIPRIS Plus typed update" }),
  planRow({ key: "ip.right_statuses", parentKey: "ip", dimension: "ip", subField: "right_statuses", label: "권리 상태", tier: "B", plannedSource: "KIPRIS Plus source detail" }),
  planRow({ key: "ip.list_completeness", parentKey: "ip", dimension: "ip", subField: "list_completeness", label: "권리 목록 완전성", tier: "B", plannedSource: "typed profile evidence" }),
  planRow({ key: "target_type", dimension: "target_type", label: "대상 유형(법인/개인)", tier: "A", plannedSource: "사업자번호 추론 · 자가신고(예비창업)", derived: "target_type", selfDeclarable: true }),
  planRow({ key: "target_type.legal_form", parentKey: "target_type", dimension: "target_type", subField: "legal_form", label: "법적 사업자 형태", tier: "A", plannedSource: "사업자등록정보", derived: "target_type" }),
  planRow({ key: "target_type.applicant_tags", parentKey: "target_type", dimension: "target_type", subField: "applicant_tags", label: "신청 주체 태그", tier: "B", plannedSource: "확인서 · 자가신고", selfDeclarable: true }),
  planRow({ key: "target_type.list_completeness", parentKey: "target_type", dimension: "target_type", subField: "list_completeness", label: "대상 유형 목록 완전성", tier: "A", plannedSource: "typed profile evidence" }),
  planRow({ key: "business_status", dimension: "business_status", label: "영업상태", tier: "A", plannedSource: "국세청 · 팝빌", liveKey: "business_status" }),
  planRow({ key: "business_status.active", parentKey: "business_status", dimension: "business_status", subField: "active", label: "영업 중 여부", tier: "A", plannedSource: "국세청 · 팝빌" }),

  // ── tax_compliance (납세 결격) ──
  planRow({ key: "tax_compliance", dimension: "tax_compliance", label: "납세 결격", tier: "A", plannedSource: "NICE OCCD03/01(법인) · CODEF(개인) · 자가신고", selfDeclarable: true }),
  flagRow("tax_compliance", "national_tax_delinquent", NICE_CORP),
  flagRow("tax_compliance", "local_tax_delinquent", NICE_CORP),
  flagRow("tax_compliance", "customs_delinquent", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),
  flagRow("tax_compliance", "social_insurance_delinquent", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),

  // ── credit_status (신용 결격) ──
  planRow({ key: "credit_status", dimension: "credit_status", label: "신용 결격", tier: "A", plannedSource: "NICE OCCD03/06/01(법인) · 자가신고", selfDeclarable: true }),
  flagRow("credit_status", "credit_delinquency", NICE_CORP),
  flagRow("credit_status", "loan_default", NICE_CORP),
  flagRow("credit_status", "bond_default", { tier: "A", plannedSource: "NICE OCCD01 당좌정지(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "rehabilitation_in_progress", { tier: "A", plannedSource: "NICE OCCD06(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "bankruptcy_filed", { tier: "A", plannedSource: "NICE OCCD06(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "court_receivership", { tier: "A", plannedSource: "NICE OCCD06(법인) · 자가신고", envKeys: ENV_NICE, corpOnly: true }),
  flagRow("credit_status", "financial_misconduct", NICE_CORP),
  flagRow("credit_status", "asset_seizure", { tier: "B", plannedSource: "OCCD 미커버 · 자가신고" }),
  flagRow("credit_status", "guarantee_restricted", { tier: "B", plannedSource: "OCCD 미커버 · 자가신고" }),

  // ── sanction (제재·명단 결격) ──
  planRow({ key: "sanction", dimension: "sanction", label: "제재·명단 결격", tier: "A", plannedSource: "조달청 CSV + 명단 배치 · 자가신고", selfDeclarable: true }),
  flagRow("sanction", "participation_restricted", { tier: "A", plannedSource: "조달청 부정당제재 CSV 15137996(배치·사업자번호)", batch: true }),
  flagRow("sanction", "wage_arrears_listed", { tier: "A", plannedSource: "고용부 체불 명단(배치·상호 퍼지)", batch: true }),
  flagRow("sanction", "serious_accident_listed", { tier: "A", plannedSource: "중대재해 15090150(상호 퍼지)", envKeys: ENV_MOEL }),
  flagRow("sanction", "subsidy_fraud", { tier: "B", plannedSource: "IRIS 폐쇄형 · 자가신고" }),
  flagRow("sanction", "subsidy_law_violation", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),
  flagRow("sanction", "obligation_breach", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),
  flagRow("sanction", "agreement_breach", { tier: "B", plannedSource: "소스 불명 · 자가신고" }),

  // ── financial_health (재무건전성) ──
  planRow({ key: "financial_health", dimension: "financial_health", label: "재무건전성", tier: "A", plannedSource: "금융위 재무 V2 · NICE OCOV06(법인)", selfDeclarable: true }),
  planRow({ key: "financial_health.debt_ratio_pct", parentKey: "financial_health", dimension: "financial_health", subField: "debt_ratio_pct", label: "부채비율", tier: "A", plannedSource: "금융위 재무 V2(법인)", envKeys: ENV_FSC, corpOnly: true }),
  planRow({ key: "financial_health.impairment", parentKey: "financial_health", dimension: "financial_health", subField: "impairment", label: "자본잠식", tier: "A", plannedSource: "금융위 재무 V2 파생 · 자가신고", envKeys: ENV_FSC, corpOnly: true, selfDeclarable: true }),
  planRow({ key: "financial_health.interest_coverage_ratio", parentKey: "financial_health", dimension: "financial_health", subField: "interest_coverage_ratio", label: "이자보상배율", tier: "A", plannedSource: "재무제표 파생 · 자가신고", selfDeclarable: true }),
  planRow({ key: "financial_health.total_assets_krw", parentKey: "financial_health", dimension: "financial_health", subField: "total_assets_krw", label: "자산총계", tier: "A", plannedSource: "금융위 재무 V2(법인)", envKeys: ENV_FSC, corpOnly: true }),
  planRow({ key: "financial_health.equity_krw", parentKey: "financial_health", dimension: "financial_health", subField: "equity_krw", label: "자본총계", tier: "A", plannedSource: "금융위 재무 V2 · 자가신고", envKeys: ENV_FSC, corpOnly: true, selfDeclarable: true }),
  planRow({ key: "financial_health.capital_krw", parentKey: "financial_health", dimension: "financial_health", subField: "capital_krw", label: "자본금", tier: "A", plannedSource: "재무제표 · 자가신고", selfDeclarable: true }),
  planRow({ key: "financial_health.fiscal_year", parentKey: "financial_health", dimension: "financial_health", subField: "fiscal_year", label: "재무 기준연도", tier: "A", plannedSource: "재무제표 기준연도" }),

  // ── insured_workforce (고용보험 가입) ──
  planRow({ key: "insured_workforce", dimension: "insured_workforce", label: "고용보험 가입", tier: "A", plannedSource: "근로복지공단(성립) · CODEF(피보험자수) · 자가신고", selfDeclarable: true }),
  planRow({ key: "insured_workforce.employment_insurance_active", parentKey: "insured_workforce", dimension: "insured_workforce", subField: "employment_insurance_active", label: "고용보험 성립여부", tier: "A", plannedSource: "근로복지공단 15059256", envKeys: ENV_KCOMWEL }),
  planRow({ key: "insured_workforce.insured_count", parentKey: "insured_workforce", dimension: "insured_workforce", subField: "insured_count", label: "피보험자수", tier: "B", plannedSource: "CODEF 4대보험 명부(인증서)", envKeys: ENV_CODEF }),
  planRow({ key: "insured_workforce.months_since_last_layoff", parentKey: "insured_workforce", dimension: "insured_workforce", subField: "months_since_last_layoff", label: "최근 감원 경과개월", tier: "B", plannedSource: "자가신고", selfDeclarable: true }),
  planRow({ key: "insured_workforce.no_layoff", parentKey: "insured_workforce", dimension: "insured_workforce", subField: "no_layoff", label: "감원 이력", tier: "B", plannedSource: "소스 없음 · 자가신고", selfDeclarable: true }),

  // ── investment (투자 유치) ──
  planRow({ key: "investment", dimension: "investment", label: "투자 유치", tier: "A", plannedSource: "jointips 명단 배치 · 자가신고", selfDeclarable: true }),
  planRow({ key: "investment.tips_backed", parentKey: "investment", dimension: "investment", subField: "tips_backed", label: "TIPS 선정", tier: "A", plannedSource: "jointips.or.kr 명단(배치·기업명 퍼지)", batch: true, selfDeclarable: true }),
  planRow({ key: "investment.total_raised_krw", parentKey: "investment", dimension: "investment", subField: "total_raised_krw", label: "누적 투자금", tier: "B", plannedSource: "소스 없음 · 자가신고", selfDeclarable: true }),
  planRow({ key: "investment.last_round", parentKey: "investment", dimension: "investment", subField: "last_round", label: "투자 라운드", tier: "B", plannedSource: "소스 없음 · 자가신고", selfDeclarable: true }),

  // ── 예약축 ──
  planRow({ key: "premises", dimension: "premises", label: "사업장(예약)", tier: "reserved", plannedSource: "법인등기·건축물대장(defer)", reserved: true }),
  planRow({ key: "export_performance", dimension: "export_performance", label: "수출실적(예약)", tier: "reserved", plannedSource: "무역협회·관세청 유니패스(defer)", reserved: true }),

  // ── other ──
  planRow({ key: "other", dimension: "other", label: "기타 조건", tier: "B", plannedSource: "Q&A 자유입력", selfDeclarable: true }),
];

/** dev 전용 행 메타가 참조하는 core CompanyProfile field key. */
export function profileFieldKeyForCoverageRow(key: string): ProfileFieldKey | null {
  return FIELD_COVERAGE_PLAN.find((entry) => entry.key === key)?.profileFieldKey ?? null;
}

/** 사업자번호 중간 2자리로 법인/개인 추론(81~88=법인격). */
export function resolveSubjectType(bizNo: string): SubjectType {
  const digits = bizNo.replace(/\D/g, "");
  if (digits.length !== 10) return "unknown";
  const mid = Number(digits.slice(3, 5));
  if (!Number.isFinite(mid)) return "unknown";
  return mid >= 81 && mid <= 88 ? "corporation" : "individual";
}

function envPresent(keys: readonly string[]): boolean {
  return keys.every((key) => {
    const value = process.env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function originBySourceFromTrace(
  trace: ServiceDataTraceEntry[],
): Map<string, ServiceDataTraceOrigin> {
  const map = new Map<string, ServiceDataTraceOrigin>();
  for (const entry of trace) {
    if (!map.has(entry.provider)) map.set(entry.provider, entry.origin);
  }
  return map;
}

function asOfBySourceFromTrace(trace: ServiceDataTraceEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of trace) {
    const asOf = entry.checkedAt ?? entry.fetchedAt;
    if (asOf && !map.has(entry.provider)) map.set(entry.provider, asOf);
  }
  return map;
}

/** 활성 공고 중 검수 대기(needs_review)가 아닌 criterion의 dimension 빈도를 집계한다. */
async function loadCoverageGrantWeights(): Promise<AutofillGrantWeights | null> {
  try {
    const grants = await getServiceRepositories().grants.listActiveGrants({ limit: 500, asOf: new Date() });
    const weights: AutofillGrantWeights = {};
    for (const grant of grants) {
      for (const criterion of grant.criteria) {
        if (criterion.needs_review === true) continue;
        weights[criterion.dimension] = (weights[criterion.dimension] ?? 0) + 1;
      }
    }
    return Object.keys(weights).length > 0 ? weights : null;
  } catch {
    return null;
  }
}

/**
 * 필드 상태 결정 — 5개 상태(n/a·live·cache·failed·pending)의 단일 판정점.
 * self-declared 는 클라이언트 Q&A 오버레이가 부여한다.
 * Phase 2 훅: external.result 가 채워지면(env 있음+커넥터 호출) 에러/빈값/스키마 불일치→failed.
 * Phase 1 은 external.result=null 로 외부소스를 pending 고정한다.
 */
export function computeFieldStatus(input: {
  reserved: boolean;
  corpOnly: boolean;
  subject: SubjectType;
  selfDeclarable: boolean;
  live: { available: boolean; origin: ServiceDataTraceOrigin } | null;
  external: { envPresent: boolean; batch: boolean; result: ConnectorResult | null } | null;
}): { status: FieldCoverageStatus; note: string | null } {
  if (input.reserved) return { status: "n/a", note: "예약축 · 판정 비활성" };
  if (input.corpOnly && input.subject === "individual" && !input.selfDeclarable) {
    return { status: "n/a", note: "법인 전용축 · 개인사업자 대상 아님" };
  }
  if (input.live?.available) {
    return { status: input.live.origin === "cache" ? "cache" : "live", note: null };
  }
  // 법인 소스가 커버 못 하는 개인사업자 결격/재무 축은 Q&A 로만 채운다.
  if (input.corpOnly && input.subject === "individual") {
    return { status: "pending", note: "개인 DB 없음 · 자가신고 대기" };
  }
  if (input.external) {
    const result = input.external.result;
    if (result !== null) {
      // Phase 2: 커넥터가 결과를 넘김.
      // skipped: 조회 전제 미충족(법인번호 없음 등) → pending 유지(사유 노출).
      if (result.skipped) {
        return { status: "pending", note: result.reason ?? "조회 전제 미충족" };
      }
      if (result.empty) {
        return { status: "pending", note: result.reason ?? "정상 응답 · 조회 결과 없음" };
      }
      if (!result.ok || result.schemaMismatch) {
        return { status: "failed", note: result.reason ?? "API 오류 · 스키마 불일치" };
      }
      return { status: result.origin === "cache" ? "cache" : "live", note: null };
    }
    // Phase 1: 커넥터 미배선 → pending 고정.
    if (input.external.batch) return { status: "pending", note: "배치 파이프라인 · Phase 2 배선 예정" };
    return {
      status: "pending",
      note: input.external.envPresent ? "키 있음 · 커넥터 Phase 2 배선 대기" : "키 없음",
    };
  }
  return { status: "pending", note: input.selfDeclarable ? "자가신고 대기" : "미배선" };
}

/**
 * 22축 + 하위 행 커버리지 산출. 라이브 소스가 채운 필드는 live/cache 로,
 * 신규 외부소스는 pending 으로, 법인 전용축의 개인사업자는 n/a 로 렌더한다.
 * @param connectorResults Phase 2 커넥터 결과 맵(entry.key → ConnectorResult). Phase 1 은 미전달.
 */
export function buildFieldCoverage(input: {
  subject: SubjectType;
  profile: CompanyProfile | null;
  fields: ServiceDataField[];
  originBySource: Map<string, ServiceDataTraceOrigin>;
  asOfBySource?: Map<string, string>;
  connectorResults?: Map<string, ConnectorResult>;
}): FieldCoverageRow[] {
  const fieldByKey = new Map(input.fields.map((field) => [field.key, field]));
  const originForSource = (source: ServiceDataFieldSource | null): ServiceDataTraceOrigin =>
    (source ? input.originBySource.get(source) : undefined) ?? "live";

  return FIELD_COVERAGE_PLAN.map((entry) => {
    let live: { available: boolean; origin: ServiceDataTraceOrigin } | null = null;
    let value: string | null = null;
    let source: FieldSourceRef | null = null;
    let confidence: number | null = null;
    let asOf: string | null = null;

    if (entry.liveKey) {
      const field = fieldByKey.get(entry.liveKey);
      if (field) {
        live = { available: field.available, origin: originForSource(field.source) };
        value = field.available ? field.value : null;
        source = field.source;
        confidence = field.confidence;
        asOf = field.asOf;
      }
    } else if (entry.derived === "founder_trait") {
      const traits = input.profile?.traits ?? [];
      if (traits.length > 0) {
        live = { available: true, origin: originForSource("smpp") };
        value = traits.join(", ");
        source = "smpp";
        confidence = input.profile?.confidence?.founder_trait ?? 0.6;
        asOf = input.asOfBySource?.get("smpp") ?? null;
      }
    } else if (entry.derived === "target_type") {
      if (input.subject !== "unknown") {
        live = { available: true, origin: "live" };
        value = input.subject === "corporation" ? "법인" : "개인사업자";
        source = "derived";
        confidence = 0.6;
      }
    }

    const connectorResult = input.connectorResults?.get(entry.key) ?? null;
    const connectorOutcome = connectorOutcomeOf(connectorResult);
    // CODEF 국세청 확정값은 최우선(handoff §5: codef > popbill/apick > derived/자가신고).
    // 팝빌 라이브키나 derived(target_type·founder_trait)가 먼저 채워도, codef 커넥터 결과가 있으면
    // 그 행을 국세청(CODEF)로 덮어쓴다. envKeys 게이팅과 무관하게(라이브키/파생축 포함) 병합된다.
    const codefOverride =
      connectorResult?.ok && connectorResult.source === "codef" ? connectorResult : null;
    const external =
      entry.envKeys || entry.batch || connectorResult
        ? {
            envPresent: entry.envKeys ? envPresent(entry.envKeys) : false,
            batch: entry.batch,
            result: connectorResult,
          }
        : null;

    const { status, note } = computeFieldStatus({
      reserved: entry.reserved,
      corpOnly: entry.corpOnly,
      subject: input.subject,
      selfDeclarable: entry.selfDeclarable,
      live,
      external,
    });

    let effectiveStatus = status;
    const externalLive = status === "live" || status === "cache";
    let rowNote = note;
    // 커넥터가 live 를 채웠으면(라이브 소스 필드가 아니라 외부 커넥터) 값/원천은 커넥터 결과에서 온다.
    if (externalLive && !live?.available && connectorResult?.ok) {
      value = connectorResult.value ?? null;
      confidence = connectorResult.confidence ?? null;
      source = connectorResult.source ?? null;
      asOf = connectorResult.asOf ?? null;
      // 커넥터가 표식 note 를 실었으면(예: "NICE 데모앱(무계약)") live 행에도 노출한다.
      if (connectorResult.note) rowNote = connectorResult.note;
    }
    // certification 합집합 — SMPP live 인증 ∪ registry 공개명단 배치 인증(설계 §6′-C).
    // certification 행은 envKeys/batch 가 없어 external=null 이라 computeFieldStatus 밖에서 병합한다.
    if (entry.key === "certification" && connectorResult?.ok && connectorResult.value) {
      const merged = mergeCertLabels(value, connectorResult.value);
      if (merged) {
        value = merged;
        if (!live?.available) {
          // SMPP 라이브 없음 → registry 단독 소스. pending → live 승격.
          effectiveStatus = "live";
          source = connectorResult.source ?? source;
          confidence = connectorResult.confidence ?? confidence;
          asOf = connectorResult.asOf ?? asOf;
          rowNote = connectorResult.note ?? rowNote;
        }
      }
    }
    if (entry.key === "certification" && connectorResult && !connectorResult.ok && !live?.available) {
      rowNote = connectorResult.reason ?? rowNote;
      if (!connectorResult.empty && !connectorResult.skipped) effectiveStatus = "failed";
    }
    const isLive = effectiveStatus === "live" || effectiveStatus === "cache";
    const positiveOnlyAxis =
      !entry.parentKey &&
      (entry.dimension === "founder_trait" || entry.dimension === "certification") &&
      (source === "smpp" || source === "popbill" || source === "registry");
    const legalFormOnlyAxis =
      !entry.parentKey && entry.dimension === "target_type" && source === "derived";
    // CODEF 국세청 확정값이 있으면 라이브키/파생/외부 결과를 덮어 최우선으로 표시한다.
    // 커넥터가 라이브 호출이 아니라 company_enrichment_cache passive 판독이므로 status는 "cache"
    // (인증은 api/dev/codef/* 에서 선행돼 캐시에 남았고, 이 행은 그 캐시를 재사용해 표시한다).
    if (codefOverride) {
      return {
        key: entry.key,
        parentKey: entry.parentKey,
        dimension: entry.dimension,
        flag: entry.flag,
        subField: entry.subField,
        label: entry.label,
        tier: entry.tier,
        plannedSource: entry.plannedSource,
        selfDeclarable: entry.selfDeclarable,
        status: "cache",
        connectorOutcome: "value",
        value: codefOverride.value ?? null,
        confidence: codefOverride.confidence ?? null,
        source: "codef",
        sourceKind: codefOverride.sourceKind ?? classifyEvidenceSourceKind({
          provider: "codef",
          dimension: entry.dimension,
          status: "cache",
        }),
        asOf: codefOverride.asOf ?? null,
        axisCompleteness: codefOverride.axisCompleteness ?? defaultAxisCompleteness({
          status: "cache",
          parentKey: entry.parentKey,
        }),
        note: codefOverride.note ?? null,
      };
    }
    return {
      key: entry.key,
      parentKey: entry.parentKey,
      dimension: entry.dimension,
      flag: entry.flag,
      subField: entry.subField,
      label: entry.label,
      tier: entry.tier,
      plannedSource: entry.plannedSource,
      selfDeclarable: entry.selfDeclarable,
      status: effectiveStatus,
      connectorOutcome:
        connectorOutcome ?? (effectiveStatus === "live" || effectiveStatus === "cache" ? "value" : null),
      value: isLive ? value : null,
      confidence: isLive ? confidence : null,
      source: isLive ? source : connectorResult?.source ?? null,
      sourceKind: isLive
        ? (!live?.available ? connectorResult?.sourceKind : undefined) ?? classifyEvidenceSourceKind({
            provider: source,
            dimension: entry.dimension,
            status: effectiveStatus,
          })
        : connectorResult?.sourceKind ?? null,
      asOf: isLive ? asOf : connectorResult?.asOf ?? null,
      axisCompleteness:
        connectorResult?.axisCompleteness ??
        (positiveOnlyAxis || legalFormOnlyAxis
          ? "partial"
          : defaultAxisCompleteness({
              status: effectiveStatus,
              parentKey: entry.parentKey,
            })),
      note: rowNote,
    };
  });
}

function connectorOutcomeOf(result: ConnectorResult | null): ConnectorOutcome | null {
  if (!result) return null;
  if (result.skipped) return "prerequisite";
  if (result.empty) return "empty";
  if (result.ok) return "value";
  return "error";
}

/** 인증 라벨 문자열(", " 구분)의 합집합. a 비면 b, 중복 제거·등장순 유지. */
function mergeCertLabels(a: string | null, b: string): string | null {
  const split = (s: string | null): string[] =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const label of [...split(a), ...split(b)]) {
    if (seen.has(label)) continue;
    seen.add(label);
    merged.push(label);
  }
  return merged.length > 0 ? merged.join(", ") : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — data.go.kr 커넥터 배선(dev 전용, 프로덕션 오버레이 체인 미접촉).
// kcomwel(고용·산재 15059256) · 금융위 기업재무(15043459) · 금융위 개인사업자재무(15108171).
// 각 커넥터 결과를 필드 키별 ConnectorResult 로 만들어 buildFieldCoverage 에 주입 →
// 값 있으면 live, 에러/빈값/스키마불일치 failed, 조회 전제 미충족(법인번호 없음) skip→pending.
// ─────────────────────────────────────────────────────────────────────────────

/** apick 상세가 실어 준 법인등록번호(13자리)를 프로필에서 추출. 없으면 null(팝빌 경로엔 없음). */
function extractCorpRegNo(profile: CompanyProfile | null): string | null {
  const raw = profile?.other_conditions?.["apick_corporate_registration_no"];
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length === 13 ? digits : null;
}

function connectorErrorReason(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 160);
  return String(error).slice(0, 160);
}

/** 원(₩) 금액을 억/만원 한글 표기로 압축(음수·0 포함). */
function formatKrwCompact(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 100_000_000) {
    const eok = Math.round((abs / 100_000_000) * 10) / 10;
    return `${sign}${eok.toLocaleString("ko-KR")}억원`;
  }
  if (abs >= 10_000) return `${sign}${Math.round(abs / 10_000).toLocaleString("ko-KR")}만원`;
  return `${sign}${abs.toLocaleString("ko-KR")}원`;
}

/**
 * dev 조회 경로에서만 실행되는 외부 커넥터 오케스트레이터. 필드 키 → ConnectorResult 맵을 만든다.
 * - 각 커넥터는 fail-open(내부 try/catch) — 절대 throw 하지 않아 lookup 흐름을 깨지 않는다.
 * - 키 미설정 소스는 아무 결과도 넣지 않아 pending("키 없음") 을 유지한다.
 */
export async function runExternalConnectors(input: {
  bizNo: string;
  subject: SubjectType;
  profile: CompanyProfile | null;
}): Promise<Map<string, ConnectorResult>> {
  if (process.env.NODE_ENV !== "production") {
    const { loadMonorepoEnv } = await import("./loadMonorepoEnv");
    loadMonorepoEnv();
  }
  const results = new Map<string, ConnectorResult>();
  const niceResults = new Map<string, ConnectorResult>();
  const codefResults = new Map<string, ConnectorResult>();
  const fscResults = new Map<string, ConnectorResult>();
  const dartResults = new Map<string, ConnectorResult>();
  const startupResults = new Map<string, ConnectorResult>();
  const dartBridge = resolveDartBridgeForFinance(input);
  await Promise.all([
    runKcomwelConnector(input.bizNo, results),
    runKiprisConnector(input.bizNo, results),
    dartBridge.then((bridge) => runFscCorpFinanceConnector(input, fscResults, bridge)),
    dartBridge.then((bridge) => runDartOverlayConnector(input, dartResults, bridge)),
    runFscPersonalFinanceConnector(input, fscResults),
    runNiceConnector(input, niceResults),
    runCodefConnector(input.bizNo, codefResults),
    runRegistryConnector(input, results),
    runStartupConfirmationConnector(input.bizNo, startupResults),
  ]);
  mergeNiceAndCodefConnectorResults(results, niceResults, codefResults);
  mergeFscConnectorResults(results, fscResults);
  mergeDartConnectorResults(results, dartResults);
  mergeCertificationConnectorResult(results, startupResults.get("certification"));
  addListCompletenessDiagnostics(results);
  return results;
}

export function addListCompletenessDiagnostics(results: Map<string, ConnectorResult>): void {
  for (const dimension of ["industry", "founder_trait", "certification", "ip", "target_type"] as const) {
    const parent = results.get(dimension);
    const update = parent?.profileUpdates?.find((candidate) => candidate.field === dimension);
    if (!parent?.ok || !update) continue;
    const completeness = update.mode === "merge" ? "partial" : "complete";
    results.set(`${dimension}.list_completeness`, {
      ok: true,
      ...(parent.origin ? { origin: parent.origin } : {}),
      value: completeness,
      confidence: parent.confidence ?? null,
      ...(parent.source ? { source: parent.source } : {}),
      ...(parent.sourceKind ? { sourceKind: parent.sourceKind } : {}),
      asOf: parent.asOf ?? null,
      axisCompleteness: completeness,
      note: parent.note ?? null,
    });
  }
}

function mergeNiceAndCodefConnectorResults(
  results: Map<string, ConnectorResult>,
  niceResults: Map<string, ConnectorResult>,
  codefResults: Map<string, ConnectorResult>,
): void {
  for (const [key, result] of niceResults) results.set(key, result);
  for (const [key, incoming] of codefResults) {
    const existing = results.get(key);
    if (incoming.ok || !existing?.ok) results.set(key, incoming);
  }
}

interface DartBridgeResolution {
  lookup: DartCompanyBridgeLookup | null;
  error: string | null;
}

async function resolveDartBridgeForFinance(input: {
  bizNo: string;
  subject: SubjectType;
  profile: CompanyProfile | null;
}): Promise<DartBridgeResolution> {
  if (input.subject !== "corporation") {
    return { lookup: null, error: null };
  }
  const apiKey = process.env.OPENDART_API_KEY?.trim();
  const companyName = input.profile?.name?.trim();
  if (!apiKey || !companyName) return { lookup: null, error: null };
  try {
    const lookup = await resolveDartCompanyBridge({
      apiKey,
      bizNo: input.bizNo,
      companyName,
      cache: getServiceRepositories().enrichmentCache,
    });
    return { lookup, error: null };
  } catch (error) {
    return { lookup: null, error: connectorErrorReason(error) };
  }
}

/** 표시값 우선순위: 재무 CODEF > DART > 금융위 > NICE, 직원 근로복지공단 > DART. */
export function mergeDartConnectorResults(
  results: Map<string, ConnectorResult>,
  dartResults: Map<string, ConnectorResult>,
): void {
  for (const [key, incoming] of dartResults) {
    const existing = results.get(key);
    if (!existing) {
      results.set(key, incoming);
      continue;
    }
    if (existing.source === "codef") continue;
    if (key === "employees" && existing.source === "kcomwel" && existing.ok) continue;
    if (
      key === "financial_health.impairment" &&
      existing.source === "fsc" &&
      existing.ok &&
      hasFinancialImpairment(results.get("financial_health"), "fsc")
    ) continue;
    if (key === "financial_health" && existing.source === "fsc" && existing.ok && incoming.ok) {
      const profileUpdates = [
        ...(existing.profileUpdates ?? []),
        ...(incoming.profileUpdates ?? []),
      ].sort((a, b) => `${a.provider ?? ""}:${a.asOf ?? ""}`.localeCompare(`${b.provider ?? ""}:${b.asOf ?? ""}`));
      results.set(key, {
        ...existing,
        ...(profileUpdates.length > 0 ? { profileUpdates } : {}),
        ...(existing.normalizationFailure || incoming.normalizationFailure
          ? { normalizationFailure: existing.normalizationFailure ?? incoming.normalizationFailure }
          : {}),
      });
      continue;
    }
    if (incoming.ok || !existing.ok) results.set(key, incoming);
  }
}

function hasFinancialImpairment(result: ConnectorResult | undefined, provider: string): boolean {
  return result?.profileUpdates?.some((update) => {
    if (update.field !== "financial_health" || update.provider !== provider) return false;
    return typeof update.value === "object" && update.value !== null && "impairment" in update.value;
  }) ?? false;
}

function mergeFscConnectorResults(
  results: Map<string, ConnectorResult>,
  fscResults: Map<string, ConnectorResult>,
): void {
  for (const [key, incoming] of fscResults) {
    const existing = results.get(key);
    if (!existing) {
      results.set(key, incoming);
      continue;
    }
    if (existing.source === "codef") continue;
    if (incoming.ok || !existing.ok) results.set(key, incoming);
  }
}

const STARTUP_CONFIRMATION_CACHE = { provider: "kised", scope: "startup-confirmation" } as const;
const STARTUP_CONFIRMATION_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const inflightStartupConfirmationLookups = new Map<string, Promise<StartupConfirmationLookup>>();

async function runStartupConfirmationConnector(
  bizNo: string,
  results: Map<string, ConnectorResult>,
): Promise<void> {
  const serviceKey = resolveDataGoKrServiceKey("CUNOTE_KISED_CERT_SERVICE_KEY");
  if (!serviceKey) return;
  const cache = getServiceRepositories().enrichmentCache;
  const now = new Date();
  const cached = await cache.getFresh({
    provider: STARTUP_CONFIRMATION_CACHE.provider,
    bizNo,
    scope: STARTUP_CONFIRMATION_CACHE.scope,
    now,
  }).catch(() => null);
  const cachedLookup = readStartupConfirmationCache(cached?.canonicalPayload);
  if (cached && cachedLookup) {
    results.set("certification", startupConfirmationResult(cachedLookup, "cache", cacheEntryAsOf(cached)));
    return;
  }

  try {
    const lookup = await coalesceStartupConfirmationLookup(bizNo, () =>
      checkStartupConfirmation({ serviceKey, bizNo, now }),
    );
    const checkedAt = new Date();
    await cache.put({
      provider: STARTUP_CONFIRMATION_CACHE.provider,
      bizNo,
      scope: STARTUP_CONFIRMATION_CACHE.scope,
      canonicalPayload: lookup as unknown as Record<string, unknown>,
      providerResultCode: lookup.state === "active" ? "00" : "03",
      providerResultMessage: lookup.state,
      checkedAt,
      fetchedAt: checkedAt,
      expiresAt: new Date(checkedAt.getTime() + STARTUP_CONFIRMATION_CACHE_TTL_MS),
    }).catch(() => null);
    results.set("certification", startupConfirmationResult(lookup, "live", checkedAt.toISOString()));
  } catch (error) {
    results.set("certification", {
      ok: false,
      reason: connectorErrorReason(error),
      source: "kised",
      sourceKind: "authoritative_api",
      asOf: now.toISOString(),
    });
  }
}

export function coalesceStartupConfirmationLookup(
  bizNo: string,
  run: () => Promise<StartupConfirmationLookup>,
): Promise<StartupConfirmationLookup> {
  const existing = inflightStartupConfirmationLookups.get(bizNo);
  if (existing) return existing;
  const task = run().finally(() => {
    if (inflightStartupConfirmationLookups.get(bizNo) === task) {
      inflightStartupConfirmationLookups.delete(bizNo);
    }
  });
  inflightStartupConfirmationLookups.set(bizNo, task);
  return task;
}

function startupConfirmationResult(
  lookup: StartupConfirmationLookup,
  origin: ServiceDataTraceOrigin,
  asOf: string | null,
): ConnectorResult {
  const record = lookup.record;
  const meta = {
    origin,
    source: "kised" as const,
    sourceKind: "authoritative_api" as const,
    asOf,
    axisCompleteness: "partial" as const,
  };
  if (lookup.state === "active" && record) {
    const result: ConnectorResult = {
      ok: true,
      ...meta,
      value: `창업기업확인서 (유효 ~${formatDateKey(record.expiresOn)})`,
      confidence: 0.95,
      note: "창업진흥원 사업자번호 exact",
    };
    return withCertificationProfileUpdates(result, ["창업기업확인서"], "startup_confirmation");
  }
  if (lookup.state === "expired" && record) {
    return { ok: false, empty: true, ...meta, reason: `창업기업확인서 만료 (${formatDateKey(record.expiresOn)})` };
  }
  if (lookup.state === "future" && record) {
    return { ok: false, empty: true, ...meta, reason: `창업기업확인서 발급예정 (${formatDateKey(record.issuedOn)})` };
  }
  if (lookup.state === "invalid") {
    return { ok: false, schemaMismatch: true, ...meta, reason: "창업기업확인서 유효기간 필드 누락" };
  }
  return { ok: false, empty: true, ...meta, reason: "창업기업확인서 exact 조회 결과 없음" };
}

function readStartupConfirmationCache(
  value: Record<string, unknown> | null | undefined,
): StartupConfirmationLookup | null {
  if (!value || !["active", "expired", "future", "invalid", "none"].includes(String(value.state))) return null;
  const exactRecordCount = typeof value.exactRecordCount === "number" ? value.exactRecordCount : 0;
  const rawRecord = value.record;
  if (!rawRecord || typeof rawRecord !== "object") {
    return { state: value.state as StartupConfirmationLookup["state"], record: null, exactRecordCount };
  }
  const record = rawRecord as Record<string, unknown>;
  if (typeof record.businessRegistrationNumber !== "string") return null;
  const stringOrNull = (input: unknown): string | null => typeof input === "string" ? input : null;
  return {
    state: value.state as StartupConfirmationLookup["state"],
    exactRecordCount,
    record: {
      businessRegistrationNumber: record.businessRegistrationNumber,
      corporateRegistrationNumber: stringOrNull(record.corporateRegistrationNumber),
      companyName: stringOrNull(record.companyName),
      companyType: stringOrNull(record.companyType),
      certificateNumber: stringOrNull(record.certificateNumber),
      issuedOn: stringOrNull(record.issuedOn),
      expiresOn: stringOrNull(record.expiresOn),
    },
  };
}

export function mergeCertificationConnectorResult(
  results: Map<string, ConnectorResult>,
  startup: ConnectorResult | undefined,
): void {
  if (!startup) return;
  const existing = results.get("certification");
  if (!existing || !existing.ok) {
    results.set("certification", startup);
    return;
  }
  if (!startup.ok || !startup.value) return;
  const profileUpdates = [
    ...(existing.profileUpdates ?? []),
    ...(startup.profileUpdates ?? []),
  ];
  const normalizationFailure = startup.normalizationFailure ?? existing.normalizationFailure;
  results.set("certification", {
    ...startup,
    value: mergeCertLabels(existing.value ?? null, startup.value),
    confidence: Math.max(existing.confidence ?? 0, startup.confidence ?? 0),
    ...(profileUpdates.length > 0 ? { profileUpdates } : {}),
    ...(normalizationFailure ? { normalizationFailure } : {}),
  });
}

function formatDateKey(value: string | null): string {
  if (!value || value.length !== 8) return "날짜 미상";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

const KIPRIS_CACHE = { provider: "kipris", scope: "applicant-business-number" } as const;
const KIPRIS_CACHE_TTL_MS = 31 * 24 * 60 * 60 * 1_000;
const inflightKiprisLookups = new Map<string, Promise<KiprisApplicantMatch | null>>();

interface KiprisApplicantCachePayload {
  version: 2;
  found: boolean;
  match: KiprisApplicantMatch | null;
  rights: KiprisRightsSummary | null;
}

/** KIPRISPlus 사업자번호 exact → 공개·등록 출원 이력. 31일 캐시와 사업자별 single-flight 적용. */
async function runKiprisConnector(
  bizNo: string,
  results: Map<string, ConnectorResult>,
): Promise<void> {
  const accessKey = process.env.KIPRIS_SERVICE_KEY?.trim();
  if (!accessKey) return;

  const cache = getServiceRepositories().enrichmentCache;
  const now = new Date();
  const cached = await cache.getFresh({
    provider: KIPRIS_CACHE.provider,
    bizNo,
    scope: KIPRIS_CACHE.scope,
    now,
  }).catch(() => null);
  const cachedPayload = readKiprisCachePayload(cached?.canonicalPayload);
  if (cached && cachedPayload) {
    setKiprisConnectorResults(
      results,
      cachedPayload.match,
      cachedPayload.rights,
      "cache",
      cacheEntryAsOf(cached),
    );
    return;
  }

  try {
    const match = await coalesceKiprisLookup(bizNo, () => checkKiprisApplicant({ accessKey, bizNo }));
    let rights: KiprisRightsSummary | null = null;
    if (match) {
      try {
        rights = await checkKiprisRights({ accessKey, applicantNumber: match.applicantNumber });
      } catch (error) {
        results.set("ip", {
          ...kiprisConnectorResult(match, null, "live", now.toISOString()),
          note: `KIPRISPlus exact · 권리별 조회 실패: ${connectorErrorReason(error)}`,
        });
        return;
      }
    }
    const checkedAt = new Date();
    const payload: KiprisApplicantCachePayload = { version: 2, found: match !== null, match, rights };
    await cache.put({
      provider: KIPRIS_CACHE.provider,
      bizNo,
      scope: KIPRIS_CACHE.scope,
      canonicalPayload: payload as unknown as Record<string, unknown>,
      providerResultCode: match ? "00" : "03",
      providerResultMessage: match ? "exact applicant match" : "no public/registered applicant match",
      checkedAt,
      fetchedAt: checkedAt,
      expiresAt: new Date(checkedAt.getTime() + KIPRIS_CACHE_TTL_MS),
    }).catch(() => null);
    setKiprisConnectorResults(results, match, rights, "live", checkedAt.toISOString());
  } catch (error) {
    results.set("ip", {
      ok: false,
      reason: connectorErrorReason(error),
      source: "kipris",
      sourceKind: "authoritative_api",
      asOf: now.toISOString(),
    });
  }
}

export function setKiprisConnectorResults(
  results: Map<string, ConnectorResult>,
  match: KiprisApplicantMatch | null,
  rights: KiprisRightsSummary | null,
  origin: ServiceDataTraceOrigin,
  asOf: string | null,
): void {
  const parent = kiprisConnectorResult(match, rights, origin, asOf);
  results.set("ip", parent);
  if (!match || !rights) return;
  const rightKinds = [
    rights.patentUtility.totalCount > 0 ? "특허·실용신안" : null,
    rights.design.totalCount > 0 ? "디자인" : null,
    rights.trademark.totalCount > 0 ? "상표" : null,
  ].filter((kind): kind is string => kind !== null);
  if (rightKinds.length > 0) {
    results.set("ip.right_kinds", {
      ok: true,
      origin,
      value: rightKinds.join(", "),
      confidence: parent.confidence ?? null,
      source: "kipris",
      sourceKind: "authoritative_api",
      asOf,
      axisCompleteness: parent.axisCompleteness ?? "partial",
    });
  }
  const summaries = [rights.patentUtility, rights.design, rights.trademark];
  const statusCounts = {
    applied: summaries.reduce((sum, summary) => sum + summary.appliedCount, 0),
    published: summaries.reduce((sum, summary) => sum + summary.publishedCount, 0),
    registered: summaries.reduce((sum, summary) => sum + summary.registeredCount, 0),
    extinguished: summaries.reduce((sum, summary) => sum + summary.extinguishedCount, 0),
  };
  const statusValue = [
    `출원 ${statusCounts.applied.toLocaleString("ko-KR")}`,
    `공개 ${statusCounts.published.toLocaleString("ko-KR")}`,
    `등록 ${statusCounts.registered.toLocaleString("ko-KR")}`,
    `소멸 ${statusCounts.extinguished.toLocaleString("ko-KR")}`,
  ].join(" · ");
  results.set("ip.right_statuses", {
    ok: true,
    origin,
    value: statusValue,
    confidence: parent.confidence ?? null,
    source: "kipris",
    sourceKind: "authoritative_api",
    asOf,
    axisCompleteness: parent.axisCompleteness ?? "partial",
    note: rights.truncated ? "500건 초과 권리 상태 일부 집계" : null,
  });
}

export function coalesceKiprisLookup(
  bizNo: string,
  run: () => Promise<KiprisApplicantMatch | null>,
): Promise<KiprisApplicantMatch | null> {
  const existing = inflightKiprisLookups.get(bizNo);
  if (existing) return existing;
  const task = run().finally(() => {
    if (inflightKiprisLookups.get(bizNo) === task) inflightKiprisLookups.delete(bizNo);
  });
  inflightKiprisLookups.set(bizNo, task);
  return task;
}

function kiprisConnectorResult(
  match: KiprisApplicantMatch | null,
  rights: KiprisRightsSummary | null,
  origin: ServiceDataTraceOrigin,
  asOf: string | null,
): ConnectorResult {
  if (!match) {
    return {
      ok: false,
      empty: true,
      origin,
      reason: "공개·등록 출원인 법인 목록에서 조회되지 않음 · 미공개 출원/IP 부재 확정 아님",
      source: "kipris",
      sourceKind: "authoritative_api",
      asOf,
      axisCompleteness: "partial",
    };
  }
  if (rights) {
    const label = (name: string, summary: KiprisRightsSummary["patentUtility"]): string =>
      `${name} ${summary.totalCount.toLocaleString("ko-KR")}건` +
      ` (출원 ${summary.appliedCount.toLocaleString("ko-KR")} · 공개 ${summary.publishedCount.toLocaleString("ko-KR")} · 등록 ${summary.registeredCount.toLocaleString("ko-KR")} · 소멸 ${summary.extinguishedCount.toLocaleString("ko-KR")})`;
    const result: ConnectorResult = {
      ok: true,
      origin,
      value: [
        label("특허·실용", rights.patentUtility),
        label("디자인", rights.design),
        label("상표", rights.trademark),
      ].join(" · "),
      confidence: rights.truncated ? 0.85 : 0.95,
      source: "kipris",
      sourceKind: "authoritative_api",
      asOf,
      // 특허고객번호 exact는 개인 명의·다른 출원인번호까지 소진하지 못하고 KIPRIS 종류도
      // matcher criterion vocabulary와 동일하지 않으므로, 비절단이어도 IP 축 부재를 확정하지 않는다.
      axisCompleteness: "partial",
      note: rights.truncated
        ? `KIPRISPlus 특허고객번호 exact · 전체 ${rights.totalCount.toLocaleString("ko-KR")}건 · 500건 초과 권리 상태 일부 집계`
        : `KIPRISPlus 특허고객번호 exact · 전체 ${rights.totalCount.toLocaleString("ko-KR")}건`,
    };
    const rightKinds = [
      rights.patentUtility.totalCount > 0 ? "특허·실용신안" : null,
      rights.design.totalCount > 0 ? "디자인" : null,
      rights.trademark.totalCount > 0 ? "상표" : null,
    ].filter((kind): kind is string => kind !== null);
    return attachConnectorProfileNormalization(
      result,
      buildIpProfileUpdates(rightKinds, profileMetadata(result, "kipris", "partial")),
    );
  }
  return {
    ok: true,
    origin,
    value: `공개·등록 출원 이력 있음 · 특허고객번호 ${match.applicantNumber}`,
    confidence: 0.9,
    source: "kipris",
    sourceKind: "authoritative_api",
    asOf,
    axisCompleteness: "partial",
    note: "KIPRISPlus 사업자번호 exact · 권리별 건수 후속 배선",
  };
}

function readKiprisCachePayload(
  value: Record<string, unknown> | null | undefined,
): KiprisApplicantCachePayload | null {
  if (!value || value.version !== 2 || typeof value.found !== "boolean") return null;
  const match = value.match;
  if (!value.found) return { version: 2, found: false, match: null, rights: null };
  if (!match || typeof match !== "object") return null;
  const candidate = match as Partial<KiprisApplicantMatch>;
  if (typeof candidate.applicantNumber !== "string" || typeof candidate.businessRegistrationNumber !== "string") {
    return null;
  }
  const rights = readKiprisRightsCache(value.rights);
  if (!rights) return null;
  return {
    version: 2,
    found: true,
    match: {
      applicantNumber: candidate.applicantNumber,
      applicantName: typeof candidate.applicantName === "string" ? candidate.applicantName : null,
      corporationNumber: typeof candidate.corporationNumber === "string" ? candidate.corporationNumber : null,
      businessRegistrationNumber: candidate.businessRegistrationNumber,
    },
    rights,
  };
}

function readKiprisRightsCache(value: unknown): KiprisRightsSummary | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<KiprisRightsSummary>;
  const valid = (summary: unknown): summary is KiprisRightsSummary["patentUtility"] => {
    if (!summary || typeof summary !== "object") return false;
    const row = summary as Record<string, unknown>;
    return typeof row.totalCount === "number" && typeof row.fetchedCount === "number";
  };
  if (!valid(candidate.patentUtility) || !valid(candidate.design) || !valid(candidate.trademark)) return null;
  if (typeof candidate.totalCount !== "number" || typeof candidate.truncated !== "boolean") return null;
  return candidate as KiprisRightsSummary;
}

/**
 * 공개명단 배치 색인(registry_index) 조회 커넥터 — 라이브 API 가 아니라 오프라인 적재분을 읽는다.
 * - present_only(인증·중대재해·체불·TIPS): active present 매칭만 set(부재는 무정보 → pending).
 * - known_on_absence(조달청 부정당): 소스가 적재됐으면 부재도 "제한 없음"으로 확정(clear).
 * 명단이 아직 하나도 적재 안 됐으면 아무 결과도 넣지 않아 pending 을 유지한다(fail-open).
 */

/** known_on_absence 소스별 필드 매핑(소진적 명단만). */
const REGISTRY_KNOWN_ON_ABSENCE = [
  {
    source: PROCUREMENT_DEBARMENT_SOURCE,
    flagOrCert: "participation_restricted",
    fieldKey: "sanction.participation_restricted",
    label: "조달청",
  },
] as const;

async function runRegistryConnector(
  input: { bizNo: string; subject: SubjectType; profile: CompanyProfile | null },
  results: Map<string, ConnectorResult>,
): Promise<void> {
  try {
    const repo = getServiceRepositories().registryIndex;
    const bizNo = input.bizNo.replace(/\D/g, "") || null;
    const corpNo = extractCorpRegNo(input.profile);
    const name = input.profile?.name?.trim() || null;
    const nameNormalized = name ? normalizeCompanyName(name) : null;

    const candidates = await repo.findCandidates({ bizNo, corpNo, nameNormalized });
    const matches = matchRegistry(candidates, { bizNo, corpNo, name });
    const loadedKnownSources = new Set<string>();
    for (const cfg of REGISTRY_KNOWN_ON_ABSENCE) {
      if (await repo.hasSource(cfg.source)) loadedKnownSources.add(cfg.source);
    }
    applyRegistryMatches(results, matches, loadedKnownSources);
  } catch {
    // fail-open — 조회 실패는 무시(pending 유지, 다른 커넥터 보호).
  }
}

/** registry DB 조회 뒤 실제 typed 결과를 만드는 순수 경계. */
export function applyRegistryMatches(
  results: Map<string, ConnectorResult>,
  matches: readonly RegistryMatch[],
  loadedKnownSources: ReadonlySet<string>,
): void {
  const sanctionFlags = new Set<DisqualificationFlag>();
  const sanctionKnownFlags = new Set<DisqualificationFlag>();
  let sanctionAsOf: string | null = null;
  let sanctionConfidence = 1;
  let tipsBacked = false;
  let investmentAsOf: string | null = null;
  let investmentConfidence = 1;
  const certLabels: string[] = [];
  let certificationAsOf: string | null = null;

  // 1) present_only — active present 매칭만 반영. certification 은 canonical 목록으로 취합.
  for (const match of matches) {
    if (!match.active || match.record.polarity !== "present_only") continue;
    const rec = match.record;
    if (rec.registryType === "certification") {
      certLabels.push(rec.flagOrCert);
      const fetchedAt = rec.sourceFetchedAt.toISOString();
      if (certificationAsOf === null || fetchedAt > certificationAsOf) certificationAsOf = fetchedAt;
      continue;
    }
    if (
      rec.registryType === "sanction" &&
      DISQUALIFICATION_FLAGS.sanction.includes(rec.flagOrCert as DisqualificationFlag)
    ) {
      const flag = rec.flagOrCert as DisqualificationFlag;
      sanctionFlags.add(flag);
      sanctionKnownFlags.add(flag);
      sanctionConfidence = Math.min(sanctionConfidence, rec.confidence);
      const fetchedAt = rec.sourceFetchedAt.toISOString();
      if (sanctionAsOf === null || fetchedAt > sanctionAsOf) sanctionAsOf = fetchedAt;
    }
    if (rec.registryType === "investment" && rec.flagOrCert === "tips_backed") {
      tipsBacked = true;
      investmentConfidence = Math.min(investmentConfidence, rec.confidence);
      const fetchedAt = rec.sourceFetchedAt.toISOString();
      if (investmentAsOf === null || fetchedAt > investmentAsOf) investmentAsOf = fetchedAt;
    }
    results.set(`${rec.registryType}.${rec.flagOrCert}`, {
      ok: true,
      value: registryPresentValue(rec),
      confidence: rec.confidence,
      source: "registry",
      sourceKind: "public_registry",
      asOf: rec.sourceFetchedAt.toISOString(),
      axisCompleteness: "partial",
      note: registrySourceLabel(rec.source),
    });
  }
  if (certLabels.length > 0) {
    const labels = [...new Set(certLabels)];
    const result: ConnectorResult = {
      ok: true,
      value: labels.join(", "),
      confidence: 0.55,
      source: "registry",
      sourceKind: "public_registry",
      asOf: certificationAsOf,
      axisCompleteness: "partial",
    };
    results.set("certification", withCertificationProfileUpdates(result, labels, "registry"));
  }

  // 2) known_on_absence — 소스 적재 시 부재도 clear 로 확정.
  for (const cfg of REGISTRY_KNOWN_ON_ABSENCE) {
    if (!loadedKnownSources.has(cfg.source)) continue;
    const hit = matches.find(
      (match) => match.active && match.record.source === cfg.source && match.record.flagOrCert === cfg.flagOrCert,
    );
    if (hit) {
      const until = hit.record.validUntil;
      results.set(cfg.fieldKey, {
        ok: true,
        value: `참여제한 있음${until ? ` (~${formatIsoDate(until)})` : " (무기한)"}`,
        confidence: hit.record.confidence,
        source: "registry",
        sourceKind: "public_registry",
        asOf: hit.record.sourceFetchedAt.toISOString(),
        axisCompleteness: "partial",
        note: cfg.label,
      });
      const flag = cfg.flagOrCert as DisqualificationFlag;
      sanctionFlags.add(flag);
      sanctionKnownFlags.add(flag);
      sanctionConfidence = Math.min(sanctionConfidence, hit.record.confidence);
      const fetchedAt = hit.record.sourceFetchedAt.toISOString();
      if (sanctionAsOf === null || fetchedAt > sanctionAsOf) sanctionAsOf = fetchedAt;
    } else {
      results.set(cfg.fieldKey, {
        ok: true,
        value: "참여제한 없음(부정당 명단 부재)",
        confidence: 0.9,
        source: "registry",
        sourceKind: "public_registry",
        axisCompleteness: "partial",
        note: cfg.label,
      });
      sanctionKnownFlags.add(cfg.flagOrCert as DisqualificationFlag);
      sanctionConfidence = Math.min(sanctionConfidence, 0.9);
    }
  }
  if (sanctionKnownFlags.size > 0) {
    const result: ConnectorResult = {
      ok: true,
      value: sanctionFlags.size > 0
        ? [...sanctionFlags].map((flag) => DISQUALIFICATION_FLAG_LABELS[flag]).join(", ")
        : "조회한 제재 명단 해당 없음",
      confidence: sanctionConfidence,
      source: "registry",
      sourceKind: "public_registry",
      asOf: sanctionAsOf,
      axisCompleteness: "partial",
    };
    results.set("sanction", withDisqualificationProfileUpdate(result, "sanction", {
      flags: [...sanctionFlags],
      known_flags: [...sanctionKnownFlags],
      exceptions: [],
    }, "registry"));
  }
  if (tipsBacked) {
    const result: ConnectorResult = {
      ok: true,
      value: "TIPS 선정",
      confidence: investmentConfidence,
      source: "registry",
      sourceKind: "public_registry",
      asOf: investmentAsOf,
      axisCompleteness: "partial",
    };
    results.set("investment", withInvestmentProfileUpdate(result, { tips_backed: true }, "registry"));
  }
}

/** present_only 매칭의 표시값(유효기간이 있으면 덧붙임). */
function registryPresentValue(rec: {
  flagOrCert: string;
  validUntil: Date | null;
}): string {
  const base = DISQUALIFICATION_FLAG_LABELS[rec.flagOrCert as DisqualificationFlag] ?? "명단 등재";
  if (rec.validUntil) return `${base} (~${formatIsoDate(rec.validUntil)})`;
  return base;
}

/** source 식별자(data.go.kr:15137996)를 짧은 라벨로. */
function registrySourceLabel(source: string): string {
  return source.replace(/^data\.go\.kr:/, "").trim() || source;
}

/** Date → YYYY-MM-DD. */
function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** kcomwel 고용·산재(15059256) → employees · insured_workforce.employment_insurance_active. */
async function runKcomwelConnector(
  bizNo: string,
  results: Map<string, ConnectorResult>,
): Promise<void> {
  const serviceKey = resolveDataGoKrServiceKey("CUNOTE_KCOMWEL_SERVICE_KEY");
  if (!serviceKey) return; // 키 없음 → pending 유지
  const employeesKey = "employees";
  const insuredKey = "insured_workforce.employment_insurance_active";
  const checkedAt = new Date().toISOString();
  try {
    const summary = await checkKcomwelEmployment({ serviceKey, bizNo, kind: "employment" });
    if (!summary) {
      const empty: ConnectorResult = {
        ok: false,
        empty: true,
        reason: "고용보험 가입 사업장 없음",
        source: "kcomwel",
        sourceKind: "authoritative_api",
        asOf: checkedAt,
      };
      results.set(employeesKey, empty);
      results.set(insuredKey, empty);
      return;
    }
    if (typeof summary.totalWorkers === "number") {
      const result: ConnectorResult = {
        ok: true,
        value: `${summary.totalWorkers.toLocaleString("ko-KR")}명${summary.siteCount > 1 ? ` (${summary.siteCount}개 사업장)` : ""}`,
        confidence: 0.7,
        source: "kcomwel",
        sourceKind: "authoritative_api",
        asOf: checkedAt,
        axisCompleteness: "complete",
      };
      results.set(
        employeesKey,
        withEmployeesProfileUpdate(result, summary.totalWorkers, "kcomwel"),
      );
    } else {
      results.set(employeesKey, {
        ok: false,
        empty: true,
        reason: "상시인원 미제공",
        source: "kcomwel",
        sourceKind: "authoritative_api",
        asOf: checkedAt,
      });
    }
    const seongrip = summary.earliestSeongripDt
      ? `${summary.earliestSeongripDt.slice(0, 4)}-${summary.earliestSeongripDt.slice(4, 6)}-${summary.earliestSeongripDt.slice(6, 8)}`
      : null;
    const insuredResult: ConnectorResult = {
      ok: true,
      value: summary.insuranceActive ? `성립${seongrip ? ` (${seongrip})` : ""}` : "미성립",
      confidence: 0.7,
      source: "kcomwel",
      sourceKind: "authoritative_api",
      asOf: checkedAt,
      axisCompleteness: "partial",
    };
    results.set(
      insuredKey,
      withInsuredWorkforceProfileUpdates(
        insuredResult,
        { employment_insurance_active: summary.insuranceActive },
        "kcomwel",
      ),
    );
  } catch (error) {
    const failed: ConnectorResult = {
      ok: false,
      reason: connectorErrorReason(error),
      source: "kcomwel",
      sourceKind: "authoritative_api",
      asOf: checkedAt,
    };
    results.set(employeesKey, failed);
    results.set(insuredKey, failed);
  }
}

const FSC_CORP_FIELD_KEYS = [
  "revenue",
  "financial_health",
  "financial_health.debt_ratio_pct",
  "financial_health.impairment",
  "financial_health.total_assets_krw",
  "financial_health.equity_krw",
  "financial_health.capital_krw",
  "financial_health.fiscal_year",
] as const;

const DART_OVERLAY_FIELD_KEYS = [
  "employees",
  ...FSC_CORP_FIELD_KEYS,
] as const;

/** OpenDART 직원·주요계정 → 사업보고서 스냅샷. bridge miss면 상세 API를 호출하지 않는다. */
async function runDartOverlayConnector(
  input: { bizNo: string; subject: SubjectType; profile: CompanyProfile | null },
  results: Map<string, ConnectorResult>,
  dart: DartBridgeResolution,
): Promise<void> {
  if (input.subject !== "corporation") return;
  const apiKey = process.env.OPENDART_API_KEY?.trim();
  if (!apiKey) return;
  if (dart.lookup?.state !== "covered" || !dart.lookup.bridge) {
    if (!dart.error) return;
    const failed: ConnectorResult = {
      ok: false,
      reason: `OpenDART 브리지 오류 · ${dart.error}`,
      source: "dart",
      sourceKind: "authoritative_api",
      asOf: new Date().toISOString(),
    };
    for (const key of DART_OVERLAY_FIELD_KEYS) results.set(key, failed);
    return;
  }

  const lookup = await resolveLatestDartOverlay({
    apiKey,
    bizNo: input.bizNo,
    bridge: dart.lookup.bridge,
    cache: getServiceRepositories().enrichmentCache,
  });
  const reportLabel = dartReportLabel(lookup.reportCode);
  const employeeOrigin = lookup.employeeOrigin;
  const financialOrigin = lookup.financialOrigin;

  if (lookup.employee) {
    const employee = lookup.employee;
    if (employee.totalEmployees !== null) {
      const result: ConnectorResult = {
        ok: true,
        value: `${employee.totalEmployees.toLocaleString("ko-KR")}명`,
        confidence: 0.85,
        source: "dart",
        sourceKind: "authoritative_api",
        origin: employeeOrigin,
        asOf: employee.settlementDate,
        axisCompleteness: "complete",
        note: `OpenDART ${lookup.businessYear} ${reportLabel} 직원 현황`,
      };
      results.set(
        "employees",
        withEmployeesProfileUpdate(result, employee.totalEmployees, "dart"),
      );
    } else {
      results.set("employees", dartEmptyResult(`OpenDART ${lookup.businessYear} ${reportLabel} 직원 수 미제공`, employeeOrigin));
    }
  } else if (lookup.employeeError) {
    results.set("employees", dartErrorResult(lookup.employeeError));
  } else {
    results.set("employees", dartEmptyResult(`OpenDART ${lookup.businessYear} ${reportLabel} 직원 현황 없음`, employeeOrigin));
  }

  const finance = selectDartFinancialSnapshot(lookup.financials);
  if (finance) {
    writeDartFinancialResults(results, finance, reportLabel, financialOrigin);
  } else if (lookup.financialError) {
    const failed = dartErrorResult(lookup.financialError);
    for (const key of FSC_CORP_FIELD_KEYS) results.set(key, failed);
  } else {
    const empty = dartEmptyResult(`OpenDART ${lookup.businessYear} ${reportLabel} 주요계정 없음`, financialOrigin);
    for (const key of FSC_CORP_FIELD_KEYS) results.set(key, empty);
  }
}

function selectDartFinancialSnapshot(financials: DartFinancialSnapshot[]): DartFinancialSnapshot | null {
  return financials.find((snapshot) => snapshot.statementType === "CFS")
    ?? financials.find((snapshot) => snapshot.statementType === "OFS")
    ?? null;
}

export function writeDartFinancialResults(
  results: Map<string, ConnectorResult>,
  snapshot: DartFinancialSnapshot,
  reportLabel: string,
  origin: ServiceDataTraceOrigin,
): void {
  const statementLabel = snapshot.statementType === "CFS" ? "연결" : "별도";
  const note = `OpenDART ${snapshot.businessYear} ${reportLabel} · ${statementLabel}재무제표`;
  const common = {
    confidence: 0.9,
    source: "dart" as const,
    sourceKind: "authoritative_api" as const,
    origin,
    asOf: snapshot.periodEnd,
    axisCompleteness: "complete" as const,
    note,
  };
  setDartNumericField(results, "revenue", snapshot.revenue, common);
  setDartNumericField(results, "financial_health.total_assets_krw", snapshot.totalAssets, common);
  setDartNumericField(results, "financial_health.equity_krw", snapshot.totalEquity, common);
  results.set("financial_health.capital_krw", {
    ...common,
    ok: false,
    empty: true,
    reason: "OpenDART 주요계정 자본금 미제공",
  });
  results.set("financial_health.fiscal_year", {
    ...common,
    ok: true,
    value: snapshot.businessYear,
  });

  const debtRatio = snapshot.totalLiabilities !== null && snapshot.totalEquity !== null && snapshot.totalEquity !== 0
    ? Math.round((snapshot.totalLiabilities / snapshot.totalEquity) * 1_000) / 10
    : null;
  results.set("financial_health.debt_ratio_pct", debtRatio === null
    ? { ...common, ok: false, empty: true, reason: "OpenDART 부채비율 계산 필드 미제공" }
    : { ...common, ok: true, value: `${debtRatio.toLocaleString("ko-KR")}%` });
  results.set("financial_health.impairment", snapshot.totalEquity === null
    ? { ...common, ok: false, empty: true, reason: "OpenDART 자본총계 미제공" }
    : {
        ...common,
        ok: true,
        value: snapshot.totalEquity <= 0
          ? "완전자본잠식"
          : "자본금 미제공 · 부분자본잠식 판정 불가",
      });
  const financialResult: ConnectorResult = {
    ...common,
    ok: true,
    value: `${snapshot.businessYear} ${statementLabel}재무 · 자본금 미제공`,
    axisCompleteness: "partial",
  };
  results.set(
    "financial_health",
    withFinancialHealthProfileUpdate(
      financialResult,
      {
        ...(debtRatio !== null && debtRatio >= 0 ? { debt_ratio_pct: debtRatio } : {}),
        ...(snapshot.totalAssets !== null ? { total_assets_krw: snapshot.totalAssets } : {}),
        ...(snapshot.totalEquity !== null ? { equity_krw: snapshot.totalEquity } : {}),
        ...(snapshot.totalEquity !== null && snapshot.totalEquity <= 0 ? { impairment: "full" as const } : {}),
        fiscal_year: snapshot.businessYear,
      },
      "dart",
    ),
  );
}

function setDartNumericField(
  results: Map<string, ConnectorResult>,
  key: string,
  amount: number | null,
  common: Pick<ConnectorResult, "confidence" | "source" | "sourceKind" | "origin" | "asOf" | "axisCompleteness" | "note">,
): void {
  const value = formatKrwCompact(amount);
  if (value === null || amount === null) {
    results.set(key, { ...common, ok: false, empty: true, reason: "OpenDART 값 미제공" });
    return;
  }
  const result: ConnectorResult = { ...common, ok: true, value };
  results.set(key, key === "revenue" ? withRevenueProfileUpdate(result, amount, "dart") : result);
}

function dartEmptyResult(reason: string, origin: ServiceDataTraceOrigin): ConnectorResult {
  return {
    ok: false,
    empty: true,
    reason,
    source: "dart",
    sourceKind: "authoritative_api",
    origin,
  };
}

function dartErrorResult(reason: string): ConnectorResult {
  return {
    ok: false,
    reason,
    source: "dart",
    sourceKind: "authoritative_api",
    asOf: new Date().toISOString(),
  };
}

function dartReportLabel(reportCode: string): string {
  if (reportCode === "11013") return "1분기보고서";
  if (reportCode === "11012") return "반기보고서";
  if (reportCode === "11014") return "3분기보고서";
  return "사업보고서";
}

/** 금융위 기업재무(15043459) → revenue · financial_health.*. 법인 && 법인등록번호 브리지 필요. */
async function runFscCorpFinanceConnector(
  input: { bizNo: string; subject: SubjectType; profile: CompanyProfile | null },
  results: Map<string, ConnectorResult>,
  dart: DartBridgeResolution = { lookup: null, error: null },
): Promise<void> {
  if (input.subject !== "corporation") return; // 법인 전용
  const serviceKey = resolveDataGoKrServiceKey("CUNOTE_FSC_FINANCE_SERVICE_KEY");
  if (!serviceKey) return; // 키 없음 → pending 유지

  const profileCorpRegNo = extractCorpRegNo(input.profile);
  const dartCorpRegNo = dart.lookup?.state === "covered"
    ? dart.lookup.bridge?.corporateRegistrationNumber ?? null
    : null;
  const corpRegNo = profileCorpRegNo ?? dartCorpRegNo;
  if (!corpRegNo) {
    // 법인등록번호 없음 → skip(pending 유지). 팝빌 경로엔 법인번호가 없어 apick 조회 시에만 채워진다.
    const skipped: ConnectorResult = {
      ok: false,
      skipped: true,
      reason:
        dart.error
          ? `OpenDART 브리지 오류 · ${dart.error}`
          : dart.lookup?.state === "not_covered"
            ? `${dart.lookup.reason} · not_covered`
            : "법인등록번호 없음 · apick 또는 OpenDART 브리지 필요",
      source: "fsc",
      sourceKind: "authoritative_api",
    };
    for (const key of FSC_CORP_FIELD_KEYS) results.set(key, skipped);
    return;
  }

  try {
    const checkedAt = new Date().toISOString();
    const summary = await checkFscCorpFinance({ serviceKey, corpRegNo });
    if (!summary) {
      const empty: ConnectorResult = {
        ok: false,
        empty: true,
        reason: "금융위 재무 데이터 없음(crno 미등재)",
        source: "fsc",
        sourceKind: "authoritative_api",
        asOf: checkedAt,
      };
      for (const key of FSC_CORP_FIELD_KEYS) results.set(key, empty);
      return;
    }
    writeFscFinancialResults(results, summary, checkedAt);
    if (dartCorpRegNo) {
      for (const key of FSC_CORP_FIELD_KEYS) {
        const result = results.get(key);
        if (result?.ok) {
          results.set(key, { ...result, note: `법인번호 브리지: OpenDART ${dart.lookup?.origin ?? "live"}` });
        }
      }
    }
  } catch (error) {
    const failed: ConnectorResult = {
      ok: false,
      reason: connectorErrorReason(error),
      source: "fsc",
      sourceKind: "authoritative_api",
      asOf: new Date().toISOString(),
    };
    for (const key of FSC_CORP_FIELD_KEYS) results.set(key, failed);
  }
}

/** 금융위 요약 응답에서 표시행과 실제 financial_health typed update를 함께 만드는 순수 경계. */
export function writeFscFinancialResults(
  results: Map<string, ConnectorResult>,
  summary: NonNullable<Awaited<ReturnType<typeof checkFscCorpFinance>>>,
  checkedAt: string,
): void {
  const yearTag = summary.bizYear ? ` (${summary.bizYear})` : "";
  const asOf = compactDateToIso(summary.basDt) ?? (summary.bizYear ? `${summary.bizYear}-12-31` : checkedAt);
  setNumericField(
    results,
    "revenue",
    formatKrwCompact(summary.saleAmt),
    0.85,
    yearTag,
    asOf,
    summary.saleAmt,
  );
  setNumericField(
    results,
    "financial_health.debt_ratio_pct",
    summary.debtRatioPct !== null ? `${summary.debtRatioPct.toLocaleString("ko-KR")}%` : null,
    0.85,
    yearTag,
    asOf,
  );
  const impairment = deriveFinancialImpairment(summary.totalEquity, summary.capital);
  results.set("financial_health.impairment", {
    ok: true,
    value: `${impairment === "full"
      ? "완전자본잠식"
      : impairment === "partial"
        ? "부분자본잠식"
        : impairment === "none"
          ? "정상"
          : summary.totalEquity === null
            ? "자본총계 미제공 · 부분자본잠식 판정 불가"
            : "자본금 미제공 · 부분자본잠식 판정 불가"}${yearTag}`,
    confidence: 0.85,
    source: "fsc",
    sourceKind: "authoritative_api",
    asOf,
  });
  setNumericField(results, "financial_health.total_assets_krw", formatKrwCompact(summary.totalAssets), 0.85, yearTag, asOf);
  setNumericField(results, "financial_health.equity_krw", formatKrwCompact(summary.totalEquity), 0.85, yearTag, asOf);
  setNumericField(results, "financial_health.capital_krw", formatKrwCompact(summary.capital), 0.85, yearTag, asOf);
  results.set("financial_health.fiscal_year", {
    ok: true,
    value: summary.bizYear ?? "기준연도 미상",
    confidence: 0.85,
    source: "fsc",
    sourceKind: "authoritative_api",
    asOf,
    axisCompleteness: "partial",
  });
  const financialResult: ConnectorResult = {
    ok: true,
    value: `${summary.bizYear ?? "기준연도 미상"} 재무 · ${impairment === null ? "부분잠식 판정 미완료" : "잠식 판정 가능"}`,
    confidence: 0.85,
    source: "fsc",
    sourceKind: "authoritative_api",
    asOf,
    axisCompleteness: "partial",
  };
  results.set(
    "financial_health",
    withFinancialHealthProfileUpdate(
      financialResult,
      {
        ...(summary.debtRatioPct !== null && summary.debtRatioPct >= 0
          ? { debt_ratio_pct: summary.debtRatioPct }
          : {}),
        ...(summary.totalAssets !== null ? { total_assets_krw: summary.totalAssets } : {}),
        ...(summary.totalEquity !== null ? { equity_krw: summary.totalEquity } : {}),
        ...(summary.capital !== null ? { capital_krw: summary.capital } : {}),
        ...(impairment !== null ? { impairment } : {}),
        ...(summary.bizYear ? { fiscal_year: summary.bizYear } : {}),
      },
      "fsc",
    ),
  );
}

function deriveFinancialImpairment(
  equity: number | null,
  capital: number | null,
): "none" | "partial" | "full" | null {
  if (equity === null) return null;
  if (equity <= 0) return "full";
  if (capital === null) return null;
  return equity < capital ? "partial" : "none";
}

/** 값이 있으면 live, 없으면 empty(failed)로 세팅. */
export function setNumericField(
  results: Map<string, ConnectorResult>,
  key: string,
  value: string | null,
  confidence: number,
  yearTag: string,
  asOf: string,
  profileValue?: number | null,
): void {
  if (value === null) {
    results.set(key, {
      ok: false,
      empty: true,
      reason: "값 미제공",
      source: "fsc",
      sourceKind: "authoritative_api",
      asOf,
    });
    return;
  }
  const result: ConnectorResult = {
    ok: true,
    value: `${value}${yearTag}`,
    confidence,
    source: "fsc",
    sourceKind: "authoritative_api",
    asOf,
    ...(key === "revenue" ? { axisCompleteness: "complete" as const } : {}),
  };
  results.set(
    key,
    key === "revenue" && profileValue !== undefined
      ? withRevenueProfileUpdate(result, profileValue, "fsc")
      : result,
  );
}

function compactDateToIso(value: string | null | undefined): string | null {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

/**
 * 금융위 개인사업자재무(15108171) → revenue(개인).
 * 실측 반증: 익명 집계셋이라 사업자번호 조회 불가 → schemaMismatch(failed)로 사실을 노출.
 */
async function runFscPersonalFinanceConnector(
  input: { bizNo: string; subject: SubjectType },
  results: Map<string, ConnectorResult>,
): Promise<void> {
  if (input.subject !== "individual") return; // 개인사업자 전용
  const serviceKey = resolveDataGoKrServiceKey("CUNOTE_FSC_FINANCE_SERVICE_KEY");
  if (!serviceKey) return; // 키 없음 → pending 유지
  const checkedAt = new Date().toISOString();
  try {
    const classification = await checkFscPersonalFinance({ serviceKey, bizNo: input.bizNo });
    if (classification.kind === "aggregate") {
      results.set("revenue", {
        ok: false,
        schemaMismatch: true,
        reason: `익명 집계셋(전체 ${classification.totalCount?.toLocaleString("ko-KR") ?? "?"}건) · 사업자번호 조회 불가`,
        source: "fsc",
        sourceKind: "authoritative_api",
        asOf: checkedAt,
      });
    } else {
      results.set("revenue", {
        ok: false,
        empty: true,
        reason: "응답 없음",
        source: "fsc",
        sourceKind: "authoritative_api",
        asOf: checkedAt,
      });
    }
  } catch (error) {
    results.set("revenue", {
      ok: false,
      reason: connectorErrorReason(error),
      source: "fsc",
      sourceKind: "authoritative_api",
      asOf: checkedAt,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NICE BizAPI(OpenGate) 커넥터(dev 전용, 무계약 데모앱). 법인만 실행.
// OCOV06 재무 → revenue · financial_health.*, OCCD03 → 신용/납세 결격, OCCD06 → 법정관리/워크아웃.
// OCCD01(당좌정지)은 테스트앱 미프로비저닝(403) → bond_default 는 skip(pending). 모든 live 값에
// "NICE 데모앱(무계약)" 표식을 실어 화면에서 데모임을 드러낸다.
// 주의: OCOV06 는 FSC 기업재무와 같은 revenue·financial_health.* 키를 채운다(둘 다 corporation 에서
// 실행). FSC 는 법인등록번호 브리지가 있을 때만 값을 채우고 없으면 skip 하므로, 팝빌 경로(브리지 없음)
// 에서는 NICE 가 채운다. 브리지가 있으면 두 커넥터가 같은 키에 경합할 수 있다(Promise.all 완료 순서 의존).
// ─────────────────────────────────────────────────────────────────────────────

const NICE_DEMO_NOTE = "NICE 데모앱(무계약)";

const NICE_INDICATOR_FIELD_KEYS = [
  "revenue",
  "financial_health",
  "financial_health.total_assets_krw",
  "financial_health.equity_krw",
  "financial_health.capital_krw",
  "financial_health.debt_ratio_pct",
  "financial_health.impairment",
  "financial_health.fiscal_year",
] as const;

const NICE_NEGATIVE_FIELD_KEYS = [
  "credit_status.credit_delinquency",
  "credit_status.loan_default",
  "credit_status.financial_misconduct",
  "tax_compliance.national_tax_delinquent",
  "tax_compliance.local_tax_delinquent",
] as const;

const NICE_WORKOUT_FIELD_KEYS = [
  "credit_status.rehabilitation_in_progress",
  "credit_status.court_receivership",
] as const;

/**
 * NICE BizAPI 커넥터. subject=corporation 일 때만 실행(개인은 결과 없음 → pending/n-a 유지).
 * fail-open: 최후 try/catch 로 절대 throw 하지 않는다. 키(APP_KEY/SECRET) 둘 다 없으면 무결과 return.
 */
async function runNiceConnector(
  input: { bizNo: string; subject: SubjectType; profile: CompanyProfile | null },
  results: Map<string, ConnectorResult>,
): Promise<void> {
  try {
    if (input.subject !== "corporation") return; // 법인 전용(재무/신용 결격은 corpOnly)
    const appKey = process.env.NICE_BIZ_CLIENT_APP_KEY?.trim();
    const secret = process.env.NICE_BIZ_CLIENT_SECRET?.trim();
    if (!appKey || !secret) return; // 키 없음 → pending 유지
    const companyKey = input.bizNo.replace(/\D/g, "");

    // OCOV06 재무(독립 try) → revenue · financial_health.*
    try {
      const indicator = await checkNiceCorpIndicator({ appKey, secret, companyKey });
      setNiceIndicatorFields(results, indicator);
    } catch (error) {
      const failed: ConnectorResult = niceResultMeta({ ok: false, reason: connectorErrorReason(error) });
      for (const key of NICE_INDICATOR_FIELD_KEYS) results.set(key, failed);
    }

    // OCCD03/06/01 신용(오케스트레이터가 내부 guard, throw 안 함) → 신용/납세 결격
    const credit = await checkNiceCorpCredit({ appKey, secret, companyKey });
    setNiceCreditFields(results, credit);

    // OCCD01 당좌정지 미프로비저닝 → bond_default 는 skip(pending 유지).
    results.set("credit_status.bond_default", {
      ok: false,
      skipped: true,
      reason: "OCCD01 당좌정지 미프로비저닝(테스트앱)",
      source: "nice",
      sourceKind: "authoritative_api",
    });
    // 파산은 OCCD06 법정관리와 별개축 · 공공정보(OCCD03 PB)로도 재확인 필요 → 미매핑(pending).
    results.set("credit_status.bankruptcy_filed", {
      ok: false,
      skipped: true,
      reason: "파산은 OCCD06 법정관리와 별개 · 공공정보(OCCD03 PB) 재확인 필요",
      source: "nice",
      sourceKind: "authoritative_api",
    });
  } catch {
    // 최후 안전망 — 절대 throw 금지(runExternalConnectors Promise.all 보호).
  }
}

/** OCOV06 요약을 revenue · financial_health.* 로 매핑(금액은 압축 표기, 연도태그·데모표식 부착). */
export function setNiceIndicatorFields(
  results: Map<string, ConnectorResult>,
  summary: Awaited<ReturnType<typeof checkNiceCorpIndicator>>,
): void {
  if (!summary) {
    const empty: ConnectorResult = niceResultMeta({ ok: false, empty: true, reason: "NICE 재무 데이터 없음" });
    for (const key of NICE_INDICATOR_FIELD_KEYS) results.set(key, empty);
    return;
  }
  const yearTag = summary.bizYear ? ` (${summary.bizYear})` : "";
  const asOf = summary.bizYear ? `${summary.bizYear}-12-31` : new Date().toISOString();
  setNiceNumericField(
    results,
    "revenue",
    formatKrwCompact(summary.revenueWon),
    yearTag,
    asOf,
    summary.revenueWon,
  );
  setNiceNumericField(
    results,
    "financial_health.total_assets_krw",
    formatKrwCompact(summary.totalAssetsWon),
    yearTag,
    asOf,
  );
  setNiceNumericField(
    results,
    "financial_health.equity_krw",
    formatKrwCompact(summary.totalEquityWon),
    yearTag,
    asOf,
  );
  setNiceNumericField(
    results,
    "financial_health.debt_ratio_pct",
    summary.debtRatioPct !== null ? `${summary.debtRatioPct.toLocaleString("ko-KR")}%` : null,
    yearTag,
    asOf,
  );
  results.set("financial_health.capital_krw", niceResultMeta({
    ok: false,
    empty: true,
    reason: "NICE OCOV06 자본금 미제공",
    asOf,
  }));
  results.set("financial_health.fiscal_year", niceResultMeta({
    ok: true,
    value: summary.bizYear ?? "기준연도 미상",
    confidence: 0.75,
    asOf,
    axisCompleteness: "partial",
  }));
  results.set("financial_health.impairment", {
    ok: true,
    value: `${summary.totalEquityWon !== null && summary.totalEquityWon <= 0
      ? "완전자본잠식"
      : summary.totalEquityWon === null
        ? "자본총계 미제공 · 부분자본잠식 판정 불가"
        : "자본금 미제공 · 부분자본잠식 판정 불가"}${yearTag}`,
    confidence: 0.75,
    source: "nice",
    sourceKind: "authoritative_api",
    note: NICE_DEMO_NOTE,
    asOf,
  });
  const financialResult = niceResultMeta({
    ok: true,
    value: `${summary.bizYear ?? "기준연도 미상"} 재무 · 자본금 미제공`,
    confidence: 0.75,
    asOf,
    axisCompleteness: "partial",
  });
  results.set(
    "financial_health",
    withFinancialHealthProfileUpdate(
      financialResult,
      {
        ...(summary.debtRatioPct !== null ? { debt_ratio_pct: summary.debtRatioPct } : {}),
        ...(summary.totalAssetsWon !== null ? { total_assets_krw: summary.totalAssetsWon } : {}),
        ...(summary.totalEquityWon !== null ? { equity_krw: summary.totalEquityWon } : {}),
        ...(summary.totalEquityWon !== null && summary.totalEquityWon <= 0 ? { impairment: "full" as const } : {}),
        ...(summary.bizYear ? { fiscal_year: summary.bizYear } : {}),
      },
      "nice",
    ),
  );
}

/** OCOV06 수치 필드: 값 있으면 live(nice, 0.75, 데모표식), 없으면 empty(failed). */
function setNiceNumericField(
  results: Map<string, ConnectorResult>,
  key: string,
  value: string | null,
  yearTag: string,
  asOf: string,
  profileValue?: number | null,
): void {
  if (value === null) {
    results.set(key, niceResultMeta({ ok: false, empty: true, reason: "값 미제공", asOf }));
    return;
  }
  const result = niceResultMeta({
    ok: true,
    value: `${value}${yearTag}`,
    confidence: 0.75,
    asOf,
  });
  results.set(
    key,
    key === "revenue" && profileValue !== undefined
      ? withRevenueProfileUpdate(result, profileValue, "nice")
      : result,
  );
}

function niceResultMeta(result: ConnectorResult): ConnectorResult {
  return {
    ...result,
    source: "nice",
    sourceKind: "authoritative_api",
    asOf: result.asOf ?? new Date().toISOString(),
    note: result.note ?? NICE_DEMO_NOTE,
  };
}

/** OCCD03(신용/납세 결격) · OCCD06(법정관리/워크아웃) 결과를 필드 키로 매핑. */
export function setNiceCreditFields(
  results: Map<string, ConnectorResult>,
  credit: Awaited<ReturnType<typeof checkNiceCorpCredit>>,
): void {
  const creditFlags: DisqualificationFlag[] = [];
  const creditKnown: DisqualificationFlag[] = [];
  const taxFlags: DisqualificationFlag[] = [];
  const taxKnown: DisqualificationFlag[] = [];
  // OCCD03 신용도판단정보 → 신용/납세 결격.
  const neg = credit.negative;
  if (!neg.ok || !neg.data) {
    const failed: ConnectorResult = niceResultMeta({ ok: false, reason: neg.error ?? "OCCD03 조회 실패" });
    for (const key of NICE_NEGATIVE_FIELD_KEYS) results.set(key, failed);
  } else {
    const c = neg.data.counts;
    const live = (value: string): ConnectorResult => niceResultMeta({
      ok: true,
      value,
      confidence: 0.7,
    });
    // 채무불이행(BB) — credit_delinquency 와 loan_default 동일신호(대지급/대위변제 포함).
    const bbValue = c.bb > 0 ? `채무불이행 ${c.bb}건` : "해당없음";
    results.set("credit_status.credit_delinquency", live(bbValue));
    results.set("credit_status.loan_default", live(bbValue));
    creditKnown.push("credit_delinquency", "loan_default");
    if (c.bb > 0) creditFlags.push("credit_delinquency", "loan_default");
    // 금융질서문란(FD).
    results.set(
      "credit_status.financial_misconduct",
      live(c.fd > 0 ? `금융질서문란 ${c.fd}건` : "해당없음"),
    );
    creditKnown.push("financial_misconduct");
    if (c.fd > 0) creditFlags.push("financial_misconduct");
    // 공공정보(PB) — 국세/지방세 미분리 집계. 양수는 정확한 flag를 알 수 없어 표시만 남기고
    // typed known/held 승격을 보류한다. 0건은 둘 다 해당없음이므로 두 flag를 known 처리할 수 있다.
    const pbValue = c.pb > 0 ? `공공정보 ${c.pb}건(국세/지방세 미분리)` : "해당없음";
    results.set("tax_compliance.national_tax_delinquent", live(pbValue));
    results.set("tax_compliance.local_tax_delinquent", live(pbValue));
    if (c.pb === 0) taxKnown.push("national_tax_delinquent", "local_tax_delinquent");
  }

  // OCCD06 법정관리/워크아웃 → rehabilitation_in_progress · court_receivership 동일 신호.
  const wk = credit.workout;
  if (!wk.ok || !wk.data) {
    const failed: ConnectorResult = niceResultMeta({ ok: false, reason: wk.error ?? "OCCD06 조회 실패" });
    for (const key of NICE_WORKOUT_FIELD_KEYS) results.set(key, failed);
  } else {
    const n = wk.data.count;
    const value = n > 0 ? `법정관리/워크아웃 ${n}건` : "해당없음";
    for (const key of NICE_WORKOUT_FIELD_KEYS) {
      results.set(key, niceResultMeta({ ok: true, value, confidence: 0.7 }));
    }
    // OCCD06도 회생/법정관리 미분리 집계다. 양수는 표시만 남겨 정확한 flag를 unknown으로
    // 보존하고, 0건일 때만 두 flag를 known 해당없음으로 확정한다.
    if (n === 0) creditKnown.push("rehabilitation_in_progress", "court_receivership");
  }

  if (creditKnown.length > 0) {
    const result = niceResultMeta({
      ok: true,
      value: creditFlags.length > 0
        ? `신용 결격 ${creditFlags.length}개 신호`
        : `신용 결격 ${creditKnown.length}개 항목 해당없음`,
      confidence: 0.7,
      axisCompleteness: "partial",
    });
    results.set(
      "credit_status",
      withDisqualificationProfileUpdate(
        result,
        "credit_status",
        { flags: creditFlags, known_flags: creditKnown, exceptions: [] },
        "nice",
      ),
    );
  }
  if (taxKnown.length > 0) {
    const result = niceResultMeta({
      ok: true,
      value: taxFlags.length > 0
        ? "국세/지방세 미분리 공공정보 신호 있음"
        : "국세/지방세 미분리 공공정보 해당없음",
      confidence: 0.7,
      axisCompleteness: "partial",
    });
    results.set(
      "tax_compliance",
      withDisqualificationProfileUpdate(
        result,
        "tax_compliance",
        { flags: taxFlags, known_flags: taxKnown, exceptions: [] },
        "nice",
      ),
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CODEF 간편인증 캐시 커넥터(dev 전용). 라이브 호출이 아니라 company_enrichment_cache 의
// provider="codef" 행(corporate-registration·vat-base·identity)을 판독한다 — CODEF 는 사용자
// 휴대폰 승인이 선행돼야 하므로 조회 경로에서 능동 호출하지 않는다(passive read). 인증은
// api/dev/codef/* 오케스트레이터가 처리하고 결과를 캐시에 남긴다. 국세청 확정값이라
// buildFieldCoverage 에서 최우선(codef > popbill/apick > derived/자가신고).
// fail-open: 어떤 예외도 밖으로 던지지 않는다(runExternalConnectors Promise.all 보호).
// ─────────────────────────────────────────────────────────────────────────────

const CODEF_CACHE_NOTE = "간편인증 캐시(국세청 확정값)";

/** identity scope canonicalPayload(오케스트레이터 finalizeDone 이 남긴 파생값 · 생년월일 원본 없음). */
interface CodefIdentityCache {
  founder_age?: number | null;
  gender?: "M" | "F" | null;
}

/**
 * company_enrichment_cache 의 provider="codef" 3 scope 를 판독해 국세청 확정 7축을 채운다.
 * 캐시 행이 하나도 없으면(=인증 전) 아무 결과도 넣지 않아 pending 을 유지한다.
 * 값이 없는 축은 스킵해 다른 커넥터/pending 을 침범하지 않는다.
 */
async function runCodefConnector(
  bizNo: string,
  results: Map<string, ConnectorResult>,
): Promise<void> {
  try {
    const rows = await getServiceRepositories().enrichmentCache.listByBizNo(bizNo);
    const byScope = new Map<string, EnrichmentCacheEntry>();
    for (const row of rows) {
      if (row.provider === "codef") byScope.set(row.scope, row);
    }
    const corpRow = byScope.get("corporate-registration");
    const vatRow = byScope.get("vat-base");
    const identityRow = byScope.get("identity");
    if (!corpRow && !vatRow && !identityRow) return; // 인증 전 → pending 유지

    const corpFacts = (corpRow?.canonicalPayload ?? null) as CorporateRegistrationFacts | null;
    const vatFacts = (vatRow?.canonicalPayload ?? null) as VatBaseFacts | null;
    const identity = (identityRow?.canonicalPayload ?? null) as CodefIdentityCache | null;
    const corpAsOf = cacheEntryAsOf(corpRow);
    const vatAsOf = cacheEntryAsOf(vatRow);
    const identityAsOf = cacheEntryAsOf(identityRow);

    // 생년월일 원본은 저장하지 않으므로 birthDate8 없이 파생한다(founder_age 는 identity 캐시 사용).
    const { profile } = buildCompanyProfileFromCodef({
      corporateRegistration: corpFacts,
      vatBase: vatFacts,
      gender: identity?.gender ?? null,
    });

    setCodefField(results, "region", profile.region?.label ?? null, 0.95, corpAsOf, {
      normalize: (result) => buildRegionProfileUpdates(
        profile.region,
        profileMetadata(result, "codef", "complete"),
      ),
    });
    setCodefField(results, "biz_age", formatBizAgeMonths(profile.biz_age_months ?? null), 0.95, corpAsOf, {
      normalize: (result) => buildBizAgeProfileUpdates(
        profile.biz_age_months,
        profileMetadata(result, "codef", "complete"),
      ),
    });
    setCodefField(
      results,
      "industry",
      profile.industries?.length ? profile.industries.join(", ") : null,
      0.95,
      corpAsOf,
      {
        axisCompleteness: "partial",
        normalize: (result) => buildIndustryProfileUpdates({
          labels: profile.industries ?? [],
          codes: profile.industry_codes ?? [],
        }, profileMetadata(result, "codef", "partial")),
      },
    );
    setCodefField(
      results,
      "industry.industry_codes",
      profile.industry_codes?.length ? profile.industry_codes.join(", ") : null,
      0.95,
      corpAsOf,
      { axisCompleteness: "partial" },
    );
    setCodefField(results, "target_type", profile.target_types?.[0] ?? null, 0.95, corpAsOf, {
      axisCompleteness: "partial",
      normalize: (result) => buildTargetTypeProfileUpdates(
        profile.target_types ?? [],
        profileMetadata(result, "codef", "partial"),
      ),
    });
    setCodefField(
      results,
      "target_type.legal_form",
      profile.target_types?.[0] ?? null,
      0.95,
      corpAsOf,
      { axisCompleteness: "partial" },
    );
    // 매출은 부가세 신고분(profile.revenue_krw)이 있을 때만.
    setCodefField(
      results,
      "revenue",
      formatKrwCompact(profile.revenue_krw ?? null),
      0.95,
      vatAsOf,
      {
        normalize: (result) => buildRevenueProfileUpdates(
          profile.revenue_krw,
          profileMetadata(result, "codef", "complete"),
        ),
      },
    );
    // 대표자 연령은 identity 캐시의 founder_age(생년월일 파생 정수)만.
    const founderAge = typeof identity?.founder_age === "number" ? identity.founder_age : null;
    setCodefField(
      results,
      "founder_age",
      founderAge !== null ? `${founderAge}세` : null,
      0.9,
      identityAsOf,
      {
        sourceKind: "auth_supplied",
        normalize: (result) => buildFounderAgeProfileUpdates(
          founderAge,
          profileMetadata(result, "codef", "complete"),
        ),
      },
    );
    // 대표자 특성은 identity 캐시의 gender(여성/남성).
    const traitLabel = identity?.gender === "F" ? "여성" : identity?.gender === "M" ? "남성" : null;
    setCodefField(results, "founder_trait", traitLabel, 0.9, identityAsOf, {
      sourceKind: "auth_supplied",
      axisCompleteness: "partial",
      normalize: (result) => buildFounderTraitProfileUpdates(
        traitLabel ? [traitLabel] : [],
        profileMetadata(result, "codef", "partial"),
      ),
    });
  } catch {
    // fail-open — 캐시 판독 실패는 무시(pending 유지, 다른 커넥터 보호).
  }
}

/** 값이 있으면 codef live 결과로 세팅, 없으면 스킵(다른 소스/pending 유지). */
function setCodefField(
  results: Map<string, ConnectorResult>,
  key: string,
  value: string | null,
  confidence: number,
  asOf: string | null,
  options: {
    sourceKind?: EvidenceSourceKind;
    axisCompleteness?: AxisCompleteness;
    normalize?: (result: ConnectorResult) => DevServiceDataProfileNormalization;
  } = {},
): void {
  if (!value) return;
  const result: ConnectorResult = {
    ok: true,
    value,
    confidence,
    source: "codef",
    sourceKind: options.sourceKind ?? "authoritative_api",
    asOf,
    axisCompleteness: options.axisCompleteness ?? "complete",
    note: CODEF_CACHE_NOTE,
  };
  results.set(key, options.normalize
    ? attachConnectorProfileNormalization(result, options.normalize(result))
    : result);
}

function cacheEntryAsOf(entry: EnrichmentCacheEntry | undefined): string | null {
  return entry?.checkedAt?.toISOString() ?? entry?.fetchedAt.toISOString() ?? null;
}

/** biz_age_months 를 "N년 M개월" 로 표기(0개월·null 방어). */
function formatBizAgeMonths(months: number | null): string | null {
  if (months === null || !Number.isFinite(months) || months < 0) return null;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  if (years > 0 && rem > 0) return `${years}년 ${rem}개월`;
  if (years > 0) return `${years}년`;
  return `${rem}개월`;
}

const DISQUALIFICATION_AXIS_LABELS: Record<DisqualificationAxis, string> = {
  tax_compliance: "납세 결격",
  credit_status: "신용 결격",
  sanction: "제재·명단 결격",
};

const DISQUALIFICATION_AXIS_ORDER: readonly DisqualificationAxis[] = [
  "tax_compliance",
  "credit_status",
  "sanction",
];

/**
 * canonical 사전에서 자가신고 Q&A 스키마를 만든다(서버 전용 · 직렬화 가능).
 * page.tsx(서버 컴포넌트)가 호출해 클라이언트에 props 로 넘긴다.
 */
export function buildQnaSchema(): QnaSchema {
  const byAxis = new Map<DisqualificationAxis, QnaQuestionSchema[]>();
  for (const question of DISQUALIFICATION_QUESTIONS) {
    const flags: QnaFlagSchema[] = question.covers.map((flag) => ({
      flag,
      label: DISQUALIFICATION_FLAG_LABELS[flag],
    }));
    const list = byAxis.get(question.axis) ?? [];
    list.push({ id: question.id, label: question.label, flags });
    byAxis.set(question.axis, list);
  }
  const disqualification: QnaAxisSchema[] = DISQUALIFICATION_AXIS_ORDER.map((axis) => ({
    axis,
    label: DISQUALIFICATION_AXIS_LABELS[axis],
    questions: byAxis.get(axis) ?? [],
  }));
  const exceptions: QnaExceptionSchema[] = DISQUALIFICATION_EXCEPTIONS.map((key) => ({
    key,
    label: DISQUALIFICATION_EXCEPTION_LABELS[key],
    flags: [...EXCEPTION_FLAG_COVERAGE[key]],
  }));
  const definitionIds = Object.fromEntries(
    DEV_QNA_DIMENSIONS.map((dimension) => [dimension, questionDefinitionFor(dimension).id]),
  ) as Record<DevQnaDimension, QuestionDefinitionId>;
  return { definitionIds, disqualification, exceptions };
}
