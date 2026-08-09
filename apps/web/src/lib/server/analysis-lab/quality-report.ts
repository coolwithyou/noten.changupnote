import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import {
  ANALYSIS_QUALITY_POLICY_VERSION,
  emptyQualityStatusCounts,
  type AnalysisQualityGraph,
  type AnalysisQualityNodeId,
  type AnalysisQualityReport,
  type AnalysisQualityReviewEvidence,
} from "@/features/dev/analysis-lab/quality-contract";
import {
  AI_REVIEW_ADOPTED,
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabReview,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { readRoundtripRunArtifacts } from "./application-roundtrip/store";
import { readAiReviewFile, aiReviewFilePath } from "./ai-review";
import { labAuditFilePath, readLabAuditFileAt } from "./audit-store";
import {
  isLabAuditCompleteForRun,
  mergeAuditedReview,
} from "./audited-reviews";
import { evaluateAnalysisQuality } from "./quality-graph";
import { readLabReview } from "./review-store";
import { readLatestLabRunIndexForPrompt } from "./run-store";

export const ANALYSIS_QUALITY_REPORT_DEFAULT_LIMIT = 30;
export const ANALYSIS_QUALITY_REPORT_MAX_LIMIT = 100;

export async function loadAnalysisQualityReport(
  options: { limit?: number } = {},
): Promise<AnalysisQualityReport> {
  const limit = clampLimit(options.limit ?? ANALYSIS_QUALITY_REPORT_DEFAULT_LIMIT);
  const index = await readLatestLabRunIndexForPrompt(ANALYSIS_LAB_PROMPT_VERSION);
  const runs = [...index.values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
  const graphs = await Promise.all(runs.map(loadRunQualityGraph));
  return buildAnalysisQualityReport(graphs, limit);
}

export function buildAnalysisQualityReport(
  graphs: AnalysisQualityGraph[],
  requestedLimit: number,
  now = new Date(),
): AnalysisQualityReport {
  const analysis = emptyQualityStatusCounts();
  const deepAnalysis = emptyQualityStatusCounts();
  const application = emptyQualityStatusCounts();
  const product = emptyQualityStatusCounts();
  const blockerCounts = new Map<AnalysisQualityNodeId, { label: string; count: number }>();

  for (const graph of graphs) {
    analysis[graph.analysisReadiness] += 1;
    deepAnalysis[graph.lanes.deep_analysis] += 1;
    application[graph.lanes.application] += 1;
    product[graph.lanes.product] += 1;
    for (const node of graph.nodes) {
      if (node.status !== "held" && node.status !== "failed") continue;
      const current = blockerCounts.get(node.id) ?? { label: node.label, count: 0 };
      current.count += 1;
      blockerCounts.set(node.id, current);
    }
  }

  return {
    policyVersion: ANALYSIS_QUALITY_POLICY_VERSION,
    generatedAt: now.toISOString(),
    selection: "latest-current-run-per-grant",
    requestedLimit,
    summary: {
      total: graphs.length,
      analysis,
      deepAnalysis,
      application,
      product,
      blockers: [...blockerCounts].map(([nodeId, value]) => ({ nodeId, ...value }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    },
    graphs,
  };
}

async function loadRunQualityGraph(run: LabRun): Promise<AnalysisQualityGraph> {
  const [review, roundtripArtifacts] = await Promise.all([
    loadReviewEvidence(run),
    run.applicationRoundtrip?.runId
      ? readRoundtripRunArtifacts(run.grantId, run.applicationRoundtrip.runId)
      : Promise.resolve(null),
  ]);
  return evaluateAnalysisQuality({
    run,
    review,
    roundtrip: roundtripArtifacts?.run ?? null,
  });
}

async function loadReviewEvidence(run: LabRun): Promise<AnalysisQualityReviewEvidence | null> {
  const humanReview = await readLabReview(run.grantId, run.runId);
  if (humanReview) {
    return {
      source: "human",
      review: humanReview,
      complete: hasCompleteReviewCoverage(run, humanReview),
      currentPolicy: true,
    };
  }

  const aiReview = await readAiReviewFile(
    aiReviewFilePath(run.source, run.sourceId, run.runId, AI_REVIEW_ADOPTED.model),
  );
  if (!aiReview) return null;
  const audit = await readLabAuditFileAt(
    labAuditFilePath(run.source, run.sourceId, run.runId, AI_REVIEW_ADOPTED.model),
  );
  const review = audit
    ? mergeAuditedReview(aiReview, audit, run).review
    : aiReviewAsLabReview(run, aiReview);
  return {
    source: "ai_audit",
    review,
    complete: Boolean(audit) && isLabAuditCompleteForRun(run, audit!) && hasCompleteReviewCoverage(run, review),
    currentPolicy: aiReview.model === AI_REVIEW_ADOPTED.model
      && aiReview.promptVersion === AI_REVIEW_ADOPTED.promptVersion
      && aiReview.inputSha256Verified === true,
  };
}

function aiReviewAsLabReview(
  run: LabRun,
  aiReview: Awaited<ReturnType<typeof readAiReviewFile>> & {},
): LabReview {
  return {
    grantId: run.grantId,
    runId: run.runId,
    reviewerEmail: "(AI 검수 — 독립 감사 대기)",
    createdAt: aiReview.createdAt,
    updatedAt: aiReview.createdAt,
    criterionReviews: aiReview.criterionReviews,
    axisReviews: aiReview.axisReviews,
    overallNote: null,
  };
}

export function hasCompleteReviewCoverage(
  run: LabRun,
  review: Pick<LabReview, "criterionReviews" | "axisReviews">,
): boolean {
  const criterionIndexes = new Set(review.criterionReviews.map((item) => item.criterionIndex));
  if (
    review.criterionReviews.length !== run.criteria.length
    || criterionIndexes.size !== run.criteria.length
    || [...criterionIndexes].some((index) => index < 0 || index >= run.criteria.length)
  ) return false;

  const proposed = new Set(run.criteria.map((criterion) => criterion.dimension));
  const emptyAxes = CRITERION_DIMENSIONS.filter((dimension) => !proposed.has(dimension));
  const reviewedAxes = new Set(review.axisReviews.map((item) => item.dimension));
  return review.axisReviews.length === emptyAxes.length
    && reviewedAxes.size === emptyAxes.length
    && emptyAxes.every((dimension) => reviewedAxes.has(dimension));
}

function clampLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1) return ANALYSIS_QUALITY_REPORT_DEFAULT_LIMIT;
  return Math.min(value, ANALYSIS_QUALITY_REPORT_MAX_LIMIT);
}
