import {
  CRITERION_DIMENSIONS,
  assertDeepAnalysisModelEffort,
  type CriterionDimension,
  type DeepAnalysisAdjudicationModel,
  type DeepAnalysisEffort,
  type DeepAnalysisModelResult,
  type GrantCriterion,
} from "@cunote/contracts";
import { REGION_CODES } from "@cunote/core";
import type { DeepAnalysisValidationResult } from "./validator";
import type { DeepAnalysisAuditItemResult } from "./audit";
import {
  DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
  priceDeepAnalysisUsage,
} from "./costPolicy";
import {
  DEEP_ANALYSIS_ACTOR_TRACK_SCOPE_RULE,
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_APPLICANT_INDUSTRY_SCOPE_RULE,
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_BUSINESS_STATUS_RULE,
  DEEP_ANALYSIS_COMPOUND_PREDICATE_RULE,
  DEEP_ANALYSIS_CONDITIONAL_INDUSTRY_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_CALCULATION_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_FINANCIAL_THRESHOLD_RULE,
  DEEP_ANALYSIS_FUTURE_REGION_ALTERNATIVE_RULE,
  DEEP_ANALYSIS_INDUSTRY_ENUMERATION_RULE,
  DEEP_ANALYSIS_JOB_FIELD_INDUSTRY_BOUNDARY_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_SCOPE_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  DEEP_ANALYSIS_UNRESOLVED_REFUND_RULE,
  resolveExactEvidenceSpan,
} from "./extractor";
import { isDeepAnalysisMatchImpactingCriterion } from "./auditScope";
import { stableJson } from "./sourceRevision";

export const DEEP_ANALYSIS_AUDIT_ADJUDICATION_VERSION =
  "deep-analysis-audit-adjudication-v25" as const;
export const DEEP_ANALYSIS_AUDIT_FINDING_VERIFIER_VERSION =
  "deep-analysis-audit-finding-verifier-v3" as const;
export const DEEP_ANALYSIS_AUDIT_UNCERTAINTY_VERIFIER_VERSION =
  "deep-analysis-audit-uncertainty-verifier-v1" as const;
export const DEEP_ANALYSIS_AUDIT_DECISIVENESS_RULE =
  "원문에 신청자격·결격·결격 예외가 명시됐는데 primary에 의미상 같은 criterion이 없거나 잘못된 값으로 있으면 blocking_findings로 확정한다. primary의 canonical 표현이 불완전하거나 profile에서 아직 자동 판정할 수 없다는 이유로 uncertainties로 낮추지 마라. uncertainties는 원문 자체의 의미나 적용 범위를 끝까지 읽어도 확정할 수 없을 때만 사용한다.";
