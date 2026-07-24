import {
  DEEP_ANALYSIS_ACTIVE_POLICY_VERSION,
  DEEP_ANALYSIS_ACTIVE_TIME_ZONE,
} from "@cunote/contracts";

export interface ActiveDeepAnalysisSourceBaseline {
  activeCount: number;
  activeWithHwpCount: number;
  hwpAttachmentCount: number;
  hwpArchivedCount: number;
  hwpConvertedCount: number;
  hwpFailedCount: number;
  criteriaGrantCount: number;
  deepCriteriaGrantCount: number;
}

export interface ActiveDeepAnalysisBaselineInput {
  generatedAt: string;
  bySource: Record<string, ActiveDeepAnalysisSourceBaseline>;
  promotionReleaseCount: number;
}

export interface ActiveDeepAnalysisBaselineReport {
  schema: "active-deep-analysis-baseline-v1";
  generatedAt: string;
  writeMode: false;
  policy: {
    version: typeof DEEP_ANALYSIS_ACTIVE_POLICY_VERSION;
    timeZone: typeof DEEP_ANALYSIS_ACTIVE_TIME_ZONE;
  };
  totals: ActiveDeepAnalysisSourceBaseline;
  bySource: Record<string, ActiveDeepAnalysisSourceBaseline>;
  promotionReleaseCount: number;
  conservation: {
    activeTotal: number;
    servingCompleteFresh: number;
    analysisCompleteNotPublished: number;
    inProgress: number;
    blockedOrFailed: number;
    stale: number;
    delta: number;
    passed: boolean;
  };
  blockers: Array<{
    code: "deep_analysis_instrumentation_missing";
    count: number;
    message: string;
  }>;
}

export function buildActiveDeepAnalysisBaselineReport(
  input: ActiveDeepAnalysisBaselineInput,
): ActiveDeepAnalysisBaselineReport {
  const totals = Object.values(input.bySource).reduce<ActiveDeepAnalysisSourceBaseline>(
    (sum, row) => ({
      activeCount: sum.activeCount + row.activeCount,
      activeWithHwpCount: sum.activeWithHwpCount + row.activeWithHwpCount,
      hwpAttachmentCount: sum.hwpAttachmentCount + row.hwpAttachmentCount,
      hwpArchivedCount: sum.hwpArchivedCount + row.hwpArchivedCount,
      hwpConvertedCount: sum.hwpConvertedCount + row.hwpConvertedCount,
      hwpFailedCount: sum.hwpFailedCount + row.hwpFailedCount,
      criteriaGrantCount: sum.criteriaGrantCount + row.criteriaGrantCount,
      deepCriteriaGrantCount: sum.deepCriteriaGrantCount + row.deepCriteriaGrantCount,
    }),
    emptySourceBaseline(),
  );

  // Phase A에는 운영 run/stage 원장이 없으므로 기존 criteria를 deep complete로 추정하지 않는다.
  // 모든 활성 공고를 명시 blocker에 넣어 conservation equation을 거짓 없이 닫는다.
  const conservation = {
    activeTotal: totals.activeCount,
    servingCompleteFresh: 0,
    analysisCompleteNotPublished: 0,
    inProgress: 0,
    blockedOrFailed: totals.activeCount,
    stale: 0,
    delta: 0,
    passed: true,
  };

  return {
    schema: "active-deep-analysis-baseline-v1",
    generatedAt: input.generatedAt,
    writeMode: false,
    policy: {
      version: DEEP_ANALYSIS_ACTIVE_POLICY_VERSION,
      timeZone: DEEP_ANALYSIS_ACTIVE_TIME_ZONE,
    },
    totals,
    bySource: input.bySource,
    promotionReleaseCount: input.promotionReleaseCount,
    conservation,
    blockers: totals.activeCount > 0 ? [{
      code: "deep_analysis_instrumentation_missing",
      count: totals.activeCount,
      message: "운영 deep analysis run/stage 원장이 없어 기존 criteria를 완료로 추정하지 않습니다.",
    }] : [],
  };
}

export function emptySourceBaseline(): ActiveDeepAnalysisSourceBaseline {
  return {
    activeCount: 0,
    activeWithHwpCount: 0,
    hwpAttachmentCount: 0,
    hwpArchivedCount: 0,
    hwpConvertedCount: 0,
    hwpFailedCount: 0,
    criteriaGrantCount: 0,
    deepCriteriaGrantCount: 0,
  };
}
