import {
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  DEEP_ANALYSIS_PROMPT_VERSION,
} from "@cunote/contracts";
import { sha256Canonical } from "../analysis-lab/promotion-release";

export const DEEP_ANALYSIS_LAYER_REBUILD_SCHEMA =
  "deep-analysis-layer-rebuild-plan-v2" as const;
export const DEEP_ANALYSIS_LAYER_REBUILD_LOCK =
  "cunote:deep-analysis-layer-rebuild:v1" as const;

export type DeepAnalysisLayerRebuildMode =
  | "preserve_current"
  | "fresh_start";

export interface DeepAnalysisLayerKeepRun {
  id: string;
  jobId: string;
  runId: string;
  grantId: string;
  title: string;
  completedAt: string;
  costUsd: number | null;
  latestAuditVerdict: string;
  automationRoute: string | null;
}

export interface DeepAnalysisLayerCounts {
  grants: number;
  attachmentArchives: number;
  applicationSurfaces: number;
  documentArtifacts: number;
  nonFieldDocumentArtifacts: number;
  pageImageArtifacts: number;
  jobs: number;
  workerHeartbeats: number;
  runs: number;
  stageReceipts: number;
  axisResults: number;
  audits: number;
  exceptionEvents: number;
  promotionReleases: number;
  promotionItems: number;
  criteria: number;
  confirmationQuestions: number;
  companyConfirmations: number;
  matchState: number;
  landingObservations: number;
  applicationPrecomputeJobs: number;
  applicationPrecomputeAttempts: number;
  applicationPrecomputeWorkerHeartbeats: number;
  fieldCandidateArtifacts: number;
  documentFields: number;
  fieldsReadySurfaces: number;
  leasedJobs: number;
  leasedApplicationPrecomputeJobs: number;
  leasedApplicationPrecomputeAttempts: number;
}

export interface DeepAnalysisLayerDeleteCounts {
  jobs: number;
  workerHeartbeats: number;
  runs: number;
  stageReceipts: number;
  axisResults: number;
  audits: number;
  exceptionEvents: number;
  promotionReleases: number;
  promotionItems: number;
  criteria: number;
  confirmationQuestions: number;
  companyConfirmations: number;
  matchState: number;
  landingObservations: number;
  applicationPrecomputeJobs: number;
  applicationPrecomputeAttempts: number;
  applicationPrecomputeWorkerHeartbeats: number;
  fieldCandidateArtifacts: number;
  documentFields: number;
}

export interface DeepAnalysisLayerResetCounts {
  fieldsReadySurfaces: number;
}

export interface DeepAnalysisLayerRebuildState {
  mode: DeepAnalysisLayerRebuildMode;
  source: {
    gitCommit: string;
    gitTree: string;
    gitDirty: boolean;
    implementationSha256: string;
  };
  policy: {
    modelPolicyVersion: typeof DEEP_ANALYSIS_MODEL_POLICY_VERSION;
    promptVersion: typeof DEEP_ANALYSIS_PROMPT_VERSION;
  };
  keepRuns: DeepAnalysisLayerKeepRun[];
  before: DeepAnalysisLayerCounts;
  delete: DeepAnalysisLayerDeleteCounts;
  reset: DeepAnalysisLayerResetCounts;
  preserve: {
    grants: number;
    attachmentArchives: number;
    applicationSurfaces: number;
    nonFieldDocumentArtifacts: number;
    pageImageArtifacts: number;
    jobs: number;
    runs: number;
    stageReceipts: number;
    axisResults: number;
    audits: number;
    exceptionEvents: number;
  };
}

export interface DeepAnalysisLayerRebuildPlan
  extends DeepAnalysisLayerRebuildState {
  schema: typeof DEEP_ANALYSIS_LAYER_REBUILD_SCHEMA;
  generatedAt: string;
  gitCommit: string;
  gitTree: string;
  stateSha256: string;
}

export function createDeepAnalysisLayerRebuildPlan(input: {
  generatedAt: string;
  gitCommit: string;
  gitTree: string;
  gitDirty: boolean;
  implementationSha256: string;
  mode: DeepAnalysisLayerRebuildMode;
  keepRuns: DeepAnalysisLayerKeepRun[];
  before: DeepAnalysisLayerCounts;
  deleteCounts: DeepAnalysisLayerRebuildState["delete"];
  resetCounts: DeepAnalysisLayerRebuildState["reset"];
  preserve: DeepAnalysisLayerRebuildState["preserve"];
}): DeepAnalysisLayerRebuildPlan {
  const state: DeepAnalysisLayerRebuildState = {
    mode: input.mode,
    source: {
      gitCommit: input.gitCommit,
      gitTree: input.gitTree,
      gitDirty: input.gitDirty,
      implementationSha256: input.implementationSha256,
    },
    policy: {
      modelPolicyVersion: DEEP_ANALYSIS_MODEL_POLICY_VERSION,
      promptVersion: DEEP_ANALYSIS_PROMPT_VERSION,
    },
    keepRuns: [...input.keepRuns].sort((left, right) =>
      left.grantId.localeCompare(right.grantId)),
    before: input.before,
    delete: input.deleteCounts,
    reset: input.resetCounts,
    preserve: input.preserve,
  };
  return {
    schema: DEEP_ANALYSIS_LAYER_REBUILD_SCHEMA,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    gitTree: input.gitTree,
    ...state,
    stateSha256: sha256Canonical(state),
  };
}

export function assertDeepAnalysisLayerRebuildConfirmation(
  plan: DeepAnalysisLayerRebuildPlan,
  confirmation: string | undefined,
): void {
  const normalized = confirmation?.trim().toLowerCase() ?? "";
  if (normalized.length < 12 || !plan.stateSha256.startsWith(normalized)) {
    throw new Error(
      "--confirm에는 dry-run stateSha256의 앞 12자 이상이 필요합니다.",
    );
  }
}

export function assertDeepAnalysisLayerRebuildPreconditions(
  plan: DeepAnalysisLayerRebuildPlan,
): void {
  if (plan.before.leasedJobs > 0) {
    throw new Error(
      `leased 딥분석 job ${plan.before.leasedJobs}건이 있어 재구축할 수 없습니다.`,
    );
  }
  if (plan.before.leasedApplicationPrecomputeJobs > 0) {
    throw new Error(
      `leased Kordoc job ${plan.before.leasedApplicationPrecomputeJobs}건이 있어 재구축할 수 없습니다.`,
    );
  }
  if (plan.before.leasedApplicationPrecomputeAttempts > 0) {
    throw new Error(
      `leased Kordoc attempt ${plan.before.leasedApplicationPrecomputeAttempts}건이 있어 재구축할 수 없습니다.`,
    );
  }
  if (plan.mode === "preserve_current" && plan.keepRuns.length === 0) {
    throw new Error(
      "현재 정책으로 검증된 최신 통과 run이 0건이어서 재구축을 중단합니다.",
    );
  }
  if (plan.mode === "fresh_start" && plan.keepRuns.length > 0) {
    throw new Error("fresh-start 계획은 딥분석 run을 보존할 수 없습니다.");
  }
  if (
    plan.keepRuns.some((run) =>
      run.latestAuditVerdict !== "concur"
      && run.latestAuditVerdict !== "unsure")
  ) {
    throw new Error("보존 후보에 허용되지 않은 AI 검수 판정이 있습니다.");
  }
}