export const DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT = [
  "너는 정부지원사업 공고의 독립 감사자다.",
  "너는 이미 primary를 보지 않고 원문을 독립 분석했다. 이제 원문, primary 결과, 네 독립 결과를 대조해 primary를 항목별로 감사한다.",
  "독립 결과는 누락 후보를 찾기 위한 탐색 신호다. primary와 같은 criterion 배열·분할·kind·문구를 재생성할 필요가 없다.",
  "최종 감사 대상은 primary가 신청 시점의 필수조건·결격·결격 예외를 의미상 누락하거나 잘못 분류했는지다.",
  "우대·가점·평가점수 preferred 조건은 이 감사의 범위가 아니다.",
  "표현·criterion 분할·source span 길이·blind 결과의 contract/normalization 차이만으로 blocking finding을 만들지 마라.",
  "이 단계에 전달되는 blind 결과는 validator를 통과했다. blocking finding은 CRITERION_CANDIDATES의 candidateKind=audit_only인 행 하나를 candidate_key로 정확히 지목해야 한다.",
  "candidate_key가 없는 자유서술 주장, primary 행을 가리키는 주장, 원문과 값이 충돌하는 주장은 결정론적 검증에서 폐기된다.",
  "reviewed_candidate_keys에는 CRITERION_CANDIDATES의 key를 정확히 한 번씩 모두 넣어 실제 후보 검토를 증명한다. 조건 없는 축 목록은 만들지 마라.",
  "blocking_findings에는 원문으로 입증된 primary의 실질 누락 또는 오분류만 넣는다. source span은 선택한 candidate의 검증된 audit criterion에서 결정론적으로 가져온다.",
  "audit_only 후보가 중복·과분해·비자격 서술이거나 primary가 이미 의미상 반영했다면 blocking_findings에 넣지 않는다.",
  "전달된 후보의 의미를 확정할 수 없으면 uncertainties에 candidate_key와 이유를 넣는다. 후보와 무관한 조건 없는 축 uncertainty는 만들지 마라.",
  "실제 blocker와 uncertainty가 모두 없으면 두 배열을 비워 반환한다. 비차단 차이의 설명을 억지로 finding으로 만들지 마라.",
  DEEP_ANALYSIS_BUSINESS_CREDIT_AXIS_RULE,
  DEEP_ANALYSIS_SIZE_TARGET_AXIS_RULE,
  DEEP_ANALYSIS_FINANCIAL_IMPAIRMENT_RULE,
  DEEP_ANALYSIS_FINANCIAL_THRESHOLD_RULE,
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_ACTOR_TRACK_SCOPE_RULE,
  DEEP_ANALYSIS_NON_MATCHING_DECLARATION_RULE,
  DEEP_ANALYSIS_DOCUMENT_ONLY_ELIGIBILITY_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_EXCEPTION_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_LOCALITY_PREMISES_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_SCOPE_RULE,
  DEEP_ANALYSIS_COMPOUND_PREDICATE_RULE,
  DEEP_ANALYSIS_CONDITIONAL_INDUSTRY_RULE,
  DEEP_ANALYSIS_APPLICANT_INDUSTRY_SCOPE_RULE,
  DEEP_ANALYSIS_JOB_FIELD_INDUSTRY_BOUNDARY_RULE,
  DEEP_ANALYSIS_INDUSTRY_ENUMERATION_RULE,
  DEEP_ANALYSIS_BUSINESS_STATUS_RULE,
  DEEP_ANALYSIS_UNRESOLVED_REFUND_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_CALCULATION_RULE,
  DEEP_ANALYSIS_FUTURE_REGION_ALTERNATIVE_RULE,
  DEEP_ANALYSIS_AUDIT_DECISIVENESS_RULE,
  "primary와 audit의 flags가 같아도 value.exceptions가 누락되거나 다른 결격 항목의 예외가 붙어 있으면 실질 오분류 finding이다. JSON의 실제 value를 확인하고 설명만으로 예외가 반영됐다고 추정하지 마라.",
  "기준을 완화하거나 원문 밖 내용을 추정하지 마라.",
].join("\n");
const AUDIT_ADJUDICATION_TIMEOUT_MS = 540_000;
const AUDIT_ADJUDICATION_RETRY_DELAY_MS = 5_000;
const AUDIT_ADJUDICATION_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

export interface DeepAnalysisAuditCriterionCandidate {
  kind: "criterion";
  dimension: CriterionDimension;
  candidateKind: "primary" | "audit_only";
  key: string;
  primary: GrantCriterion | null;
  audit: GrantCriterion | null;
}

interface RawBlockingFinding {
  candidate_key?: unknown;
  dimension?: unknown;
  finding_type?: unknown;
  reason?: unknown;
}

interface RawUncertainty {
  candidate_key?: unknown;
  dimension?: unknown;
  reason?: unknown;
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    name?: string;
    input?: {
      reviewed_candidate_keys?: unknown;
      blocking_findings?: unknown;
      uncertainties?: unknown;
    };
  }>;
  stop_reason?: string;
  usage?: Record<string, unknown>;
}

export type DeepAnalysisAuditFindingValidationIssueCode =
  | "row_contract_invalid"
  | "candidate_not_found"
  | "candidate_not_audit_only"
  | "candidate_dimension_mismatch"
  | "finding_type_mismatch"
  | "candidate_evidence_invalid"
  | "already_represented"
  | "region_value_conflict"
  | "biz_age_bound_missing"
  | "discretionary_sanction";

export interface DeepAnalysisAuditFindingValidationIssue {
  index: number;
  code: DeepAnalysisAuditFindingValidationIssueCode;
  candidateKey: string | null;
  message: string;
}

