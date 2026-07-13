import {
  DISQUALIFICATION_FLAGS,
  normalizeCompanyIndustryProfile,
  questionDefinitionFor,
  resolveEvidencePrecedence,
  updateCompanyProfileField,
  type CompanyProfileFieldUpdate,
  type QuestionDefinitionId,
} from "@cunote/core";
import type {
  CompanyProfile,
  CompanyProfileEvidenceObservation,
  CompanyProfileFieldEvidence,
  CompanyProfileEvidenceSourceKind,
  CriterionDimension,
  DisqualificationProfileValue,
  ListProfileDimension,
  PriorAwardProfileValue,
} from "@cunote/contracts";

export interface DevServiceDataProfileMetadata {
  sourceKind: CompanyProfileEvidenceSourceKind;
  provider: string;
  asOf: string | null;
  confidence: number | null;
  axisCompleteness: "partial" | "complete";
}

export interface DevServiceDataNormalizationFailure {
  code: "normalization_failed";
  field: CriterionDimension | "qna";
  message: string;
}

export type DevServiceDataProfileNormalization =
  | { ok: true; profileUpdates: CompanyProfileFieldUpdate[] }
  | { ok: false; failure: DevServiceDataNormalizationFailure };

export interface DevInsuredWorkforceValue {
  employment_insurance_active?: unknown;
  insured_count?: unknown;
  months_since_last_layoff?: unknown;
  no_layoff?: unknown;
}

export interface DevFinancialHealthValue {
  debt_ratio_pct?: unknown;
  impairment?: unknown;
  interest_coverage_ratio?: unknown;
  total_assets_krw?: unknown;
  equity_krw?: unknown;
  capital_krw?: unknown;
  fiscal_year?: unknown;
}

export interface DevInvestmentValue {
  total_raised_krw?: unknown;
  last_round?: unknown;
  tips_backed?: unknown;
}

/** 클라이언트는 production QuestionDefinition id와 직렬화 가능한 답만 보낸다. */
export interface DevQnaAnswerDto {
  scenario: "registered_business" | "preliminary";
  answers: Array<{
    definitionId: QuestionDefinitionId;
    value: unknown;
  }>;
}

export interface DevQnaProfileBuildResult {
  profileUpdates: CompanyProfileFieldUpdate[];
  failures: DevServiceDataNormalizationFailure[];
}

export type DevProfileMergeStage = "connector" | "qna";

export interface DevProfileMergeDecision {
  sequence: number;
  stage: DevProfileMergeStage;
  field: CriterionDimension;
  valueDisposition: "applied" | "merged_supplemental" | "retained";
  evidenceDisposition: "incoming_primary" | "current_primary_incoming_supplemental";
  reason:
    | "no_current_evidence"
    | "completeness"
    | "source_priority"
    | "provider_priority"
    | "same_provider_confidence"
    | "same_provider_freshness"
    | "same_provider_tie"
    | "unknown_provider_tie";
  primaryEvidence: CompanyProfileEvidenceObservation;
  supplementalEvidence: CompanyProfileEvidenceObservation[];
}

export interface DevProfileFieldState {
  field: CriterionDimension;
  sourced: boolean;
  normalized: boolean;
  match_ready: boolean;
  product_consumed: "pending";
}

export interface DevFinalCompanyProfileResult {
  /** Dev-memory-only preview. This value is never persisted by this module. */
  profilePreview: CompanyProfile;
  mergeDecisions: DevProfileMergeDecision[];
  fieldStates: DevProfileFieldState[];
  normalizationFailures: DevServiceDataNormalizationFailure[];
  mergeOrder: readonly ["connector", "qna"];
}

export interface BuildDevFinalCompanyProfileInput {
  baseProfile: CompanyProfile;
  connectorProfileUpdates: readonly CompanyProfileFieldUpdate[];
  connectorSourcedDimensions?: readonly CriterionDimension[];
  connectorNormalizedDimensions?: readonly CriterionDimension[];
  connectorNormalizationFailures?: readonly DevServiceDataNormalizationFailure[];
  qna?: {
    answers: DevQnaAnswerDto;
    /** Explicit replay timestamp. Callers must not hide Date.now() inside this pure merge. */
    asOf: string;
  };
}

const EMPTY_PROFILE: CompanyProfile = { confidence: {} };

/** 원 단위 scalar를 표시 문자열과 분리해 matcher 입력으로 만든다. */
export function buildRevenueProfileUpdates(
  revenueWon: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("revenue", () => [
    validatedUpdate("revenue", nonNegativeInteger(revenueWon, "revenue_krw"), metadata),
  ]);
}

