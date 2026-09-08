/**
 * 분석 한 건의 매칭 사용 가능성과 작성 자산 사용 가능성을 서로 독립적으로 표현한다.
 *
 * launch status/receipt와 release reader가 같은 순수 계약을 소비한다. 구 receipt에 이
 * projection이 없으면 caller가 ready로 추정하지 않고 unverified로 취급해야 한다.
 */
export const ANALYSIS_FEATURE_READINESS_SCHEMA = "analysis-feature-readiness-v1" as const;

export type AnalysisFeatureStatus = "ready" | "held";

export interface AnalysisFeatureReadiness {
  readonly schema: typeof ANALYSIS_FEATURE_READINESS_SCHEMA;
  readonly matching: {
    readonly status: AnalysisFeatureStatus;
    readonly sourceDisposition: "ready" | "conditional" | "deferred" | "unverified";
    readonly reasons: readonly string[];
  };
  readonly authoring: {
    readonly status: AnalysisFeatureStatus;
    readonly sourceDisposition: "ready" | "not_applicable" | "held" | "unverified";
    readonly reasons: readonly string[];
  };
}

export function classifyAnalysisFeatureReadiness(input: {
  readonly primaryOutcome: "publishable" | "held" | "failed";
  readonly matchingReadiness: "ready" | "conditional" | "deferred" | null | undefined;
  readonly applicationFieldAnalysis: "ready" | "not_applicable" | "held" | "not_required";
}): AnalysisFeatureReadiness {
  const matchingReasons: string[] = [];
  const matchingSourceDisposition = input.matchingReadiness ?? "unverified";
  if (input.primaryOutcome !== "publishable") {
    matchingReasons.push(input.primaryOutcome === "failed" ? "primary_failed" : "primary_held");
  }
  if (input.matchingReadiness === "deferred") matchingReasons.push("matching_deferred");
  if (input.matchingReadiness === null || input.matchingReadiness === undefined) {
    matchingReasons.push("matching_readiness_unverified");
  }

  const authoringSourceDisposition = input.applicationFieldAnalysis === "not_required"
    ? "unverified"
    : input.applicationFieldAnalysis;
  const authoringReasons = input.applicationFieldAnalysis === "ready"
    ? []
    : input.applicationFieldAnalysis === "held"
      ? ["application_field_analysis_held"]
      : input.applicationFieldAnalysis === "not_applicable"
        ? ["application_field_analysis_not_applicable"]
        : ["application_field_analysis_unverified"];

  return Object.freeze({
    schema: ANALYSIS_FEATURE_READINESS_SCHEMA,
    matching: Object.freeze({
      status: matchingReasons.length === 0 ? "ready" : "held",
      sourceDisposition: matchingSourceDisposition,
      reasons: Object.freeze([...matchingReasons]),
    }),
    authoring: Object.freeze({
      status: authoringReasons.length === 0 ? "ready" : "held",
      sourceDisposition: authoringSourceDisposition,
      reasons: Object.freeze([...authoringReasons]),
    }),
  });
}

export function normalizeAnalysisFeatureReadiness(value: unknown): AnalysisFeatureReadiness {
  if (!value || typeof value !== "object") {
    throw new Error("analysis feature readiness가 객체가 아닙니다.");
  }
  const readiness = value as Partial<AnalysisFeatureReadiness>;
  const matching = readiness.matching as Partial<AnalysisFeatureReadiness["matching"]> | undefined;
  const authoring = readiness.authoring as Partial<AnalysisFeatureReadiness["authoring"]> | undefined;
  if (
    readiness.schema !== ANALYSIS_FEATURE_READINESS_SCHEMA
    || !matching
    || !authoring
    || (matching.status !== "ready" && matching.status !== "held")
    || !["ready", "conditional", "deferred", "unverified"].includes(String(matching.sourceDisposition))
    || !validReasons(matching.reasons)
    || (authoring.status !== "ready" && authoring.status !== "held")
    || !["ready", "not_applicable", "held", "unverified"].includes(String(authoring.sourceDisposition))
    || !validReasons(authoring.reasons)
    || !validMatchingSemantics(matching)
    || !validAuthoringSemantics(authoring)
  ) {
    throw new Error("analysis feature readiness 형식이 올바르지 않습니다.");
  }
  return Object.freeze({
    schema: ANALYSIS_FEATURE_READINESS_SCHEMA,
    matching: Object.freeze({
      status: matching.status,
      sourceDisposition: matching.sourceDisposition!,
      reasons: Object.freeze([...matching.reasons]),
    }),
    authoring: Object.freeze({
      status: authoring.status,
      sourceDisposition: authoring.sourceDisposition!,
      reasons: Object.freeze([...authoring.reasons]),
    }),
  });
}

export function analysisFeatureReadinessEqual(
  left: AnalysisFeatureReadiness,
  right: AnalysisFeatureReadiness,
): boolean {
  return left.schema === right.schema
    && left.matching.status === right.matching.status
    && left.matching.sourceDisposition === right.matching.sourceDisposition
    && sameStrings(left.matching.reasons, right.matching.reasons)
    && left.authoring.status === right.authoring.status
    && left.authoring.sourceDisposition === right.authoring.sourceDisposition
    && sameStrings(left.authoring.reasons, right.authoring.reasons);
}

/** legacy publishable 또는 명시 matching-ready인 authoring-held target만 검수/승격 대상으로 연다. */
export function analysisLaunchTargetIsMatchingReviewable(input: {
  status: "publishable" | "held" | "failed" | "skipped";
  featureReadiness?: AnalysisFeatureReadiness;
}): boolean {
  if (input.status === "publishable") return true;
  if (input.status !== "held" || !input.featureReadiness) return false;
  try {
    return normalizeAnalysisFeatureReadiness(input.featureReadiness).matching.status === "ready";
  } catch {
    return false;
  }
}

function validReasons(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((reason) => typeof reason === "string" && reason.trim().length > 0)
    && new Set(value).size === value.length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validMatchingSemantics(
  value: Partial<AnalysisFeatureReadiness["matching"]>,
): boolean {
  if (value.status === "ready") {
    return (value.sourceDisposition === "ready" || value.sourceDisposition === "conditional")
      && value.reasons?.length === 0;
  }
  if (!value.reasons || value.reasons.length === 0) return false;
  if (value.sourceDisposition === "deferred") return value.reasons.includes("matching_deferred");
  if (value.sourceDisposition === "unverified") {
    return value.reasons.includes("matching_readiness_unverified");
  }
  return value.sourceDisposition === "ready" || value.sourceDisposition === "conditional";
}

function validAuthoringSemantics(
  value: Partial<AnalysisFeatureReadiness["authoring"]>,
): boolean {
  if (value.status === "ready") {
    return value.sourceDisposition === "ready" && value.reasons?.length === 0;
  }
  if (!value.reasons || value.reasons.length === 0) return false;
  if (value.sourceDisposition === "held") {
    return value.reasons.includes("application_field_analysis_held");
  }
  if (value.sourceDisposition === "not_applicable") {
    return value.reasons.includes("application_field_analysis_not_applicable");
  }
  if (value.sourceDisposition === "unverified") {
    return value.reasons.includes("application_field_analysis_unverified");
  }
  return false;
}