export interface DeepAnalysisAuditAcceptedFinding {
  candidateKey: string;
  dimension: CriterionDimension;
  findingType: "missing_eligibility" | "misclassified_eligibility";
  reason: string;
  criterion: GrantCriterion;
}

export interface DeepAnalysisAuditFindingValidation {
  verifierVersion: typeof DEEP_ANALYSIS_AUDIT_FINDING_VERIFIER_VERSION;
  acceptedCount: number;
  accepted: DeepAnalysisAuditAcceptedFinding[];
  rejected: DeepAnalysisAuditFindingValidationIssue[];
}

export interface DeepAnalysisAuditUncertaintyValidationIssue {
  index: number;
  code: "unsupported_biz_age_bound";
  dimension: "biz_age";
  candidateKey: string;
  message: string;
}

export interface DeepAnalysisAuditUncertaintyValidation {
  verifierVersion: typeof DEEP_ANALYSIS_AUDIT_UNCERTAINTY_VERIFIER_VERSION;
  retainedCount: number;
  dismissed: DeepAnalysisAuditUncertaintyValidationIssue[];
}

export async function adjudicateDeepAnalysisAudit(input: {
  apiKey: string;
  model: DeepAnalysisAdjudicationModel;
  effort?: DeepAnalysisEffort;
  evidenceText: string;
  primaryResult: DeepAnalysisModelResult;
  primaryValidation: DeepAnalysisValidationResult;
  auditValidation: DeepAnalysisValidationResult;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
}): Promise<{
  model: DeepAnalysisAdjudicationModel;
  effort: DeepAnalysisEffort;
  verdict: "concur" | "disagree" | "unsure";
  itemResults: DeepAnalysisAuditItemResult[];
  rawResponseText: string;
  rawToolInput: Record<string, unknown>;
  findingValidation: DeepAnalysisAuditFindingValidation;
  uncertaintyValidation: DeepAnalysisAuditUncertaintyValidation;
  usage: {
    inputTokens: number;
    outputTokens: number;
  } | null;
  costUsd: number | null;
}> {
  if (!input.primaryValidation.valid) {
    throw new Error("Deep analysis audit adjudication requires a valid primary result");
  }
  if (!input.auditValidation.valid) {
    throw new Error("Deep analysis audit adjudication refuses an invalid blind audit result");
  }
  const effort = input.effort ?? "high";
  assertDeepAnalysisModelEffort({ model: input.model, effort });
  const candidates = buildDeepAnalysisAuditCandidates(
    input.primaryValidation,
    input.auditValidation,
  );
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: DEEP_ANALYSIS_ADJUDICATION_MAX_OUTPUT_TOKENS,
    output_config: { effort },
    system: DEEP_ANALYSIS_AUDIT_ADJUDICATION_SYSTEM_PROMPT,
    messages: [{
      role: "user",
      content: [
        "<<<SEALED_SOURCE>>>",
        input.evidenceText,
        "<<<END_SEALED_SOURCE>>>",
        "<<<CRITERION_CANDIDATES>>>",
        stableJson(candidates),
        "<<<END_COMPARISON_INPUT>>>",
      ].join("\n"),
    }],
    tools: [auditAdjudicationTool()],
    tool_choice: { type: "tool", name: "emit_deep_analysis_audit_adjudication" },
  });
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeoutMs = input.timeoutMs ?? AUDIT_ADJUDICATION_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await (input.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: requestBody,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Anthropic audit adjudication timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  let response = await attempt();
  if (AUDIT_ADJUDICATION_RETRYABLE_STATUSES.has(response.status)) {
    await new Promise((resolve) => setTimeout(
      resolve,
      input.retryDelayMs ?? AUDIT_ADJUDICATION_RETRY_DELAY_MS,
    ));
    response = await attempt();
  }
  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic audit adjudication failed: ${response.status} ${response.statusText}\n${rawResponseText.slice(0, 1_000)}`,
    );
  }
  const payload = JSON.parse(rawResponseText) as AnthropicResponse;
  const tool = payload.content?.find((block) => (
    block.type === "tool_use" && block.name === "emit_deep_analysis_audit_adjudication"
  ));
  const rawToolInput = isRecord(tool?.input) ? tool.input : {};
  const normalized = normalizeDeepAnalysisAuditAdjudication({
    evidenceText: input.evidenceText,
    primaryCriteria: input.primaryResult.criteria,
    primaryValidation: input.primaryValidation,
    candidates,
    reviewedCandidateKeys: rawToolInput.reviewed_candidate_keys,
    findingRows: rawToolInput.blocking_findings,
    uncertaintyRows: rawToolInput.uncertainties,
  });
  const usage = normalizeUsage(payload.usage);
  return {
    model: input.model,
    effort,
    ...normalized,
    rawResponseText,
    rawToolInput,
    usage,
    costUsd: usage
      ? priceDeepAnalysisUsage({ model: input.model, usage })
      : null,
  };
}

export function buildDeepAnalysisAuditCandidates(
  primary: DeepAnalysisValidationResult,
  audit: DeepAnalysisValidationResult,
): DeepAnalysisAuditCriterionCandidate[] {
  const primaryCriteria = primary.criteria.filter((item) => (
    isDeepAnalysisMatchImpactingCriterion(item.canonicalCriterion)
  ));
  const auditCriteria = audit.criteria.filter((item) => (
    isDeepAnalysisMatchImpactingCriterion(item.canonicalCriterion)
  ));
  const primaryByHash = new Map(
    primaryCriteria.map((item) => [item.semanticSha256, item]),
  );
  const auditByHash = new Map(
    auditCriteria.map((item) => [item.semanticSha256, item]),
  );
  const candidates: DeepAnalysisAuditCriterionCandidate[] = primaryCriteria.map((item) => ({
    kind: "criterion",
    dimension: item.criterion.dimension,
    candidateKind: "primary",
    key: item.semanticSha256,
    primary: {
      ...item.canonicalCriterion,
      ...(item.criterion.sourceSpan ? { source_span: item.criterion.sourceSpan } : {}),
    },
    audit: auditByHash.has(item.semanticSha256)
      ? {
        ...auditByHash.get(item.semanticSha256)!.canonicalCriterion,
        ...(auditByHash.get(item.semanticSha256)!.criterion.sourceSpan
          ? { source_span: auditByHash.get(item.semanticSha256)!.criterion.sourceSpan! }
          : {}),
      }
      : null,
  }));
  for (const item of auditCriteria) {
    if (primaryByHash.has(item.semanticSha256)) continue;
    candidates.push({
      kind: "criterion",
      dimension: item.criterion.dimension,
      candidateKind: "audit_only",
      key: item.semanticSha256,
      primary: null,
      audit: {
        ...item.canonicalCriterion,
        ...(item.criterion.sourceSpan ? { source_span: item.criterion.sourceSpan } : {}),
      },
    });
  }
  return candidates.sort((left, right) => (
    `${left.dimension}:${left.candidateKind}:${left.key}`
      .localeCompare(`${right.dimension}:${right.candidateKind}:${right.key}`)
  ));
}

export function normalizeDeepAnalysisAuditAdjudication(input: {
  evidenceText: string;
  primaryCriteria: DeepAnalysisModelResult["criteria"];
  primaryValidation: DeepAnalysisValidationResult;
  candidates: DeepAnalysisAuditCriterionCandidate[];
  reviewedCandidateKeys: unknown;
  findingRows: unknown;
  uncertaintyRows: unknown;
}): {
  verdict: "concur" | "disagree" | "unsure";
  itemResults: DeepAnalysisAuditItemResult[];
  findingValidation: DeepAnalysisAuditFindingValidation;
  uncertaintyValidation: DeepAnalysisAuditUncertaintyValidation;
} {
  const reviewedCandidateKeys = Array.isArray(input.reviewedCandidateKeys)
    ? input.reviewedCandidateKeys.filter((value): value is string => typeof value === "string")
    : [];
  const findingRows = Array.isArray(input.findingRows)
    ? input.findingRows.filter(isRecord) as RawBlockingFinding[]
    : [];
  const uncertaintyRows = Array.isArray(input.uncertaintyRows)
    ? input.uncertaintyRows.filter(isRecord) as RawUncertainty[]
    : [];
  const reviewedSet = new Set(reviewedCandidateKeys);
  const expectedCandidateKeys = new Set(
    input.candidates.map((candidate) => candidate.key),
  );
  let contractInvalid = !Array.isArray(input.reviewedCandidateKeys)
    || (
      Array.isArray(input.reviewedCandidateKeys)
      && input.reviewedCandidateKeys.length !== reviewedCandidateKeys.length
    )
    || reviewedCandidateKeys.length !== expectedCandidateKeys.size
    || reviewedSet.size !== expectedCandidateKeys.size
    || [...expectedCandidateKeys].some((key) => !reviewedSet.has(key))
    || (Array.isArray(input.findingRows) && findingRows.length !== input.findingRows.length)
    || !Array.isArray(input.findingRows)
    || (Array.isArray(input.uncertaintyRows)
      && uncertaintyRows.length !== input.uncertaintyRows.length)
    || !Array.isArray(input.uncertaintyRows);
  const findingsByDimension = new Map<CriterionDimension, string[]>();
  const findingsByCandidate = new Map<string, string[]>();
  const uncertaintiesByCandidate = new Map<string, string[]>();
  const candidateByKey = new Map(input.candidates.map((candidate) => [candidate.key, candidate]));
  const rejected: DeepAnalysisAuditFindingValidationIssue[] = [];
  const accepted: DeepAnalysisAuditAcceptedFinding[] = [];
  const dismissedUncertainties: DeepAnalysisAuditUncertaintyValidationIssue[] = [];
  let retainedUncertaintyCount = 0;
  for (const [index, row] of findingRows.entries()) {
    const candidateKey = typeof row.candidate_key === "string"
      ? row.candidate_key.trim()
      : "";
    const dimension = isDimension(row.dimension) ? row.dimension : null;
    const findingType = row.finding_type;
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    if (
      !candidateKey
      || !dimension
      || (findingType !== "missing_eligibility" && findingType !== "misclassified_eligibility")
      || !reason
    ) {
      contractInvalid = true;
      rejected.push({
        index,
        code: "row_contract_invalid",
        candidateKey: candidateKey || null,
        message: "Finding requires candidate_key, dimension, finding_type, and reason.",
      });
      continue;
    }
    const candidate = candidateByKey.get(candidateKey) ?? null;
    const rejection = verifyBlockingFinding({
      index,
      candidateKey,
      dimension,
      findingType,
      evidenceText: input.evidenceText,
      primaryCriteria: input.primaryCriteria,
      primaryValidation: input.primaryValidation,
      candidate,
    });
    if (rejection) {
      if (rejection.code !== "already_represented") {
        contractInvalid = true;
      }
      rejected.push(rejection);
      continue;
    }
    accepted.push({
      candidateKey,
      dimension,
      findingType,
      reason,
      criterion: candidate!.audit!,
    });
    const rows = findingsByDimension.get(dimension) ?? [];
    rows.push(`${findingType} [${candidateKey}]: ${reason}`);
    findingsByDimension.set(dimension, rows);
    const candidateRows = findingsByCandidate.get(candidateKey) ?? [];
    candidateRows.push(`${findingType}: ${reason}`);
    findingsByCandidate.set(candidateKey, candidateRows);
  }
  for (const [index, row] of uncertaintyRows.entries()) {
    const candidateKey = typeof row.candidate_key === "string"
      ? row.candidate_key.trim()
      : "";
    const dimension = isDimension(row.dimension) ? row.dimension : null;
    const reason = typeof row.reason === "string" ? row.reason.trim() : "";
    const candidate = candidateByKey.get(candidateKey) ?? null;
    if (
      !candidateKey
      || !dimension
      || !reason
      || !candidate
      || candidate.dimension !== dimension
    ) {
      contractInvalid = true;
      continue;
    }
    const dismissal = dismissUnsupportedBizAgeUncertainty({
      index,
      dimension,
      evidenceText: input.evidenceText,
      primaryCriteria: input.primaryCriteria,
      candidates: input.candidates,
    });
    if (dismissal) {
      dismissedUncertainties.push(dismissal);
      continue;
    }
    retainedUncertaintyCount += 1;
    const rows = uncertaintiesByCandidate.get(candidateKey) ?? [];
    rows.push(reason);
    uncertaintiesByCandidate.set(candidateKey, rows);
  }
  const itemResults: DeepAnalysisAuditItemResult[] = input.candidates.map((candidate) => {
    const blockers = findingsByCandidate.get(candidate.key) ?? [];
    const uncertainties = uncertaintiesByCandidate.get(candidate.key) ?? [];
    const reasons = [...blockers, ...uncertainties];
    return {
      kind: "criterion",
      dimension: candidate.dimension,
      key: candidate.key,
      primary: candidate.primary ? candidate.key : null,
      audit: candidate.audit ? candidate.key : null,
      verdict: reasons.length === 0 ? "concur" : "disagree",
      reason: reasons.length === 0 ? null : reasons.join("\n"),
    };
  });
  return {
    verdict: findingsByDimension.size > 0
      ? "disagree"
      : contractInvalid
        ? "unsure"
        : uncertaintiesByCandidate.size > 0
          ? "unsure"
          : "concur",
    itemResults,
    findingValidation: {
      verifierVersion: DEEP_ANALYSIS_AUDIT_FINDING_VERIFIER_VERSION,
      acceptedCount: accepted.length,
      accepted,
      rejected,
    },
    uncertaintyValidation: {
      verifierVersion: DEEP_ANALYSIS_AUDIT_UNCERTAINTY_VERIFIER_VERSION,
      retainedCount: retainedUncertaintyCount,
      dismissed: dismissedUncertainties,
    },
  };
}

function dismissUnsupportedBizAgeUncertainty(input: {
  index: number;
  dimension: CriterionDimension;
  evidenceText: string;
  primaryCriteria: DeepAnalysisModelResult["criteria"];
  candidates: DeepAnalysisAuditCriterionCandidate[];
}): DeepAnalysisAuditUncertaintyValidationIssue | null {
  if (input.dimension !== "biz_age") return null;
  if (input.primaryCriteria.some((criterion) => criterion.dimension === "biz_age")) {
    return null;
  }
  const auditOnlyCandidates = input.candidates.filter((candidate) => (
    candidate.dimension === "biz_age"
    && candidate.candidateKind === "audit_only"
    && candidate.audit !== null
  ));
  if (auditOnlyCandidates.length !== 1) return null;
  const candidate = auditOnlyCandidates[0]!;
  const criterion = candidate.audit!;
  if (
    (criterion.kind !== "required" && criterion.kind !== "exclusion")
    || !hasHardNumericBizAgeBound(criterion)
  ) {
    return null;
  }
  const sourceSpan = criterion.source_span?.trim() ?? "";
  if (
    !sourceSpan
    || resolveExactEvidenceSpan(sourceSpan, input.evidenceText) === null
    || hasExplicitBizAgeBoundEvidence(sourceSpan)
  ) {
    return null;
  }
  return {
    index: input.index,
    code: "unsupported_biz_age_bound",
    dimension: "biz_age",
    candidateKey: candidate.key,
    message:
      "Dismissed the only audit-only hard biz_age candidate because its exact evidence contains no duration or founding-date basis for the numeric month bound.",
  };
}

function hasHardNumericBizAgeBound(criterion: GrantCriterion): boolean {
  if (
    criterion.operator !== "lte"
    && criterion.operator !== "gte"
    && criterion.operator !== "between"
  ) {
    return false;
  }
  const value = isRecord(criterion.value) ? criterion.value : {};
  const minMonths = typeof value.min_months === "number" ? value.min_months : null;
  const maxMonths = typeof value.max_months === "number" ? value.max_months : null;
  return (minMonths !== null && minMonths > 0)
    || (maxMonths !== null && maxMonths > 0);
}

function hasExplicitBizAgeBoundEvidence(sourceSpan: string): boolean {
  const normalized = sourceSpan.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const duration = /(?:\d+(?:[.,]\d+)?|[일이삼사오육칠팔구십백한두세네다섯여섯일곱여덟아홉열]+)(?:년|개월|years?|months?)/u;
  if (duration.test(normalized)) return true;
  const foundingDate = /(?:창업|설립|개업|사업자등록)/u;
  const date = /(?:19|20)?\d{2}[./-]\d{1,2}(?:[./-]\d{1,2})?/u;
  return foundingDate.test(normalized) && date.test(normalized);
}

function verifyBlockingFinding(input: {
  index: number;
  candidateKey: string;
  dimension: CriterionDimension;
  findingType: "missing_eligibility" | "misclassified_eligibility";
  evidenceText: string;
  primaryCriteria: DeepAnalysisModelResult["criteria"];
  primaryValidation: DeepAnalysisValidationResult;
  candidate: DeepAnalysisAuditCriterionCandidate | null;
}): DeepAnalysisAuditFindingValidationIssue | null {
  const reject = (
    code: DeepAnalysisAuditFindingValidationIssueCode,
    message: string,
  ): DeepAnalysisAuditFindingValidationIssue => ({
    index: input.index,
    code,
    candidateKey: input.candidateKey,
    message,
  });
  if (!input.candidate) {
    return reject("candidate_not_found", "candidate_key is not present in CRITERION_CANDIDATES.");
  }
  if (input.candidate.candidateKind !== "audit_only" || !input.candidate.audit) {
    return reject(
      "candidate_not_audit_only",
      "A blocking finding must reference a validated audit_only criterion.",
    );
  }
  if (input.candidate.dimension !== input.dimension) {
    return reject(
      "candidate_dimension_mismatch",
      `Finding dimension ${input.dimension} does not match candidate ${input.candidate.dimension}.`,
    );
  }
  const expected = input.candidate.audit;
  const sourceSpan = expected.source_span?.trim() ?? "";
  if (!sourceSpan || resolveExactEvidenceSpan(sourceSpan, input.evidenceText) === null) {
    return reject(
      "candidate_evidence_invalid",
      "The selected audit criterion does not have an exact sealed-source span.",
    );
  }

  const primaryOnSameEvidence = input.primaryValidation.criteria.filter((item) => (
    item.canonicalCriterion.dimension === expected.dimension
    && item.canonicalCriterion.kind === expected.kind
    && spansRepresentSameEvidence(item.criterion.sourceSpan, sourceSpan)
  ));
  // Promotion and matching consume the normalized primary result, while validation.criteria
  // is a semantic-hash index that may collapse distinct text-only scoring rows.
  const crossDimensionPreferredTextOnly = input.primaryCriteria.find((criterion) => (
    criterion.dimension !== expected.dimension
    && criterion.kind === "preferred"
    && criterion.operator === "text_only"
    && expected.kind === "preferred"
    && expected.operator === "text_only"
    && spansAreExactlySameEvidence(criterion.sourceSpan, sourceSpan)
  ));
  if (crossDimensionPreferredTextOnly) {
    return reject(
      "already_represented",
      `Primary already preserves the same preferred text-only evidence under ${crossDimensionPreferredTextOnly.dimension}.`,
    );
  }
  if (
    expected.operator === "text_only"
    && primaryOnSameEvidence.some((item) => item.canonicalCriterion.operator === "text_only")
  ) {
    return reject(
      "already_represented",
      "Primary already preserves the same text-only fact on the same evidence span.",
    );
  }
  if (input.findingType === "missing_eligibility" && primaryOnSameEvidence.length > 0) {
    return reject(
      "finding_type_mismatch",
      "The selected evidence already has a primary criterion; use misclassified_eligibility only for a real value mismatch.",
    );
  }
  if (input.findingType === "misclassified_eligibility" && primaryOnSameEvidence.length === 0) {
    return reject(
      "finding_type_mismatch",
      "misclassified_eligibility requires a primary criterion on the same dimension and evidence.",
    );
  }

  if (expected.dimension === "region") {
    const regionConflict = findRegionValueConflict(expected, sourceSpan);
    if (regionConflict) return reject("region_value_conflict", regionConflict);
  }
  if (expected.dimension === "biz_age" && lacksRequiredBizAgeBound(expected)) {
    return reject(
      "biz_age_bound_missing",
      "A hard biz_age upper/lower bound must contain the corresponding canonical month value.",
    );
  }
  if (expected.dimension === "sanction" && isDiscretionaryOrganizerSanction(expected, sourceSpan)) {
    return reject(
      "discretionary_sanction",
      "A discretionary organizer judgment is not a present canonical sanction fact.",
    );
  }
  return null;
}

function spansRepresentSameEvidence(
  left: string | null,
  right: string,
): boolean {
  if (!left) return false;
  const normalizedLeft = normalizeEvidenceText(left);
  const normalizedRight = normalizeEvidenceText(right);
  if (normalizedLeft.length < 8 || normalizedRight.length < 8) return false;
  return normalizedLeft.includes(normalizedRight)
    || normalizedRight.includes(normalizedLeft);
}

function spansAreExactlySameEvidence(
  left: string | null,
  right: string,
): boolean {
  if (!left) return false;
  const normalizedLeft = normalizeEvidenceText(left);
  const normalizedRight = normalizeEvidenceText(right);
  return normalizedLeft.length >= 8 && normalizedLeft === normalizedRight;
}

function normalizeEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s"'“”‘’`·•▲△□■◆◇※*()[\]{}<>,.:;!?~_\-/\\|]+/g, "");
}

