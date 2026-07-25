import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  type CompanyProfile,
  type GrantCriterion,
} from "@cunote/contracts";
import { and, eq, isNotNull, max } from "drizzle-orm";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  sha256Canonical,
  validatePromotionReleaseManifest,
} from "../analysis-lab/promotion-release";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
  type PromotionCriterionSnapshot,
  type PromotionGrantSnapshot,
} from "../analysis-lab/promotion-snapshot";
import { verifyAppliedPromotionSnapshot } from "../analysis-lab/verify-promotion";
import { buildGrantAnalysisShadowMatch } from "../ingestion/grantAnalysisPilotVariants";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { appendVerifiedDeepAnalysisStageReceipt } from "./receipts";
import { prepareDeepAnalysisInput } from "./prepareInput";

loadMonorepoEnv();

export const DEEP_ANALYSIS_SERVING_VERIFIER_VERSION =
  "deep-analysis-serving-verifier-v1" as const;

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  const scope = readArg("scope")?.trim();
  const active = process.argv.includes("--active");
  if (active === Boolean(releaseId)) {
    throw new Error("--active 또는 --release 중 하나만 필요합니다.");
  }
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("R2 환경변수가 필요합니다.");

  if (active) {
    if (scope) throw new Error("--active는 --scope를 받지 않고 active release 전체를 검증합니다.");
    const releaseRows = await db
      .selectDistinct({ releaseId: schema.analysisLabPromotionReleases.releaseId })
      .from(schema.analysisLabPromotionReleases)
      .innerJoin(
        schema.analysisLabPromotionItems,
        eq(
          schema.analysisLabPromotionItems.releaseDbId,
          schema.analysisLabPromotionReleases.id,
        ),
      )
      .where(and(
        eq(schema.analysisLabPromotionReleases.status, "active"),
        isNotNull(schema.analysisLabPromotionItems.deepAnalysisRunId),
      ));
    const results = [];
    for (const release of releaseRows.sort((left, right) =>
      left.releaseId.localeCompare(right.releaseId))) {
      results.push(await verifyRelease({
        db,
        storage,
        releaseId: release.releaseId,
        scope: "all",
      }));
    }
    const failures = results.flatMap((result) => result.failures);
    console.log(JSON.stringify({
      schema: "deep-analysis-active-serving-monitor-v1",
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      checkedReleases: results.length,
      checkedItems: results.reduce((sum, result) => sum + result.checked, 0),
      results,
    }, null, 2));
    return failures.length === 0 ? 0 : 2;
  }

  if (scope !== "canary" && scope !== "all") {
    throw new Error("--scope는 canary 또는 all이어야 합니다.");
  }
  const result = await verifyRelease({
    db,
    storage,
    releaseId: releaseId!,
    scope,
  });
  console.log(JSON.stringify(result, null, 2));
  return result.failures.length === 0 ? 0 : 2;
}