export function buildRegionProfileUpdates(
  region: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("region", () => [validatedUpdate("region", region, metadata)]);
}

export function buildBizAgeProfileUpdates(
  months: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("biz_age", () => [
    validatedUpdate("biz_age", nonNegativeInteger(months, "biz_age_months"), metadata),
  ]);
}

/** KSIC 코드는 update 경계에서 함께 보존하고 profile normalizer가 industry_codes로 분리한다. */
export function buildIndustryProfileUpdates(
  raw: { labels?: readonly unknown[]; codes?: readonly unknown[] },
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("industry", () => {
    const labels = uniqueStrings(raw.labels ?? [], "industry.labels");
    const codes = uniqueStrings(raw.codes ?? [], "industry.codes");
    return listUpdates("industry", [...labels, ...codes], metadata);
  });
}

export function buildEmployeesProfileUpdates(
  employees: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("employees", () => [
    validatedUpdate("employees", nonNegativeInteger(employees, "employees_count"), metadata),
  ]);
}

export function buildFounderAgeProfileUpdates(
  age: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("founder_age", () => [
    validatedUpdate("founder_age", nonNegativeInteger(age, "founder_age"), metadata),
  ]);
}

export function buildFounderTraitProfileUpdates(
  traits: readonly unknown[],
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("founder_trait", () => listUpdates(
    "founder_trait",
    uniqueStrings(traits, "traits"),
    metadata,
  ));
}

/**
 * partial은 positive-only 병합이고, complete만 소진적 목록 교체다.
 * present-only miss(partial + 빈 배열)는 미보유 evidence를 만들지 않는다.
 */
export function buildCertificationProfileUpdates(
  certifications: readonly unknown[],
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("certification", () => {
    const values = uniqueStrings(certifications, "certifications");
    if (values.length === 0 && metadata.axisCompleteness === "partial") return [];
    return [validatedUpdate("certification", values, metadata, {
      mode: metadata.axisCompleteness === "complete" ? "replace" : "merge",
    })];
  });
}

export function buildIpProfileUpdates(
  rightKinds: readonly unknown[],
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("ip", () => listUpdates(
    "ip",
    uniqueStrings(rightKinds, "ip.right_kinds"),
    metadata,
  ));
}

export function buildTargetTypeProfileUpdates(
  targetTypes: readonly unknown[],
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("target_type", () => listUpdates(
    "target_type",
    uniqueStrings(targetTypes, "target_types"),
    metadata,
  ));
}

export function buildDisqualificationProfileUpdates(
  field: "tax_compliance" | "credit_status" | "sanction",
  value: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize(field, () => [validatedUpdate(field, value, metadata)]);
}

export function buildPriorAwardProfileUpdates(
  value: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("prior_award", () => [
    validatedUpdate("prior_award", value, metadata, { mode: "merge" }),
  ]);
}

export function buildFinancialHealthProfileUpdates(
  value: DevFinancialHealthValue,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("financial_health", () => {
    if (!hasDefinedValue(value)) throw new Error("financial_health에 정규화할 값이 없습니다.");
    const update = validatedUpdate("financial_health", value, metadata);
    const normalized = updateCompanyProfileField(EMPTY_PROFILE, update).financial_health;
    if (
      normalized?.impairment !== undefined &&
      typeof normalized.equity_krw === "number" &&
      typeof normalized.capital_krw === "number"
    ) {
      const derived = normalized.equity_krw <= 0
        ? "full"
        : normalized.equity_krw < normalized.capital_krw
          ? "partial"
          : "none";
      if (normalized.impairment !== derived) {
        throw new Error(`자본잠식 ${normalized.impairment} 응답이 자본총계·자본금 파생값 ${derived}와 충돌합니다.`);
      }
    }
    return [update];
  });
}

/** matcher가 읽는 고용보험 nested 계약을 명/개월 정수 단위로 만든다. */
export function buildInsuredWorkforceProfileUpdates(
  raw: DevInsuredWorkforceValue,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("insured_workforce", () => {
    const value: NonNullable<CompanyProfile["insured_workforce"]> = {};
    if (raw.employment_insurance_active !== undefined) {
      value.employment_insurance_active = booleanValue(
        raw.employment_insurance_active,
        "employment_insurance_active",
      );
    }
    if (raw.insured_count !== undefined) {
      value.insured_count = nonNegativeInteger(raw.insured_count, "insured_count");
    }
    if (raw.months_since_last_layoff !== undefined) {
      value.months_since_last_layoff = nonNegativeInteger(
        raw.months_since_last_layoff,
        "months_since_last_layoff",
      );
    }
    if (raw.no_layoff !== undefined) {
      value.no_layoff = booleanValue(raw.no_layoff, "no_layoff");
    }
    if (Object.keys(value).length === 0) {
      throw new Error("insured_workforce에 정규화할 값이 없습니다.");
    }
    if (value.no_layoff === true && value.months_since_last_layoff !== undefined) {
      throw new Error("감원 없음과 최근 감원 경과개월을 동시에 확정할 수 없습니다.");
    }
    return [validatedUpdate("insured_workforce", value, metadata)];
  });
}

export function buildInvestmentProfileUpdates(
  value: DevInvestmentValue,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  return normalize("investment", () => {
    if (!hasDefinedValue(value)) throw new Error("investment에 정규화할 값이 없습니다.");
    return [validatedUpdate("investment", value, metadata)];
  });
}

export const DEV_QNA_DIMENSIONS = [
  "industry",
  "employees",
  "revenue",
  "founder_age",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
  "tax_compliance",
  "credit_status",
  "sanction",
  "financial_health",
  "insured_workforce",
  "investment",
] as const satisfies readonly CriterionDimension[];
export type DevQnaDimension = (typeof DEV_QNA_DIMENSIONS)[number];

/**
 * dev Q&A의 유일한 typed 경계. production QuestionDefinition id를 해석하고 기존
 * updateCompanyProfileField()로 실제 적용 가능한 update만 반환한다.
 */
export function buildDevQnaProfileUpdates(
  dto: DevQnaAnswerDto,
  options: {
    baseProfile?: CompanyProfile;
    now?: Date;
    /** G3 records a losing self-declared observation instead of dropping it during G2B validation. */
    preserveEvidenceConflicts?: boolean;
  } = {},
): DevQnaProfileBuildResult {
  const failures: DevServiceDataNormalizationFailure[] = [];
  const profileUpdates: CompanyProfileFieldUpdate[] = [];
  let validationProfile = options.baseProfile ?? EMPTY_PROFILE;
  const byDefinitionId = new Map<QuestionDefinitionId, (typeof DEV_QNA_DIMENSIONS)[number]>(
    DEV_QNA_DIMENSIONS.map((dimension) => {
      const definition = questionDefinitionFor(dimension);
      return [definition.id, dimension] as const;
    }),
  );
  const answers = dto.answers.map((answer) => ({ ...answer }));
  if (dto.scenario === "preliminary") {
    const targetTypeDefinitionId = questionDefinitionFor("target_type").id;
    const targetTypeAnswer = answers.find((answer) => answer.definitionId === targetTypeDefinitionId);
    if (targetTypeAnswer && Array.isArray(targetTypeAnswer.value)) {
      targetTypeAnswer.value = [...targetTypeAnswer.value, "예비창업자"];
    } else if (!targetTypeAnswer) {
      answers.push({
        definitionId: targetTypeDefinitionId,
        value: ["예비창업자"],
      });
    }
  }
  const seen = new Set<string>();
  const asOf = (options.now ?? new Date()).toISOString();

  for (const answer of answers) {
    if (seen.has(answer.definitionId)) {
      failures.push(failure("qna", `${answer.definitionId} 답변이 중복되었습니다.`));
      continue;
    }
    seen.add(answer.definitionId);
    const dimension = byDefinitionId.get(answer.definitionId);
    if (!dimension) {
      failures.push(failure("qna", `지원하지 않는 QuestionDefinition id: ${answer.definitionId}`));
      continue;
    }
    const metadata: DevServiceDataProfileMetadata = {
      sourceKind: "self_declared",
      provider: "dev_service_data_qna",
      asOf,
      confidence: 0.6,
      axisCompleteness: qnaCompleteness(dimension, answer.value),
    };
    let normalized: DevServiceDataProfileNormalization;
    try {
      normalized = normalizeQnaAnswer(dimension, answer.value, metadata);
    } catch (error) {
      failures.push(failure(
        dimension,
        error instanceof Error ? error.message.slice(0, 160) : "Q&A 답변 형식 오류",
      ));
      continue;
    }
    if (!normalized.ok) {
      failures.push(normalized.failure);
      continue;
    }
    for (const update of normalized.profileUpdates) {
      try {
        const prepared = prepareQnaUpdate(
          validationProfile,
          update,
          options.preserveEvidenceConflicts === true,
        );
        validationProfile = options.preserveEvidenceConflicts === true
          ? mergeDevProfileUpdate(validationProfile, prepared, "qna").profile
          : normalizeCompanyIndustryProfile(updateCompanyProfileField(validationProfile, prepared));
        profileUpdates.push(prepared);
      } catch (error) {
        failures.push(failure(
          update.field,
          error instanceof Error ? error.message.slice(0, 160) : "Q&A 프로필 값 정규화 실패",
        ));
      }
    }
  }

  return { profileUpdates, failures };
}

