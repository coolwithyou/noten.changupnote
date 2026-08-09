import type { LabReview } from "./contract";

export const ANALYSIS_QUALITY_POLICY_VERSION = "analysis-quality-v1" as const;

export type AnalysisQualityStatus =
  | "passed"
  | "partial"
  | "held"
  | "failed"
  | "not_evaluated"
  | "not_applicable";

export type AnalysisQualityLane = "deep_analysis" | "application" | "product";

export type AnalysisQualityNodeId =
  | "input_sealed"
  | "deep_contract"
  | "independent_review"
  | "deep_promotion"
  | "matching_canary"
  | "application_source"
  | "field_adjudication"
  | "field_materialization"
  | "workspace_canary";

export interface AnalysisQualityNode {
  id: AnalysisQualityNodeId;
  lane: AnalysisQualityLane;
  label: string;
  status: AnalysisQualityStatus;
  hardGate: boolean;
  summary: string;
  evidence: string[];
  nextAction: string | null;
}

export interface AnalysisQualityEdge {
  from: AnalysisQualityNodeId;
  to: AnalysisQualityNodeId;
  kind: "sequence" | "feedback";
}

export interface AnalysisQualityReviewEvidence {
  source: "human" | "ai_audit";
  review: LabReview;
  complete: boolean;
  currentPolicy: boolean;
}

export interface AnalysisQualityDownstreamEvidence {
  status: "passed" | "failed";
  summary: string;
  evidence?: string[];
}

export interface AnalysisQualityMetrics {
  criteria: number;
  groundedCriteria: number;
  assessedAxes: number;
  ambiguousAxes: number;
  inputMissingAxes: number;
  applicationDocuments: number;
  fieldCandidates: number;
  acceptedFields: number;
  unresolvedFields: number;
  requiredUnresolvedFields: number;
}

export interface AnalysisQualityGraph {
  policyVersion: typeof ANALYSIS_QUALITY_POLICY_VERSION;
  grantId: string;
  runId: string;
  title: string;
  evaluatedAt: string;
  analysisReadiness: AnalysisQualityStatus;
  productReadiness: AnalysisQualityStatus;
  lanes: Record<AnalysisQualityLane, AnalysisQualityStatus>;
  nodes: AnalysisQualityNode[];
  edges: AnalysisQualityEdge[];
  metrics: AnalysisQualityMetrics;
}

export interface AnalysisQualityReportSummary {
  total: number;
  analysis: Record<AnalysisQualityStatus, number>;
  deepAnalysis: Record<AnalysisQualityStatus, number>;
  application: Record<AnalysisQualityStatus, number>;
  product: Record<AnalysisQualityStatus, number>;
  blockers: Array<{ nodeId: AnalysisQualityNodeId; label: string; count: number }>;
}

export interface AnalysisQualityReport {
  policyVersion: typeof ANALYSIS_QUALITY_POLICY_VERSION;
  generatedAt: string;
  selection: "latest-current-run-per-grant";
  requestedLimit: number;
  summary: AnalysisQualityReportSummary;
  graphs: AnalysisQualityGraph[];
}

export function emptyQualityStatusCounts(): Record<AnalysisQualityStatus, number> {
  return {
    passed: 0,
    partial: 0,
    held: 0,
    failed: 0,
    not_evaluated: 0,
    not_applicable: 0,
  };
}