async function verifyRelease(input: {
  db: ReturnType<typeof getCunoteDb>;
  storage: NonNullable<ReturnType<typeof createR2ObjectStorageFromEnv>>;
  releaseId: string;
  scope: "canary" | "all";
}) {
  const { db, storage, releaseId, scope } = input;
  const [release] = await db
    .select()
    .from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId))
    .limit(1);
  if (!release) throw new Error("promotion release 원장이 없습니다.");
  const manifest = validatePromotionReleaseManifest(release.manifest);
  if (
    manifest.releaseId !== releaseId
    || manifest.manifestSha256 !== release.manifestSha256
    || manifest.releasePlanSha256 !== release.releasePlanSha256
  ) {
    throw new Error("DB release 원장과 embedded manifest hash가 일치하지 않습니다.");
  }
  const expectedReleaseStatus = scope === "canary" ? "canary_passed" : "active";
  if (release.status !== expectedReleaseStatus) {
    throw new Error(`release 상태가 ${expectedReleaseStatus}가 아닙니다: ${release.status}`);
  }
  const itemRows = await db
    .select()
    .from(schema.analysisLabPromotionItems)
    .where(eq(schema.analysisLabPromotionItems.releaseDbId, release.id));
  const targetGrantIds = scope === "canary"
    ? manifest.canaryGrantIds
    : manifest.plans.map((item) => item.grantId);
  const targets = itemRows.filter((item) => targetGrantIds.includes(item.grantId));
  if (targets.length !== targetGrantIds.length) throw new Error("serving 검증 대상 item이 누락됐습니다.");
  if (targets.some((item) => item.status !== "applied" || !item.deepAnalysisRunId)) {
    throw new Error("applied deep-analysis promotion item만 serving 검증할 수 있습니다.");
  }

  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const entries = await repositories.grants.listGrantsByIds(targetGrantIds);
  const entryByGrant = new Map(
    entries.flatMap((entry) => entry.grant.id ? [[entry.grant.id, entry] as const] : []),
  );
  const confirmedLinks = await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));
  const planByGrant = new Map(manifest.plans.map((item) => [item.grantId, item]));
  const failures: Array<{ grantId: string; stage: string; issues: string[] }> = [];
  const passed: Array<{
    grantId: string;
    runId: string;
    afterSha256: string;
    repositoryCriteriaSha256: string;
    traceSha256: string;
    sourceRevisionSha256: string;
  }> = [];

  for (const item of targets) {
    const planItem = planByGrant.get(item.grantId);
    const entry = entryByGrant.get(item.grantId);
    const [run] = await db
      .select()
      .from(schema.grantDeepAnalysisRuns)
      .where(eq(schema.grantDeepAnalysisRuns.id, item.deepAnalysisRunId!))
      .limit(1);
    if (!planItem || !entry || !run || !item.afterSha256) {
      failures.push({
        grantId: item.grantId,
        stage: "publication_complete",
        issues: ["promotion plan, repository entry, deep run 또는 after hash 누락"],
      });
      continue;
    }
    const currentSnapshot = await loadPromotionGrantSnapshot(db, item.grantId, confirmedLinks);
    const beforeSnapshot = item.beforeSnapshot as unknown as PromotionGrantSnapshot;
    const publicationIssues = verifyAppliedPromotionSnapshot({
      grantId: item.grantId,
      planStableKeys: planItem.promotionPlan.criterionStableKeys,
      plannedQuestions: planItem.promotionPlan.questions,
      beforeSnapshot,
      currentSnapshot,
      expectedStateSha256: item.afterSha256,
    }).map((issue) => `${issue.code}:${issue.detail}`);
    const publicationEvidence = {
      releaseId,
      releaseDbId: release.id,
      promotionItemId: item.id,
      planSha256: item.planSha256,
      expectedAfterSha256: item.afterSha256,
      actualAfterSha256: promotionGrantSnapshotStateSha256(currentSnapshot),
      issueCount: publicationIssues.length,
      issues: publicationIssues,
    };
    await appendNextReceipt({
      db,
      storage,
      run,
      stage: "publication_complete",
      status: publicationIssues.length === 0 ? "passed" : "failed",
      evidence: publicationEvidence,
    });
    if (publicationIssues.length > 0) {
      failures.push({
        grantId: item.grantId,
        stage: "publication_complete",
        issues: publicationIssues,
      });
      continue;
    }

    const snapshotCriteriaSha256 = sha256Canonical(
      currentSnapshot.criteria.map(toServingCriterion).sort(byCriterionId),
    );
    const repositoryCriteriaSha256 = sha256Canonical(
      entry.criteria.map(toServingCriterion).sort(byCriterionId),
    );
    const traceRows = FIXED_SERVING_PROFILES.map(({ id, profile }) => {
      const match = buildGrantAnalysisShadowMatch({
        entry,
        criteria: entry.criteria,
        company: profile,
        asOf: new Date(manifest.createdAt),
      });
      return {
        profileId: id,
        eligibility: match.eligibility,
        tier: match.review_gate?.tier ?? null,
        score: match.fit_score,
        ruleTrace: match.rule_trace,
      };
    });
    const expectedCriterionIds = currentSnapshot.criteria.map((criterion) => criterion.id).sort();
    const traceIssues: string[] = [];
    if (snapshotCriteriaSha256 !== repositoryCriteriaSha256) {
      traceIssues.push("repository criteria hash가 promotion after snapshot과 다릅니다.");
    }
    for (const trace of traceRows) {
      const traceCriterionIds = trace.ruleTrace
        .map((row) => row.criterion_id)
        .filter((value): value is string => typeof value === "string")
        .sort();
      if (
        traceCriterionIds.length !== expectedCriterionIds.length
        || traceCriterionIds.some((value, index) => value !== expectedCriterionIds[index])
      ) {
        traceIssues.push(`${trace.profileId} matcher rule_trace criterion ID 집합 불일치`);
      }
    }
    const traceSha256 = sha256Canonical(traceRows);
    await appendNextReceipt({
      db,
      storage,
      run,
      stage: "serving_complete",
      status: traceIssues.length === 0 ? "passed" : "failed",
      evidence: {
        releaseId,
        promotionItemId: item.id,
        repository: "drizzle-production-grant-repository",
        matcher: "buildGrantAnalysisShadowMatch/matchNormalizedGrant",
        profileCorpus: FIXED_SERVING_PROFILES.map((profile) => profile.id),
        snapshotCriteriaSha256,
        repositoryCriteriaSha256,
        traceSha256,
        issueCount: traceIssues.length,
        issues: traceIssues,
      },
    });
    if (traceIssues.length > 0) {
      failures.push({
        grantId: item.grantId,
        stage: "serving_complete",
        issues: traceIssues,
      });
      continue;
    }

    const currentInput = await prepareDeepAnalysisInput({
      db,
      storage,
      grantId: item.grantId,
      maxTotalChars: DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
    });
    const freshnessIssues: string[] = [];
    if (!currentInput.sealed) freshnessIssues.push("current input이 sealed가 아닙니다.");
    if (currentInput.sourceRevisionSha256 !== run.sourceRevisionSha256) {
      freshnessIssues.push("current source revision이 serving run과 다릅니다.");
    }
    if (currentInput.inputSha256 !== run.inputSha256) {
      freshnessIssues.push("current input hash가 serving run과 다릅니다.");
    }
    await appendNextReceipt({
      db,
      storage,
      run,
      stage: "analysis_fresh",
      status: freshnessIssues.length === 0 ? "passed" : "stale",
      evidence: {
        releaseId,
        promotionItemId: item.id,
        runSourceRevisionSha256: run.sourceRevisionSha256,
        currentSourceRevisionSha256: currentInput.sourceRevisionSha256,
        runInputSha256: run.inputSha256,
        currentInputSha256: currentInput.inputSha256,
        issueCount: freshnessIssues.length,
        issues: freshnessIssues,
      },
    });
    if (freshnessIssues.length > 0) {
      failures.push({
        grantId: item.grantId,
        stage: "analysis_fresh",
        issues: freshnessIssues,
      });
      continue;
    }
    passed.push({
      grantId: item.grantId,
      runId: run.runId,
      afterSha256: item.afterSha256,
      repositoryCriteriaSha256,
      traceSha256,
      sourceRevisionSha256: run.sourceRevisionSha256,
    });
  }

  return {
    schema: "deep-analysis-serving-verification-v1",
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    releaseId,
    scope,
    checked: targets.length,
    passed,
    failures,
  };
}