function normalizeQnaAnswer(
  dimension: DevQnaDimension,
  value: unknown,
  metadata: DevServiceDataProfileMetadata,
): DevServiceDataProfileNormalization {
  switch (dimension) {
    case "industry": {
      const row = plainRecord(value, "industry");
      return buildIndustryProfileUpdates({
        labels: arrayOrEmpty(row.labels),
        codes: arrayOrEmpty(row.codes),
      }, metadata);
    }
    case "employees":
      return buildEmployeesProfileUpdates(value, metadata);
    case "revenue":
      return buildRevenueProfileUpdates(value, metadata);
    case "founder_age":
      return buildFounderAgeProfileUpdates(value, metadata);
    case "founder_trait":
      return buildFounderTraitProfileUpdates(arrayOrEmpty(value), metadata);
    case "certification":
      return buildCertificationProfileUpdates(arrayOrEmpty(value), metadata);
    case "prior_award":
      return buildPriorAwardProfileUpdates(value, metadata);
    case "ip":
      return buildIpProfileUpdates(arrayOrEmpty(value), metadata);
    case "target_type":
      return buildTargetTypeProfileUpdates(arrayOrEmpty(value), metadata);
    case "tax_compliance":
    case "credit_status":
    case "sanction":
      return buildDisqualificationProfileUpdates(dimension, value, metadata);
    case "financial_health":
      return buildFinancialHealthProfileUpdates(
        plainRecord(value, "financial_health") as DevFinancialHealthValue,
        metadata,
      );
    case "insured_workforce":
      return buildInsuredWorkforceProfileUpdates(
        plainRecord(value, "insured_workforce") as DevInsuredWorkforceValue,
        metadata,
      );
    case "investment":
      return buildInvestmentProfileUpdates(
        plainRecord(value, "investment") as DevInvestmentValue,
        metadata,
      );
  }
}

function normalize(
  field: DevServiceDataNormalizationFailure["field"],
  build: () => CompanyProfileFieldUpdate[],
): DevServiceDataProfileNormalization {
  try {
    return { ok: true, profileUpdates: build() };
  } catch (error) {
    return {
      ok: false,
      failure: failure(
        field,
        error instanceof Error ? error.message.slice(0, 160) : "프로필 값 정규화 실패",
      ),
    };
  }
}

function failure(
  field: DevServiceDataNormalizationFailure["field"],
  message: string,
): DevServiceDataNormalizationFailure {
  return { code: "normalization_failed", field, message };
}

function listUpdates(
  field: "industry" | "founder_trait" | "certification" | "ip" | "target_type",
  values: string[],
  metadata: DevServiceDataProfileMetadata,
): CompanyProfileFieldUpdate[] {
  if (values.length === 0 && metadata.axisCompleteness === "partial") return [];
  return [validatedUpdate(field, values, metadata, {
    mode: metadata.axisCompleteness === "complete" ? "replace" : "merge",
  })];
}

function qnaCompleteness(
  dimension: CriterionDimension,
  value: unknown,
): "partial" | "complete" {
  if (dimension === "tax_compliance" || dimension === "credit_status" || dimension === "sanction") {
    try {
      const update = updateCompanyProfileField(EMPTY_PROFILE, {
        field: dimension,
        value,
        sourceKind: "self_declared",
      });
      const known = new Set(update[dimension]?.known_flags ?? []);
      return DISQUALIFICATION_FLAGS[dimension].every((flag) => known.has(flag))
        ? "complete"
        : "partial";
    } catch {
      return "partial";
    }
  }
  if (
    dimension === "industry" ||
    dimension === "founder_trait" ||
    dimension === "certification" ||
    dimension === "prior_award" ||
    dimension === "ip" ||
    dimension === "target_type" ||
    dimension === "financial_health" ||
    dimension === "insured_workforce" ||
    dimension === "investment"
  ) return "partial";
  return "complete";
}