function findRegionValueConflict(
  criterion: GrantCriterion,
  sourceSpan: string,
): string | null {
  const value = isRecord(criterion.value) ? criterion.value : {};
  const actualCodes = Array.isArray(value.regions)
    ? value.regions.filter((item): item is string => typeof item === "string")
    : [];
  const expectedCodes = new Set(
    Object.entries(REGION_CODES)
      .filter(([label]) => sourceSpan.includes(label))
      .map(([, code]) => code),
  );
  if (expectedCodes.size === 0) return null;
  const unexpected = actualCodes.filter((code) => !expectedCodes.has(code));
  return unexpected.length > 0
    ? `Region code(s) ${unexpected.join(",")} conflict with source label code(s) ${[...expectedCodes].join(",")}.`
    : null;
}

function lacksRequiredBizAgeBound(criterion: GrantCriterion): boolean {
  if (criterion.kind === "preferred" || criterion.operator === "text_only") return false;
  const value = isRecord(criterion.value) ? criterion.value : {};
  if (criterion.operator === "lte") return typeof value.max_months !== "number";
  if (criterion.operator === "gte") return typeof value.min_months !== "number";
  if (criterion.operator === "between") {
    return typeof value.min_months !== "number" || typeof value.max_months !== "number";
  }
  return false;
}