async function appendNextReceipt(input: {
  db: ReturnType<typeof getCunoteDb>;
  storage: NonNullable<ReturnType<typeof createR2ObjectStorageFromEnv>>;
  run: typeof schema.grantDeepAnalysisRuns.$inferSelect;
  stage: "publication_complete" | "serving_complete" | "analysis_fresh";
  status: "passed" | "failed" | "stale";
  evidence: Record<string, unknown>;
}): Promise<void> {
  const [attemptRow] = await input.db
    .select({ value: max(schema.grantDeepAnalysisStageReceipts.attempt) })
    .from(schema.grantDeepAnalysisStageReceipts)
    .where(and(
      eq(schema.grantDeepAnalysisStageReceipts.runId, input.run.id),
      eq(schema.grantDeepAnalysisStageReceipts.stage, input.stage),
    ));
  await appendVerifiedDeepAnalysisStageReceipt({
    db: input.db,
    storage: input.storage,
    grantId: input.run.grantId,
    sourceRevisionSha256: input.run.sourceRevisionSha256,
    publicRunId: input.run.runId,
    databaseRunId: input.run.id,
    stage: input.stage,
    status: input.status,
    verifierVersion: DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
    evidence: input.evidence,
    attempt: Number(attemptRow?.value ?? 0) + 1,
  });
}

function toServingCriterion(
  criterion: GrantCriterion | PromotionCriterionSnapshot,
): Record<string, unknown> {
  return {
    id: criterion.id,
    dimension: criterion.dimension,
    operator: criterion.operator,
    value: criterion.value,
    kind: criterion.kind,
    weight: criterion.weight ?? null,
    confidence: criterion.confidence,
    sourceSpan: "sourceSpan" in criterion
      ? criterion.sourceSpan
      : criterion.source_span ?? null,
    rawText: "rawText" in criterion ? criterion.rawText : criterion.raw_text ?? null,
    sourceField: "sourceField" in criterion
      ? criterion.sourceField
      : criterion.source_field ?? null,
    needsReview: "needsReview" in criterion
      ? criterion.needsReview
      : criterion.needs_review ?? false,
    parserVersion: "parserVersion" in criterion
      ? criterion.parserVersion
      : criterion.parser_version ?? null,
  };
}

function byCriterionId(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return String(left.id).localeCompare(String(right.id));
}

const FIXED_SERVING_PROFILES: Array<{ id: string; profile: CompanyProfile }> = [
  {
    id: "unknown-baseline-v1",
    profile: { confidence: {} },
  },
  {
    id: "seoul-software-mature-v1",
    profile: {
      region: { code: "11" },
      biz_age_months: 60,
      founder_age: 38,
      is_preliminary: false,
      industries: ["소프트웨어"],
      industry_codes: ["J", "62"],
      size: "small",
      revenue_krw: 1_000_000_000,
      employees_count: 12,
      business_status: { active: true },
      confidence: {},
    },
  },
  {
    id: "busan-manufacturing-preliminary-v1",
    profile: {
      region: { code: "26" },
      biz_age_months: 0,
      founder_age: 29,
      is_preliminary: true,
      industries: ["제조업"],
      industry_codes: ["C"],
      size: "micro",
      revenue_krw: 0,
      employees_count: 1,
      business_status: { active: true },
      confidence: {},
    },
  },
];

main()
  .then(async (code) => {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(
      "[deep-serving] 실패:",
      error instanceof Error ? error.message : error,
    );
    try {
      const { closeCunoteDb } = await import("../db/client");
      await closeCunoteDb();
    } catch {
      // 원래 오류를 보존한다.
    }
    process.exit(1);
  });