function prepareQnaUpdate(
  profile: CompanyProfile,
  update: CompanyProfileFieldUpdate,
  preserveEvidenceConflicts = false,
): CompanyProfileFieldUpdate {
  const evidence = profile.profile_evidence?.[update.field];
  const authoritative = evidence?.sourceKind === "authoritative_api" || evidence?.sourceKind === "public_registry";
  if (authoritative && !isSupplementalDimension(update.field)) {
    if (preserveEvidenceConflicts) return update;
    throw new Error(`${update.field}은(는) 권위 원천 primary가 있어 자가신고로 덮어쓸 수 없습니다.`);
  }
  if (isListDimension(update.field)) return { ...update, mode: "merge" };

  const incoming = updateCompanyProfileField(EMPTY_PROFILE, update);
  if (update.field === "tax_compliance" || update.field === "credit_status" || update.field === "sanction") {
    const currentValue = profile[update.field];
    const incomingValue = incoming[update.field];
    return {
      ...update,
      mode: "merge",
      value: mergeDisqualification(currentValue, incomingValue),
    };
  }
  if (update.field === "financial_health") {
    return {
      ...update,
      mode: "merge",
      value: authoritative
        ? { ...(incoming.financial_health ?? {}), ...(profile.financial_health ?? {}) }
        : { ...(profile.financial_health ?? {}), ...(incoming.financial_health ?? {}) },
    };
  }
  if (update.field === "insured_workforce") {
    return {
      ...update,
      mode: "merge",
      value: authoritative
        ? { ...(incoming.insured_workforce ?? {}), ...(profile.insured_workforce ?? {}) }
        : { ...(profile.insured_workforce ?? {}), ...(incoming.insured_workforce ?? {}) },
    };
  }
  if (update.field === "investment") {
    return {
      ...update,
      mode: "merge",
      value: authoritative
        ? { ...(incoming.investment ?? {}), ...(profile.investment ?? {}) }
        : { ...(profile.investment ?? {}), ...(incoming.investment ?? {}) },
    };
  }
  if (update.field === "prior_award") {
    if (!authoritative) return { ...update, mode: "merge" };
    const currentValue = profile.prior_award_history;
    const incomingValue = incoming.prior_award_history;
    return {
      ...update,
      mode: "merge",
      value: mergePriorAward(currentValue, incomingValue),
    };
  }
  return update;
}

function isListDimension(field: CriterionDimension): field is
  | "industry"
  | "founder_trait"
  | "certification"
  | "ip"
  | "target_type" {
  return field === "industry" || field === "founder_trait" || field === "certification" || field === "ip" || field === "target_type";
}

function isSupplementalDimension(field: CriterionDimension): boolean {
  return isListDimension(field) ||
    field === "prior_award" ||
    field === "tax_compliance" ||
    field === "credit_status" ||
    field === "sanction" ||
    field === "financial_health" ||
    field === "insured_workforce" ||
    field === "investment";
}

function mergeDisqualification(
  current: DisqualificationProfileValue | undefined,
  incoming: DisqualificationProfileValue | undefined,
): DisqualificationProfileValue {
  return {
    flags: uniqueStringsValue([...(current?.flags ?? []), ...(incoming?.flags ?? [])]),
    known_flags: uniqueStringsValue([...(current?.known_flags ?? []), ...(incoming?.known_flags ?? [])]),
    exceptions: uniqueStringsValue([...(current?.exceptions ?? []), ...(incoming?.exceptions ?? [])]),
  };
}

function mergePriorAward(
  current: PriorAwardProfileValue | undefined,
  incoming: PriorAwardProfileValue | undefined,
): PriorAwardProfileValue {
  const records = [...(current?.records ?? []), ...(incoming?.records ?? [])];
  return {
    records: [...new Map(records.map((record) => [
      JSON.stringify([record.program ?? null, record.agency ?? null, record.year ?? null, record.state]),
      record,
    ])).values()],
    ...(current?.self_flags || incoming?.self_flags ? {
      self_flags: { ...(incoming?.self_flags ?? {}), ...(current?.self_flags ?? {}) },
    } : {}),
    ...(current?.has_incubation_tenancy !== undefined || incoming?.has_incubation_tenancy !== undefined ? {
      has_incubation_tenancy:
        current?.has_incubation_tenancy ?? incoming?.has_incubation_tenancy ?? false,
    } : {}),
    known_programs: uniqueStringsValue([
      ...(current?.known_programs ?? []),
      ...(incoming?.known_programs ?? []),
    ]),
    known_program_types: uniqueStringsValue([
      ...(current?.known_program_types ?? []),
      ...(incoming?.known_program_types ?? []),
    ]),
  };
}

