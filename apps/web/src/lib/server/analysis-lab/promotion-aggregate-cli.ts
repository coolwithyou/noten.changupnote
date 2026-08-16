// Receipt 기반 exact release 전용 aggregate CLI.
// 과거 review/audit 실험 집계는 aggregate.ts에 보존하지만 이 명령 경로에서는 접근하지 않는다.
import { ANALYSIS_LAB_GATES as GATES } from "@/features/dev/analysis-lab/contract";
import { loadAnalysisLabEnv } from "../loadMonorepoEnv";
import { summarizeReviewedRunCosts } from "./aggregate-cost-policy";
import { verifyPromotionReleaseSources } from "./promotion-candidates";
import { evaluatePromotionAggregateEvidence } from "./promotion-gate-evidence";
import {
  PROMOTION_AGGREGATE_SCHEMA,
  promotionReleaseArtifactPath,
  readPromotionReleaseManifest,
  resolvePromotionReleaseTransport,
  writeImmutablePromotionArtifact,
} from "./promotion-release";

loadAnalysisLabEnv();

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function aggregatePromotionRelease(releaseId: string): Promise<number> {
  const manifest = await readPromotionReleaseManifest(releaseId);
  if (manifest.plans.length === 0) throw new Error("release manifest plan이 0건입니다.");
  const sourceByGrantId = new Map(
    manifest.sourceArtifacts.map((source) => [source.grantId, source]),
  );
  const plans = manifest.plans.map((plan) => ({
    ...plan,
    transport: resolvePromotionReleaseTransport(plan, sourceByGrantId.get(plan.grantId)),
  }));
  const costSummary = summarizeReviewedRunCosts(plans, GATES.costPerNoticeMaxUsd);
  const evidence = evaluatePromotionAggregateEvidence({
    plans,
    thresholds: GATES,
    apiCostGate: costSummary.apiCostGate,
  });

  // verifier unavailable은 immutable write 전에 throw하고, 실제 drift만 artifact에 봉인한다.
  const sourceDrift = await verifyPromotionReleaseSources(manifest.sourceArtifacts);
  const blockingGates = evidence.gates.filter((gate) => gate.blocking);
  const go = blockingGates.every((gate) => gate.pass) && sourceDrift.length === 0;
  const artifact = {
    schema: PROMOTION_AGGREGATE_SCHEMA,
    releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    createdAt: new Date().toISOString(),
    noticeCount: plans.length,
    evidenceMode: evidence.mode,
    totals: {
      ...evidence.reviewTotals,
      currentTotal: evidence.currentCriteriaCount,
      published: evidence.publishedCriteriaCount,
      structured: evidence.structuredCriteriaCount,
    },
    qualityEvidence: {
      reviewedNoticeCount: evidence.reviewedNoticeCount,
      sealedNoticeCount: evidence.sealedNoticeCount,
      sealedAcceptedNoticeCount: evidence.sealedAcceptedNoticeCount,
      decidedReviewCount: evidence.decidedReviewCount,
    },
    effectiveReviewTotals: evidence.effectiveReviewTotals,
    costTelemetry: costSummary,
    gates: evidence.gates,
    sourceDrift,
    verdict: go
      ? "GO"
      : blockingGates.filter((gate) => gate.pass).length >= blockingGates.length - 1
        ? "ITERATE"
        : "STOP",
  };
  await writeImmutablePromotionArtifact(
    promotionReleaseArtifactPath(releaseId, "aggregate.json"),
    artifact,
  );
  console.log(
    `[aggregate] release ${artifact.verdict}: ${releaseId} · `
    + `blocking gate ${blockingGates.filter((gate) => gate.pass).length}/${blockingGates.length}`
    + ` · observed metric ${evidence.gates.filter((gate) => gate.pass).length}/${evidence.gates.length}`
    + ` · source drift ${sourceDrift.length}`,
  );
  return go ? 0 : 2;
}

async function main(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  if (!releaseId) {
    throw new Error("--release가 필요합니다. 과거 review/audit 집계는 lab:review:aggregate로 분리됐습니다.");
  }
  return aggregatePromotionRelease(releaseId);
}

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 집계 결과보다 정리 오류를 우선하지 않는다.
  }
}

main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[aggregate] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });
