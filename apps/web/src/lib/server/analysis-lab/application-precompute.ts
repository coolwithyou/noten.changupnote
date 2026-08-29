import type {
  ApplicationRoundtripRun,
  RoundtripParsedDocument,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import type { LabApplicationRoundtripReference } from "@/lib/server/analysis-lab/lab-contract";

export type SettledTask<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

export type ApplicationFieldAnalysisDisposition = "ready" | "not_applicable" | "held";

/**
 * 딥분석 publishable 여부와 별개로 RHWP field-aware 화면에 쓸 수 있는 산출물인지 판정한다.
 * 구런처럼 집계가 없는 참조는 ready로 추정하지 않는다.
 */
export function classifyApplicationFieldAnalysis(
  reference: LabApplicationRoundtripReference | null | undefined,
): ApplicationFieldAnalysisDisposition {
  if (!reference) return "held";
  if (
    reference.status === "not_applicable"
    && (reference.applicationDocumentCount ?? 0) === 0
  ) {
    return "not_applicable";
  }
  if (
    (reference.status === "complete" || reference.status === "partial")
    && (reference.fieldReadyDocumentCount ?? 0) > 0
    && (reference.recognizedFieldCount ?? 0) > 0
  ) {
    return "ready";
  }
  return "held";
}

/**
 * 주 분석과 지원 양식 sidecar를 await 전에 모두 시작한다.
 * sidecar 실패는 값으로 정규화해 주 분석의 성공/실패 계약을 바꾸지 않는다.
 */
export async function runAnalysisPair<TPrimary, TApplication>(input: {
  primary: () => Promise<TPrimary>;
  application?: () => Promise<TApplication>;
}): Promise<{ primary: TPrimary; application: SettledTask<TApplication> | null }> {
  // primary를 먼저 시작해 전역 CLI 대기열에서 Kordoc 하위 호출보다 앞선 순서를 보장한다.
  // 둘은 여전히 await 전에 모두 시작하므로 형제 병렬성은 유지된다.
  const primaryPromise = input.primary();
  const applicationPromise = input.application
    ? settle(input.application())
    : Promise.resolve(null);
  const [primary, application] = await Promise.all([primaryPromise, applicationPromise]);
  return { primary, application };
}

export function buildApplicationRoundtripReference(input: {
  result: SettledTask<ApplicationRoundtripRun>;
  transport: "api" | "claude-cli";
  model: string;
}): LabApplicationRoundtripReference {
  if (input.result.status === "rejected") {
    const code = errorCode(input.result.reason);
    const notApplicable = code === "hwp_attachment_not_found";
    return {
      status: notApplicable ? "not_applicable" : "failed",
      runId: null,
      transport: input.transport,
      model: input.model,
      documentCount: 0,
      sourceCount: 0,
      applicationDocumentCount: 0,
      fieldReadyDocumentCount: 0,
      recognizedFieldCount: 0,
      errorCode: code,
      error: notApplicable ? null : errorMessage(input.result.reason),
    };
  }

  const run = input.result.value;
  const costUsd = run.reusedFromRunId ? 0 : roundtripCostUsd(run);
  const reuse = run.reusedFromRunId ? { reusedFromRunId: run.reusedFromRunId } : {};
  const sourceCount = run.sourceCount ?? run.documents.length;
  const applicationDocuments = run.documents.filter(isApplicationDocument);
  const fieldReadyDocuments = applicationDocuments.filter(
    (document) =>
      document.error === null
      && document.fieldCoverage.status !== "review_required"
      && document.fieldCoverage.anchorUnreadyInputCount === 0
      && document.fieldCoverage.anchorReadyInputCount === document.recommendedInputFieldCount
      && (
        (document.fieldCoverage.anchorReadyInputCount ?? 0) > 0
        || document.recommendedChoiceGroupCount > 0
      ),
  );
  const recognizedFieldCount = fieldReadyDocuments.reduce(
    (sum, document) => sum
      + (document.fieldCoverage.anchorReadyInputCount ?? 0)
      + document.recommendedChoiceGroupCount,
    0,
  );
  const fieldSummary = {
    applicationDocumentCount: applicationDocuments.length,
    fieldReadyDocumentCount: fieldReadyDocuments.length,
    recognizedFieldCount,
  } as const;
  if (run.error) {
    return {
      status: "failed",
      runId: run.runId,
      transport: input.transport,
      model: input.model,
      documentCount: run.documents.length,
      sourceCount,
      ...fieldSummary,
      errorCode: run.failureCode ?? "all_documents_failed",
      error: run.error,
      costUsd,
      ...reuse,
    };
  }
  const runFailureCode = run.failureCode ?? null;
  if (applicationDocuments.length === 0 || run.recommendedAttachmentId === null) {
    if (runFailureCode !== null) {
      return {
        status: "review_required",
        runId: run.runId,
        transport: input.transport,
        model: input.model,
        documentCount: run.documents.length,
        sourceCount,
        ...fieldSummary,
        errorCode: runFailureCode,
        error: null,
        costUsd,
        ...reuse,
      };
    }
    return {
      status: "not_applicable",
      runId: run.runId,
      transport: input.transport,
      model: input.model,
      documentCount: run.documents.length,
      sourceCount,
      ...fieldSummary,
      errorCode: null,
      error: null,
      costUsd,
      ...reuse,
    };
  }

  const usableDocuments = fieldReadyDocuments;
  const hasReviewRequired = applicationDocuments.some(
    (document) => document.error !== null || document.fieldCoverage.status === "review_required",
  );
  const hasPartial = applicationDocuments.some(
    (document) => document.fieldCoverage.status === "partial",
  );
  const plannerFailed = runFailureCode !== null;
  const planningSummaries = applicationDocuments.flatMap((document) =>
    document.fieldPlanning ? [document.fieldPlanning] : []);
  const remainingUnresolvedCandidateCount = applicationDocuments.reduce(
    (sum, document) => sum + document.fieldCoverage.unresolvedCandidateCount,
    0,
  );
  const adjudicationRounds = Math.max(0, ...planningSummaries.map((summary) => summary.adjudicationRounds ?? 0));
  const adjudicatedCandidateCount = planningSummaries.reduce(
    (sum, summary) => sum + (summary.adjudicatedCandidateCount ?? 0),
    0,
  );
  const adjudicationStatuses = planningSummaries.flatMap((summary) =>
    summary.adjudicationStatus ? [summary.adjudicationStatus] : []);
  const adjudicationStatus = adjudicationStatuses.includes("failed")
    ? "failed" as const
    : remainingUnresolvedCandidateCount > 0
      ? "partial" as const
      : adjudicationRounds > 0
        ? "resolved" as const
        : adjudicationStatuses.includes("skipped")
          ? "skipped" as const
          : "not_needed" as const;
  const status: LabApplicationRoundtripReference["status"] =
    hasReviewRequired || plannerFailed
      ? "review_required"
      : hasPartial
        ? "partial"
        : "complete";
  return {
    status,
    runId: run.runId,
    transport: input.transport,
    model: input.model,
    documentCount: run.documents.length,
    sourceCount,
    ...fieldSummary,
    errorCode: runFailureCode,
    error: null,
    costUsd,
    adjudicationStatus,
    adjudicationRounds,
    adjudicatedCandidateCount,
    remainingUnresolvedCandidateCount,
    ...reuse,
  };
}

function roundtripCostUsd(run: ApplicationRoundtripRun): number | null {
  const planning = run.documents.flatMap((document) => document.fieldPlanning ? [document.fieldPlanning] : []);
  if (planning.length === 0) return 0;
  if (planning.some((summary) => summary.status === "llm" && typeof summary.costUsd !== "number")) return null;
  return planning.reduce((sum, summary) => sum + (summary.costUsd ?? 0), 0);
}

function isApplicationDocument(document: RoundtripParsedDocument): boolean {
  return document.role === "application_form"
    || document.role === "business_plan"
    || document.role === "mixed_form";
}

async function settle<T>(promise: Promise<T>): Promise<SettledTask<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim() ? code.slice(0, 100) : null;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}