function isDiscretionaryOrganizerSanction(
  criterion: GrantCriterion,
  sourceSpan: string,
): boolean {
  if (criterion.kind !== "exclusion") return false;
  const value = isRecord(criterion.value) ? criterion.value : {};
  const flags = Array.isArray(value.flags)
    ? value.flags.filter((item): item is string => typeof item === "string")
    : [];
  return flags.includes("participation_restricted")
    && /(주최|주관)기관장/.test(sourceSpan)
    && /정당한\s*사유/.test(sourceSpan)
    && /인정/.test(sourceSpan);
}

function auditAdjudicationTool() {
  return {
    name: "emit_deep_analysis_audit_adjudication",
    description: "match-impacting 후보 검토와 실제 신청자격 의미 blocker 또는 uncertainty만 반환한다.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        reviewed_candidate_keys: {
          type: "array",
          maxItems: 128,
          items: { type: "string" },
        },
        blocking_findings: {
          type: "array",
          maxItems: 128,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              candidate_key: {
                type: "string",
                description: "CRITERION_CANDIDATES에서 candidateKind=audit_only인 행의 key",
              },
              finding_type: {
                type: "string",
                enum: ["missing_eligibility", "misclassified_eligibility"],
              },
              reason: { type: "string" },
            },
            required: ["candidate_key", "dimension", "finding_type", "reason"],
          },
        },
        uncertainties: {
          type: "array",
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              dimension: { type: "string", enum: [...CRITERION_DIMENSIONS] },
              candidate_key: {
                type: "string",
                description: "CRITERION_CANDIDATES에서 검토 중인 행의 key",
              },
              reason: { type: "string" },
            },
            required: ["candidate_key", "dimension", "reason"],
          },
        },
      },
      required: ["reviewed_candidate_keys", "blocking_findings", "uncertainties"],
    },
  };
}

function isDimension(value: unknown): value is CriterionDimension {
  return typeof value === "string"
    && (CRITERION_DIMENSIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeUsage(usage: Record<string, unknown> | undefined): {
  inputTokens: number;
  outputTokens: number;
} | null {
  if (!usage) return null;
  const inputTokens = Number(usage.input_tokens);
  const outputTokens = Number(usage.output_tokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  return { inputTokens, outputTokens };
}