function validatedUpdate(
  field: CriterionDimension,
  value: unknown,
  metadata: DevServiceDataProfileMetadata,
  options: { mode?: CompanyProfileFieldUpdate["mode"] } = {},
): CompanyProfileFieldUpdate {
  const provider = metadata.provider.trim();
  if (!provider) throw new Error("provider가 비어 있습니다.");
  if (
    metadata.confidence !== null &&
    (!Number.isFinite(metadata.confidence) || metadata.confidence < 0 || metadata.confidence > 1)
  ) {
    throw new Error("confidence는 0 이상 1 이하이어야 합니다.");
  }
  const update: CompanyProfileFieldUpdate = {
    field,
    value,
    confidence: metadata.confidence,
    sourceKind: metadata.sourceKind,
    provider,
    asOf: metadata.asOf,
    axisCompleteness: metadata.axisCompleteness,
    ...(options.mode ? { mode: options.mode } : {}),
  };
  updateCompanyProfileField(EMPTY_PROFILE, update);
  return update;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field}는 0 이상의 숫자여야 합니다.`);
  }
  return Math.floor(parsed);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field}는 boolean이어야 합니다.`);
  return value;
}

function uniqueStrings(values: readonly unknown[], field: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${field}.${index}는 비어 있지 않은 문자열이어야 합니다.`);
    }
    const normalized = value.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function uniqueStringsValue(values: string[]): string[] {
  return [...new Set(values)];
}

function hasDefinedValue(value: object): boolean {
  return Object.values(value).some((item) => item !== undefined && item !== null && item !== "");
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 답변은 객체여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function arrayOrEmpty(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("목록 답변은 배열이어야 합니다.");
  return value;
}

/**
 * G3 final merge. The caller supplies every input including the Q&A timestamp,
 * so the same base and ordered update sequence always produce byte-equivalent
 * JSON. Connector observations are applied before Q&A observations, and Q&A is
 * normalized against the connector-merged profile rather than EMPTY_PROFILE.
 */
export function buildDevFinalCompanyProfile(
  input: BuildDevFinalCompanyProfileInput,
): DevFinalCompanyProfileResult {
  let profile = sanitizeDevServiceDataJson(input.baseProfile);
  const mergeDecisions: DevProfileMergeDecision[] = [];
  const normalized = new Set<CriterionDimension>(input.connectorNormalizedDimensions ?? []);
  const sourced = new Set<CriterionDimension>(input.connectorSourcedDimensions ?? []);
  const normalizationFailures: DevServiceDataNormalizationFailure[] = [
    ...(input.connectorNormalizationFailures ?? []),
  ];

  for (const update of input.connectorProfileUpdates) {
    sourced.add(update.field);
    const merged = mergeDevProfileUpdate(profile, update, "connector");
    profile = merged.profile;
    normalized.add(update.field);
    mergeDecisions.push({ ...merged.decision, sequence: mergeDecisions.length });
  }

  if (input.qna) {
    const qnaDate = parseReplayDate(input.qna.asOf);
    const qnaDimensions = qnaSourcedDimensions(input.qna.answers);
    for (const dimension of qnaDimensions) sourced.add(dimension);
    const qna = buildDevQnaProfileUpdates(input.qna.answers, {
      baseProfile: profile,
      now: qnaDate,
      preserveEvidenceConflicts: true,
    });
    normalizationFailures.push(...qna.failures);
    for (const update of qna.profileUpdates) {
      const merged = mergeDevProfileUpdate(profile, update, "qna");
      profile = merged.profile;
      normalized.add(update.field);
      mergeDecisions.push({ ...merged.decision, sequence: mergeDecisions.length });
    }
  }

  const failedFields = new Set(
    normalizationFailures.flatMap((failure) => failure.field === "qna" ? [] : [failure.field]),
  );
  const stateDimensions = [...new Set<CriterionDimension>([
    ...Object.keys(profile.profile_evidence ?? {}) as CriterionDimension[],
    ...sourced,
    ...normalized,
    ...failedFields,
  ])].sort();
  const fieldStates = stateDimensions.map((field): DevProfileFieldState => ({
    field,
    sourced: sourced.has(field) || Boolean(input.baseProfile.profile_evidence?.[field]),
    normalized: normalized.has(field) || (
      Boolean(input.baseProfile.profile_evidence?.[field]) && hasMatchableProfileValue(profile, field)
    ),
    match_ready: isMatchReady(profile, field),
    product_consumed: "pending",
  }));

  return sanitizeDevServiceDataJson({
    profilePreview: profile,
    mergeDecisions,
    fieldStates,
    normalizationFailures,
    mergeOrder: ["connector", "qna"] as const,
  });
}

function mergeDevProfileUpdate(
  profile: CompanyProfile,
  update: CompanyProfileFieldUpdate,
  stage: DevProfileMergeStage,
): { profile: CompanyProfile; decision: Omit<DevProfileMergeDecision, "sequence"> } {
  const evidenceWithoutField = { ...(profile.profile_evidence ?? {}) };
  delete evidenceWithoutField[update.field];
  const validationSeed: CompanyProfile = {
    ...profile,
    profile_evidence: evidenceWithoutField,
  };
  if (Object.keys(evidenceWithoutField).length === 0) delete validationSeed.profile_evidence;
  const candidate = normalizeCompanyIndustryProfile(updateCompanyProfileField(validationSeed, {
    ...update,
    // G3 decides precedence explicitly below. This only permits the existing
    // normalizer to validate/construct a candidate without mutating storage.
    allowAuthoritativeOverride: true,
  }));
  const incomingEvidence = candidate.profile_evidence?.[update.field];
  if (!incomingEvidence) {
    throw new Error(`${update.field} update에 evidence metadata가 없습니다.`);
  }
  const currentEvidence = profile.profile_evidence?.[update.field];
  const precedence = currentEvidence
    ? resolveEvidencePrecedence({ dimension: update.field, current: currentEvidence, incoming: incomingEvidence })
    : null;
  const incomingPrimary = precedence?.decision === "replace" || !currentEvidence;
  const supplementalMerge = !incomingPrimary && stage === "qna" && update.mode === "merge";
  let next = incomingPrimary
    ? mergeWinningCompoundValue(profile, candidate, update.field)
    : supplementalMerge
      ? candidate
      : profile;
  const mergedEvidence = mergeFieldEvidence(currentEvidence, incomingEvidence, incomingPrimary);
  const shouldWriteConfidence = incomingPrimary || supplementalMerge;
  next = {
    ...next,
    confidence: {
      ...(next.confidence ?? {}),
      ...(shouldWriteConfidence && typeof mergedEvidence.confidence === "number"
        ? { [update.field]: mergedEvidence.confidence }
        : {}),
    },
    profile_evidence: {
      ...(next.profile_evidence ?? {}),
      [update.field]: mergedEvidence,
    },
  };

  return {
    profile: sanitizeDevServiceDataJson(next),
    decision: {
      stage,
      field: update.field,
      valueDisposition: incomingPrimary
        ? "applied"
        : supplementalMerge
          ? "merged_supplemental"
          : "retained",
      evidenceDisposition: incomingPrimary
        ? "incoming_primary"
        : "current_primary_incoming_supplemental",
      reason: precedence?.reason ?? "no_current_evidence",
      primaryEvidence: stripSupplemental(mergedEvidence),
      supplementalEvidence: [...(mergedEvidence.supplemental ?? [])],
    },
  };
}

/** Mirrors production serviceData.ts shallow overlays for compound dimensions. */
function mergeWinningCompoundValue(
  current: CompanyProfile,
  incoming: CompanyProfile,
  field: CriterionDimension,
): CompanyProfile {
  switch (field) {
    case "business_status":
      return {
        ...incoming,
        business_status: { ...(current.business_status ?? {}), ...(incoming.business_status ?? {}) },
      };
    case "financial_health":
      return {
        ...incoming,
        financial_health: { ...(current.financial_health ?? {}), ...(incoming.financial_health ?? {}) },
      };
    case "insured_workforce":
      return {
        ...incoming,
        insured_workforce: { ...(current.insured_workforce ?? {}), ...(incoming.insured_workforce ?? {}) },
      };
    case "investment":
      return {
        ...incoming,
        investment: { ...(current.investment ?? {}), ...(incoming.investment ?? {}) },
      };
    case "other":
      return {
        ...incoming,
        other_conditions: { ...(current.other_conditions ?? {}), ...(incoming.other_conditions ?? {}) },
      };
    default:
      return incoming;
  }
}

function mergeFieldEvidence(
  current: CompanyProfileFieldEvidence | undefined,
  incoming: CompanyProfileFieldEvidence,
  incomingPrimary: boolean,
): CompanyProfileFieldEvidence {
  if (!current) return incoming;
  const primary = incomingPrimary ? incoming : current;
  const secondary = incomingPrimary ? current : incoming;
  const supplemental = [
    ...(primary.supplemental ?? []),
    stripSupplemental(secondary),
    ...(secondary.supplemental ?? []),
  ].reduce<CompanyProfileEvidenceObservation[]>(appendUniqueEvidence, []);
  return supplemental.length > 0 ? { ...stripSupplemental(primary), supplemental } : stripSupplemental(primary);
}

function stripSupplemental(
  evidence: CompanyProfileEvidenceObservation,
): CompanyProfileEvidenceObservation {
  return {
    sourceKind: evidence.sourceKind,
    provider: evidence.provider,
    asOf: evidence.asOf,
    axisCompleteness: evidence.axisCompleteness,
    confidence: evidence.confidence,
  };
}

function appendUniqueEvidence(
  values: CompanyProfileEvidenceObservation[],
  incoming: CompanyProfileEvidenceObservation,
): CompanyProfileEvidenceObservation[] {
  if (!values.some((item) => sameEvidence(item, incoming))) values.push(incoming);
  return values;
}

function sameEvidence(
  left: CompanyProfileEvidenceObservation,
  right: CompanyProfileEvidenceObservation,
): boolean {
  return left.sourceKind === right.sourceKind &&
    left.provider === right.provider &&
    left.asOf === right.asOf &&
    left.axisCompleteness === right.axisCompleteness &&
    left.confidence === right.confidence;
}

function qnaSourcedDimensions(dto: DevQnaAnswerDto): CriterionDimension[] {
  const byDefinitionId = new Map<QuestionDefinitionId, DevQnaDimension>(
    DEV_QNA_DIMENSIONS.map((dimension) => [questionDefinitionFor(dimension).id, dimension]),
  );
  return dto.answers.flatMap((answer) => {
    const dimension = byDefinitionId.get(answer.definitionId);
    return dimension ? [dimension] : [];
  });
}

function parseReplayDate(value: string): Date {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw new Error("qna.asOf는 유효한 ISO 시각이어야 합니다.");
  return date;
}

const LIST_DIMENSIONS = new Set<CriterionDimension>([
  "industry",
  "founder_trait",
  "certification",
  "prior_award",
  "ip",
  "target_type",
]);

function isMatchReady(profile: CompanyProfile, field: CriterionDimension): boolean {
  const evidence = profile.profile_evidence?.[field];
  if (!evidence || evidence.axisCompleteness !== "complete") return false;
  if (LIST_DIMENSIONS.has(field)) {
    return profile.list_completeness?.[field as ListProfileDimension] === "complete";
  }
  return hasMatchableProfileValue(profile, field);
}

function hasMatchableProfileValue(profile: CompanyProfile, field: CriterionDimension): boolean {
  switch (field) {
    case "region": return Boolean(profile.region?.code || profile.region?.label);
    case "biz_age": return typeof profile.biz_age_months === "number";
    case "industry": return Boolean(profile.industries || profile.industry_codes);
    case "size": return Boolean(profile.size);
    case "revenue": return typeof profile.revenue_krw === "number";
    case "employees": return typeof profile.employees_count === "number";
    case "founder_age": return typeof profile.founder_age === "number";
    case "founder_trait": return Boolean(profile.traits);
    case "certification": return Boolean(profile.certs);
    case "prior_award": return Boolean(profile.prior_award_history || profile.prior_awards);
    case "ip": return Boolean(profile.ip);
    case "target_type": return Boolean(profile.target_types);
    case "business_status": return Boolean(profile.business_status);
    case "tax_compliance": return Boolean(profile.tax_compliance);
    case "credit_status": return Boolean(profile.credit_status);
    case "sanction": return Boolean(profile.sanction);
    case "financial_health": return Boolean(profile.financial_health);
    case "insured_workforce": return Boolean(profile.insured_workforce);
    case "investment": return Boolean(profile.investment);
    case "premises":
    case "export_performance": return false;
    case "other": return Boolean(profile.other_conditions);
  }
}

const SENSITIVE_DEV_JSON_KEY_TOKENS = [
  "birth",
  "phone",
  "mobile",
  "representative",
  "resceonm",
  "loginidentity",
  "accesstoken",
  "refreshtoken",
  "token",
  "생년월일",
  "출생",
  "휴대폰",
  "핸드폰",
  "전화번호",
  "연락처",
  "대표자",
  "토큰",
] as const;

/** Remove CODEF identity/auth fields before any preview, snapshot, or API JSON serialization. */
export function sanitizeDevServiceDataJson<T>(value: T): T {
  return sanitizeDevJsonValue(value) as T;
}

function sanitizeDevJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDevJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveDevJsonKey(key))
      .map(([key, entry]) => [key, sanitizeDevJsonValue(entry)]),
  );
}

function isSensitiveDevJsonKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  return SENSITIVE_DEV_JSON_KEY_TOKENS.some((token) => normalized.includes(token));
}
