import { and, eq, inArray } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { verifyPromotionApplicationPrecomputeReceipt } from "./application-precompute-release";
import {
  promotionVerificationArtifactPath,
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
    | "answer_binding_deleted"
    | "application_precompute_receipt"
    | "application_precompute_state";
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

export function parsePromotionVerificationAttempt(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^\d+$/u.test(value)) {
    throw new Error("--attempt는 1 이상의 정수여야 합니다.");
  }
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("--attempt는 1 이상의 정수여야 합니다.");
  }
  return attempt;
}

export function assertPromotionVerificationStatusReady(
  scope: PromotionVerificationScope,
  status: string,
): void {
  if (
    (scope === "canary" && status === "canary_running")
    || (scope === "all" && status === "applying")
  ) {
    throw new Error(
      `release ${scope} 쓰기가 진행 중입니다(${status}). 완료 뒤 검증해야 하며 FAIL artifact는 기록하지 않습니다.`,
    );
  }
}

async function assertPreviousVerificationAttemptFailed(input: {
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  scope: PromotionVerificationScope;
  attempt: number;
}): Promise<void> {
  if (input.attempt === 1) return;
  const previousPath = promotionVerificationArtifactPath(
    input.releaseId,
    input.scope,
    input.attempt - 1,
  );
  let previous: unknown;
  try {
    previous = JSON.parse(await readFile(previousPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `이전 verification attempt ${input.attempt - 1} artifact를 읽지 못했습니다: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    previous === null
    || typeof previous !== "object"
    || (previous as Record<string, unknown>).releaseId !== input.releaseId
    || (previous as Record<string, unknown>).releasePlanSha256 !== input.releasePlanSha256
    || (previous as Record<string, unknown>).manifestSha256 !== input.manifestSha256
    || (previous as Record<string, unknown>).scope !== input.scope
    || (previous as Record<string, unknown>).verdict !== "FAIL"
  ) {
    throw new Error("이전 verification attempt가 같은 release의 FAIL artifact가 아닙니다.");
  }
}

async function main(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  const scope = readArg("scope")?.trim() as PromotionVerificationScope | undefined;
  const attempt = parsePromotionVerificationAttempt(readArg("attempt")?.trim());
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
  assertPromotionVerificationStatusReady(scope, release.status);
  await assertPreviousVerificationAttemptFailed({
    releaseId,
    releasePlanSha256: manifest.releasePlanSha256,
    manifestSha256: manifest.manifestSha256,
    scope,
    attempt,
  });
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
  const sourceArtifactByGrantId = new Map(
    manifest.sourceArtifacts.map((artifact) => [artifact.grantId, artifact]),
  );
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
      const applicationEvidence = sourceArtifactByGrantId.get(planItem.grantId)
        ?.applicationPrecompute;
      if (applicationEvidence) {
        const surfaces = await db
          .select({
            id: schema.grantApplicationSurfaces.id,
            extractionStatus: schema.grantApplicationSurfaces.extractionStatus,
          })
          .from(schema.grantApplicationSurfaces)
          .where(and(
            eq(schema.grantApplicationSurfaces.grantId, planItem.grantId),
            eq(schema.grantApplicationSurfaces.type, "file_template"),
            inArray(schema.grantApplicationSurfaces.format, ["hwp", "hwpx"]),
          ));
        const surfaceIds = surfaces.map((surface) => surface.id);
        const [fieldRows, artifactRows] = surfaceIds.length === 0
          ? [[], []]
          : await Promise.all([
              db
                .select({ id: schema.grantDocumentFields.id })
                .from(schema.grantDocumentFields)
                .where(inArray(schema.grantDocumentFields.surfaceId, surfaceIds)),
              db
                .select({ id: schema.documentArtifacts.id })
                .from(schema.documentArtifacts)
                .where(and(
                  inArray(schema.documentArtifacts.surfaceId, surfaceIds),
                  eq(schema.documentArtifacts.kind, "field_candidates"),
                )),
            ]);
        const precomputeIssues = verifyPromotionApplicationPrecomputeReceipt({
          receipt: ledgerItem.applicationPrecomputeReceipt,
          evidence: applicationEvidence,
          observedFieldCount: fieldRows.length,
          observedFieldsReadySurfaceCount: surfaces.filter(
            (surface) => surface.extractionStatus === "fields_ready",
          ).length,
          observedArtifactCount: artifactRows.length,
        });
        for (const issue of precomputeIssues) {
          issues.push({
            grantId: planItem.grantId,
            code: issue === "receipt_mismatch"
              ? "application_precompute_receipt"
              : "application_precompute_state",
            detail: issue,
          });
        }
      }
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
    attempt,
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
    promotionVerificationArtifactPath(releaseId, scope, attempt),
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
