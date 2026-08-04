import type {
  ApplicationRoundtripRun,
  RoundtripParsedDocument,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import type { LabApplicationRoundtripReference } from "@/features/dev/analysis-lab/contract";

export type SettledTask<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown };

/**
 * 주 분석과 지원 양식 sidecar를 await 전에 모두 시작한다.
 * sidecar 실패는 값으로 정규화해 주 분석의 성공/실패 계약을 바꾸지 않는다.
 */
export async function runAnalysisPair<TPrimary, TApplication>(input: {
  primary: () => Promise<TPrimary>;
  application?: () => Promise<TApplication>;
}): Promise<{ primary: TPrimary; application: SettledTask<TApplication> | null }> {
  const applicationPromise = input.application
    ? settle(input.application())
    : Promise.resolve(null);
  const primaryPromise = input.primary();
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
      errorCode: code,
      error: notApplicable ? null : errorMessage(input.result.reason),
    };
  }

  const run = input.result.value;
  const sourceCount = run.sourceCount ?? run.documents.length;
  const applicationDocuments = run.documents.filter(isApplicationDocument);
  if (run.error) {
    return {
      status: "failed",
      runId: run.runId,
      transport: input.transport,
      model: input.model,
      documentCount: run.documents.length,
      sourceCount,
      errorCode: run.failureCode ?? "all_documents_failed",
      error: run.error,
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
        errorCode: runFailureCode,
        error: null,
      };
    }
    return {
      status: "not_applicable",
      runId: run.runId,
      transport: input.transport,
      model: input.model,
      documentCount: run.documents.length,
      sourceCount,
      errorCode: null,
      error: null,
    };
  }

  const usableDocuments = applicationDocuments.filter(
    (document) =>
      document.error === null
      && document.fieldCoverage.status !== "review_required"
      && (document.recommendedInputFieldCount > 0 || document.recommendedChoiceGroupCount > 0),
  );
  const hasReviewRequired = applicationDocuments.some(
    (document) => document.error !== null || document.fieldCoverage.status === "review_required",
  );
  const hasPartial = applicationDocuments.some(
    (document) => document.fieldCoverage.status === "partial",
  );
  const plannerFailed = runFailureCode !== null;
  const status: LabApplicationRoundtripReference["status"] =
    usableDocuments.length === 0 && hasReviewRequired
      ? "review_required"
      : plannerFailed || hasReviewRequired || hasPartial
        ? "partial"
        : "complete";
  return {
    status,
    runId: run.runId,
    transport: input.transport,
    model: input.model,
    documentCount: run.documents.length,
    sourceCount,
    errorCode: runFailureCode,
    error: null,
  };
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
