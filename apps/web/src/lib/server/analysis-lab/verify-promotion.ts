import { eq } from "drizzle-orm";
import {
  promotionReleaseArtifactPath,
  readPromotionReleaseManifest,
  writeImmutablePromotionArtifact,
} from "./promotion-release";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
  type PromotionGrantSnapshot,
} from "./promotion-snapshot";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

export type PromotionVerificationScope = "canary" | "all";

export interface PromotionVerificationIssue {
  grantId: string;
  code:
    | "item_status"
    | "state_hash"
    | "criterion_keys"
    | "question_anchor"
    | "question_definition"
    | "answer_binding_deleted";
  detail: string;
}

function stringSetEquals(left: string[], right: string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function verifyAppliedPromotionSnapshot(input: {
  grantId: string;
  planStableKeys: string[];
  plannedQuestions: Array<{ criterionStableKey: string; definitionSha256: string }>;
  beforeSnapshot: PromotionGrantSnapshot;
  currentSnapshot: PromotionGrantSnapshot;
  expectedStateSha256: string;
}): PromotionVerificationIssue[] {
  const issues: PromotionVerificationIssue[] = [];
  const currentSha = promotionGrantSnapshotStateSha256(input.currentSnapshot);
  if (currentSha !== input.expectedStateSha256) {
    issues.push({
      grantId: input.grantId,
      code: "state_hash",
      detail: `expected ${input.expectedStateSha256}, actual ${currentSha}`,
    });
  }
  const currentStableKeys = input.currentSnapshot.criteria
    .map((criterion) => criterion.stableKey)
    .filter((value): value is string => typeof value === "string");
  if (!stringSetEquals(currentStableKeys, input.planStableKeys)) {
    issues.push({
      grantId: input.grantId,
      code: "criterion_keys",
      detail: "manifest criterion stable key와 현재 DB가 일치하지 않습니다.",
    });
  }
  const criterionIds = new Set(input.currentSnapshot.criteria.map((criterion) => criterion.id));
  const activeQuestions = input.currentSnapshot.questions.filter((question) => question.invalidatedAt === null);
  for (const question of activeQuestions) {
    if (!question.grantCriteriaId || !criterionIds.has(question.grantCriteriaId)) {
      issues.push({
        grantId: input.grantId,
        code: "question_anchor",
        detail: `active question anchor 누락: ${question.id}`,
      });
    }
  }
  for (const planned of input.plannedQuestions) {
    const matches = activeQuestions.filter((question) =>
      question.criterionStableKey === planned.criterionStableKey
      && question.definitionSha256 === planned.definitionSha256);
    if (matches.length !== 1) {
      issues.push({
        grantId: input.grantId,
        code: "question_definition",
        detail: `active semantic question ${matches.length}건: ${planned.criterionStableKey}`,
      });
    }
  }
  const currentBindings = new Map(
    input.currentSnapshot.answerBindings.map((binding) => [binding.questionId, binding]),
  );
  for (const before of input.beforeSnapshot.answerBindings) {
    const current = currentBindings.get(before.questionId);
    if (
      !current
      || current.count < before.count
      || (current.count === before.count && current.identitySha256 !== before.identitySha256)
    ) {
      issues.push({
        grantId: input.grantId,
        code: "answer_binding_deleted",
        detail: `기존 답변 binding이 보존되지 않았습니다: ${before.questionId}`,
      });
    }
  }
  return issues;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  const scope = readArg("scope")?.trim() as PromotionVerificationScope | undefined;
  if (!releaseId) throw new Error("--release가 필요합니다.");
  if (scope !== "canary" && scope !== "all") {
    throw new Error("--scope는 canary 또는 all이어야 합니다.");
  }
  const manifest = await readPromotionReleaseManifest(releaseId);
  const db = getCunoteDb();
  const [release] = await db
    .select()
    .from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId))
    .limit(1);
  if (!release) throw new Error("DB release 원장을 찾지 못했습니다.");
  const expectedReleaseStatus = scope === "canary" ? "canary_passed" : "active";
  const issues: PromotionVerificationIssue[] = [];
  if (release.status !== expectedReleaseStatus) {
    issues.push({
      grantId: "(release)",
      code: "item_status",
      detail: `scope=${scope} 기대 release 상태 ${expectedReleaseStatus}, 실제 ${release.status}`,
    });
  }
  const ledgerItems = await db
    .select()
    .from(schema.analysisLabPromotionItems)
    .where(eq(schema.analysisLabPromotionItems.releaseDbId, release.id));
  const ledgerByGrant = new Map(ledgerItems.map((item) => [item.grantId, item]));
  const confirmedLinks = await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));

  for (const planItem of manifest.plans) {
    const ledgerItem = ledgerByGrant.get(planItem.grantId);
    if (!ledgerItem) {
      issues.push({
        grantId: planItem.grantId,
        code: "item_status",
        detail: "release item 원장이 없습니다.",
      });
      continue;
    }
    const shouldBeApplied = scope === "all" || manifest.canaryGrantIds.includes(planItem.grantId);
    const expectedItemStatus = shouldBeApplied ? "applied" : "prepared";
    if (ledgerItem.status !== expectedItemStatus) {
      issues.push({
        grantId: planItem.grantId,
        code: "item_status",
        detail: `기대 ${expectedItemStatus}, 실제 ${ledgerItem.status}`,
      });
      continue;
    }
    const currentSnapshot = await loadPromotionGrantSnapshot(db, planItem.grantId, confirmedLinks);
    const beforeSnapshot = ledgerItem.beforeSnapshot as unknown as PromotionGrantSnapshot;
    if (shouldBeApplied) {
      if (!ledgerItem.afterSha256) {
        issues.push({
          grantId: planItem.grantId,
          code: "state_hash",
          detail: "applied item의 after hash가 없습니다.",
        });
        continue;
      }
      issues.push(...verifyAppliedPromotionSnapshot({
        grantId: planItem.grantId,
        planStableKeys: planItem.promotionPlan.criterionStableKeys,
        plannedQuestions: planItem.promotionPlan.questions,
        beforeSnapshot,
        currentSnapshot,
        expectedStateSha256: ledgerItem.afterSha256,
      }));
    } else {
      const currentSha = promotionGrantSnapshotStateSha256(currentSnapshot);
      if (currentSha !== ledgerItem.beforeSha256) {
        issues.push({
          grantId: planItem.grantId,
          code: "state_hash",
          detail: `미적용 item baseline drift: expected ${ledgerItem.beforeSha256}, actual ${currentSha}`,
        });
      }
    }
  }

  const artifact = {
    schema: "analysis-lab-promotion-verification-v1",
    releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    scope,
    verifiedAt: new Date().toISOString(),
    checkedItems: manifest.plans.length,
    issueCounts: Object.fromEntries(
      [...new Set(issues.map((issue) => issue.code))]
        .map((code) => [code, issues.filter((issue) => issue.code === code).length]),
    ),
    issues,
    verdict: issues.length === 0 ? "PASS" : "FAIL",
  };
  await writeImmutablePromotionArtifact(
    promotionReleaseArtifactPath(
      releaseId,
      scope === "canary" ? "verification.canary.json" : "verification.all.json",
    ),
    artifact,
  );
  console.log(
    `[verify-promotion] ${artifact.verdict}: ${releaseId} · scope ${scope} · ` +
    `issues ${issues.length}`,
  );
  return issues.length === 0 ? 0 : 2;
}

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 정리 실패는 검증 결과를 가리지 않는다.
  }
}

if (process.argv[1]?.endsWith("verify-promotion.ts")) {
  main()
    .then(async (code) => {
      await closeDbIfLoaded();
      process.exit(code);
    })
    .catch(async (error) => {
      console.error("[verify-promotion] 실패:", error instanceof Error ? error.message : error);
      await closeDbIfLoaded();
      process.exit(1);
    });
}
