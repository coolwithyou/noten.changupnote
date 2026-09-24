import { createHash } from "node:crypto";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import {
  canonicalLegacyQuestionMigrationReviewJson,
} from "@cunote/contracts/legacy-question-migration-review";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import { acquireGrantPublicationLock } from "../ingestion/grantPublicationLock";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import { questionDefinitionSha256, sourceSpanHash } from "../analysis-lab/promote";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
} from "../analysis-serving/promotionSnapshot";
import { validatePromotionReleaseManifest } from "../analysis-serving/promotionReleaseContract";
import {
  LEGACY_QUESTION_MIGRATION_RELEASE_PLAN_SCHEMA,
  LEGACY_QUESTION_MIGRATION_RELEASE_PROMPT_VERSION,
  serializeLegacyQuestionMigrationReleasePlan,
  type LegacyQuestionMigrationReleaseOperation,
  type LegacyQuestionMigrationReleasePlan,
} from "./legacyQuestionMigrationReleasePlan";
import {
  loadLegacyQuestionMigrationServingStates,
  promotionStateMatchesParentOrMigration,
} from "./legacyQuestionMigrationServing";

const BEFORE_SCHEMA = "legacy-question-migration-before-v1" as const;
const AFTER_SCHEMA = "legacy-question-migration-after-v1" as const;

type ConfirmationQuestionRow = typeof schema.grantConfirmationQuestions.$inferSelect;

interface QuestionSnapshot {
  id: string;
  grantId: string;
  grantCriteriaId: string | null;
  evaluationCriterionId: string | null;
  evaluationContractVersion: string | null;
  sourceRevisionSha256: string | null;
  sourceRawSha256: string | null;
  criterionStableKey: string | null;
  definitionSha256: string;
  version: number;
  supersedesQuestionId: string | null;
  criterionRef: Record<string, unknown> | null;
  prompt: string;
  options: Array<Record<string, unknown>>;
  answerType: string;
  reusable: string;
  conditionKey: string | null;
  promptVer: string;
  provenance: Record<string, unknown>;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  createdAt: string;
}

interface LegacyQuestionMigrationBeforeSnapshot {
  schema: typeof BEFORE_SCHEMA;
  grantId: string;
  criterion: {
    id: string;
    grantId: string;
    stableKey: string | null;
    dimension: string;
    kind: string;
    sourceSpan: string | null;
  };
  source: {
    sourceRevisionSha256: string;
    sourceRawSha256: string;
  };
  legacyQuestion: QuestionSnapshot;
  legacyAnswerCount: number;
}

interface LegacyQuestionMigrationAfterSnapshot {
  schema: typeof AFTER_SCHEMA;
  grantId: string;
  legacyQuestion: QuestionSnapshot;
  migratedQuestion: QuestionSnapshot;
}

export interface LegacyQuestionMigrationReleaseResult {
  releaseId: string;
  itemCount: number;
  replayed: boolean;
}

/** offline plan을 실제 질문 쓰기와 분리된 DB 원장에 준비한다. 이 함수는 승인이나 적용을 하지 않는다. */
export async function prepareLegacyQuestionMigrationReleaseLedger(input: {
  db: CunoteDb;
  plan: LegacyQuestionMigrationReleasePlan;
  createdBy: string;
  gitCommit: string;
  buildDigest: string;
  releaseId?: string;
}): Promise<{ releaseDbId: string; releaseId: string; itemIds: string[]; replayed: boolean }> {
  const plan = assertReleasePlan(input.plan);
  const releaseId = input.releaseId?.trim()
    || `legacy-question-migration-${plan.contentSha256.slice(0, 24)}`;
  if (!input.createdBy.trim() || !input.gitCommit.trim() || !input.buildDigest.trim()) {
    throw new Error("이관 release 원장 actor/git/build 결속이 필요합니다.");
  }
  return input.db.transaction(async (tx) => {
    await lockGrantIds(tx, plan.operations.map((operation) => operation.grantId));
    const existing = await loadRelease(tx, releaseId);
    if (existing) return assertPreparedReplay(tx, existing, releaseId, plan);

    const beforeByQuestion = new Map<string, LegacyQuestionMigrationBeforeSnapshot>();
    const parentByGrant = new Map<string, Awaited<ReturnType<typeof loadCurrentLegacyQuestionMigrationParent>>>();
    for (const grantId of uniqueGrantIds(plan)) {
      parentByGrant.set(grantId, await loadCurrentLegacyQuestionMigrationParent(tx, grantId));
    }
    for (const operation of sortedOperations(plan)) {
      const before = await loadBeforeSnapshot(tx, operation, true);
      assertOperationBaseline(operation, before);
      await assertNoExistingSuccessor(tx, operation);
      beforeByQuestion.set(operation.legacyQuestion.id, before);
    }
    const [release] = await tx.insert(schema.analysisLabPromotionReleases).values({
      releaseId,
      revision: 1,
      manifestSha256: plan.contentSha256,
      releasePlanSha256: plan.contentSha256,
      manifest: plan as unknown as Record<string, unknown>,
      gitCommit: input.gitCommit,
      buildDigest: input.buildDigest,
      status: "prepared",
      createdBy: input.createdBy,
    }).returning({ id: schema.analysisLabPromotionReleases.id });
    if (!release) throw new Error("이관 release 원장 생성에 실패했습니다.");
    const itemIds: string[] = [];
    for (const operation of sortedOperations(plan)) {
      const before = beforeByQuestion.get(operation.legacyQuestion.id)!;
      const parent = parentByGrant.get(operation.grantId)!;
      const [item] = await tx.insert(schema.analysisLabLegacyQuestionMigrationItems).values({
        releaseDbId: release.id,
        grantId: operation.grantId,
        criterionId: operation.criterionId,
        parentPromotionItemId: parent.promotionItemId,
        legacyQuestionId: operation.legacyQuestion.id,
        planSha256: plan.contentSha256,
        operationSha256: operationSha256(operation),
        beforeSnapshot: before as unknown as Record<string, unknown>,
        beforeSha256: snapshotSha256(before),
        beforeServingSha256: parent.currentServingStateSha256,
        status: "prepared",
      }).returning({ id: schema.analysisLabLegacyQuestionMigrationItems.id });
      if (!item) throw new Error(`이관 item 원장 생성에 실패했습니다: ${operation.legacyQuestion.id}`);
      itemIds.push(item.id);
    }
    return { releaseDbId: release.id, releaseId, itemIds, replayed: false };
  });
}

/** 준비자와 다른 actor가 exact plan hash를 승인한 경우에만 writer admission을 연다. */
export async function approveLegacyQuestionMigrationRelease(input: {
  db: CunoteDb;
  plan: LegacyQuestionMigrationReleasePlan;
  releaseId: string;
  approvedBy: string;
  approvalArtifactSha256: string;
}): Promise<void> {
  const plan = assertReleasePlan(input.plan);
  assertSha256(input.approvalArtifactSha256, "approval artifact");
  await input.db.transaction(async (tx) => {
    const release = await requireBoundRelease(tx, input.releaseId, plan);
    if (release.status === "approved") {
      if (
        release.approvedBy !== input.approvedBy
        || release.approvalArtifactSha256 !== input.approvalArtifactSha256
      ) throw new Error("이관 release의 기존 승인 결속이 다릅니다.");
      return;
    }
    if (release.status !== "prepared") {
      throw new Error(`이관 release 승인 가능 상태가 아닙니다: ${release.status}`);
    }
    if (!input.approvedBy.trim() || release.createdBy === input.approvedBy) {
      throw new Error("이관 release 준비자와 승인자는 달라야 합니다.");
    }
    const updated = await tx.update(schema.analysisLabPromotionReleases).set({
      status: "approved",
      approvedBy: input.approvedBy,
      approvedAt: new Date(),
      approvalArtifactSha256: input.approvalArtifactSha256,
    }).where(and(
      eq(schema.analysisLabPromotionReleases.id, release.id),
      eq(schema.analysisLabPromotionReleases.status, "prepared"),
    )).returning({ id: schema.analysisLabPromotionReleases.id });
    if (updated.length !== 1) throw new Error("이관 release 승인 CAS가 실패했습니다.");
  });
}

/** exact 질문 이관과 match state 무효화, receipt 기록을 한 transaction으로 적용한다. */
export async function applyLegacyQuestionMigrationRelease(input: {
  db: CunoteDb;
  plan: LegacyQuestionMigrationReleasePlan;
  releaseId: string;
  executedBy: string;
}): Promise<LegacyQuestionMigrationReleaseResult> {
  const plan = assertReleasePlan(input.plan);
  if (!input.executedBy.trim()) throw new Error("이관 실행 actor가 필요합니다.");
  return input.db.transaction(async (tx) => {
    await lockGrantIds(tx, plan.operations.map((operation) => operation.grantId));
    const release = await requireBoundRelease(tx, input.releaseId, plan);
    const items = await loadBoundItems(tx, release.id, plan);
    if (release.status === "active") {
      await assertAppliedItemsCurrent(tx, plan, items);
      return { releaseId: input.releaseId, itemCount: items.length, replayed: true };
    }
    if (release.status !== "approved") {
      throw new Error(`이관 release 적용 가능 상태가 아닙니다: ${release.status}`);
    }
    for (const grantId of uniqueGrantIds(plan)) {
      const parent = await loadCurrentLegacyQuestionMigrationParent(tx, grantId);
      const grantItems = items.filter((item) => item.grantId === grantId);
      if (grantItems.some((item) =>
        item.parentPromotionItemId !== parent.promotionItemId
        || item.beforeServingSha256 !== parent.currentServingStateSha256)) {
        throw new Error(`serving_baseline_drift: ${grantId}`);
      }
    }
    await updateReleaseStatus(tx, release.id, "approved", "applying", input.executedBy);
    const links = await loadConfirmedLinks(tx);
    for (const operation of sortedOperations(plan)) {
      const item = items.find((candidate) => candidate.legacyQuestionId === operation.legacyQuestion.id)!;
      if (item.status !== "prepared") {
        throw new Error(`이관 item 적용 가능 상태가 아닙니다: ${item.status}`);
      }
      const before = await loadBeforeSnapshot(tx, operation, true);
      assertOperationBaseline(operation, before);
      await assertNoExistingSuccessor(tx, operation);
      if (item.beforeSha256 !== snapshotSha256(before)) {
        throw new Error(`baseline_drift: ${operation.legacyQuestion.id}`);
      }
      const applying = await tx.update(schema.analysisLabLegacyQuestionMigrationItems).set({
        status: "applying",
        error: null,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.analysisLabLegacyQuestionMigrationItems.id, item.id),
        eq(schema.analysisLabLegacyQuestionMigrationItems.status, "prepared"),
      )).returning({ id: schema.analysisLabLegacyQuestionMigrationItems.id });
      if (applying.length !== 1) throw new Error("이관 item 적용 CAS가 실패했습니다.");

      const invalidatedAt = new Date();
      const invalidated = await tx.update(schema.grantConfirmationQuestions).set({
        grantCriteriaId: null,
        evaluationCriterionId: null,
        invalidatedAt,
        invalidationReason: operation.retireLegacy.invalidationReason,
      }).where(and(
        eq(schema.grantConfirmationQuestions.id, operation.legacyQuestion.id),
        eq(schema.grantConfirmationQuestions.grantId, operation.grantId),
        isNull(schema.grantConfirmationQuestions.invalidatedAt),
      )).returning({ id: schema.grantConfirmationQuestions.id });
      if (invalidated.length !== 1) throw new Error(`legacy 질문 비활성화 CAS가 실패했습니다: ${operation.legacyQuestion.id}`);

      const versionRows = await tx.select({ version: schema.grantConfirmationQuestions.version })
        .from(schema.grantConfirmationQuestions)
        .where(and(
          eq(schema.grantConfirmationQuestions.grantId, operation.grantId),
          eq(schema.grantConfirmationQuestions.criterionStableKey, operation.criterionStableKey),
        ));
      const version = Math.max(
        operation.question.minimumVersion,
        ...versionRows.map((row) => row.version + 1),
      );
      const [migrated] = await tx.insert(schema.grantConfirmationQuestions).values({
        grantId: operation.grantId,
        grantCriteriaId: null,
        evaluationCriterionId: operation.criterionId,
        evaluationContractVersion: operation.question.evaluationContractVersion,
        sourceRevisionSha256: operation.question.sourceRevisionSha256,
        sourceRawSha256: operation.question.sourceRawSha256,
        criterionStableKey: operation.question.criterionStableKey,
        definitionSha256: operation.question.definitionSha256,
        version,
        supersedesQuestionId: operation.question.supersedesQuestionId,
        criterionRef: operation.question.criterionRef,
        prompt: operation.question.prompt,
        options: [...operation.question.options],
        answerType: operation.question.answerType,
        reusable: operation.question.reusable,
        conditionKey: operation.question.conditionKey,
        promptVer: operation.question.promptVer,
        provenance: {
          ...operation.question.provenance,
          releaseId: input.releaseId,
          planSha256: plan.contentSha256,
        },
      }).returning({ id: schema.grantConfirmationQuestions.id });
      if (!migrated) throw new Error(`v2 질문 생성에 실패했습니다: ${operation.legacyQuestion.id}`);
      await invalidateMatchStates(tx, operation.grantId, links);
      const after = await loadAfterSnapshot(tx, operation.grantId, operation.legacyQuestion.id, migrated.id);
      assertAppliedSnapshot(operation, after);
      const applied = await tx.update(schema.analysisLabLegacyQuestionMigrationItems).set({
        migratedQuestionId: migrated.id,
        afterSnapshot: after as unknown as Record<string, unknown>,
        afterSha256: snapshotSha256(after),
        status: "applied",
        error: null,
        appliedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(schema.analysisLabLegacyQuestionMigrationItems.id, item.id),
        eq(schema.analysisLabLegacyQuestionMigrationItems.status, "applying"),
      )).returning({ id: schema.analysisLabLegacyQuestionMigrationItems.id });
      if (applied.length !== 1) throw new Error("이관 item receipt CAS가 실패했습니다.");
    }
    for (const grantId of uniqueGrantIds(plan)) {
      const current = await loadPromotionGrantSnapshot(tx, grantId);
      const servingStateSha256 = promotionGrantSnapshotStateSha256(current);
      const updated = await tx.update(schema.analysisLabLegacyQuestionMigrationItems).set({
        servingStateSha256,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.analysisLabLegacyQuestionMigrationItems.releaseDbId, release.id),
        eq(schema.analysisLabLegacyQuestionMigrationItems.grantId, grantId),
        eq(schema.analysisLabLegacyQuestionMigrationItems.status, "applied"),
      )).returning({ id: schema.analysisLabLegacyQuestionMigrationItems.id });
      if (updated.length !== items.filter((item) => item.grantId === grantId).length) {
        throw new Error(`이관 serving receipt CAS가 실패했습니다: ${grantId}`);
      }
    }
    await updateReleaseStatus(tx, release.id, "applying", "active", input.executedBy);
    return { releaseId: input.releaseId, itemCount: items.length, replayed: false };
  });
}

/** 현재 after receipt가 그대로이고 새 질문에 답변이 없을 때만 질문 두 건을 제한 롤백한다. */
export async function rollbackLegacyQuestionMigrationRelease(input: {
  db: CunoteDb;
  plan: LegacyQuestionMigrationReleasePlan;
  releaseId: string;
  executedBy: string;
}): Promise<LegacyQuestionMigrationReleaseResult> {
  const plan = assertReleasePlan(input.plan);
  if (!input.executedBy.trim()) throw new Error("이관 rollback actor가 필요합니다.");
  return input.db.transaction(async (tx) => {
    await lockGrantIds(tx, plan.operations.map((operation) => operation.grantId));
    const release = await requireBoundRelease(tx, input.releaseId, plan);
    const items = await loadBoundItems(tx, release.id, plan);
    if (release.status === "rolled_back") {
      if (items.some((item) => item.status !== "rolled_back")) {
        throw new Error("이관 rollback 원장 상태가 불완전합니다.");
      }
      return { releaseId: input.releaseId, itemCount: items.length, replayed: true };
    }
    if (release.status !== "active") {
      throw new Error(`이관 release rollback 가능 상태가 아닙니다: ${release.status}`);
    }
    for (const grantId of uniqueGrantIds(plan)) {
      const grantItems = items.filter((item) => item.grantId === grantId);
      const servingStateSha256 = grantItems[0]?.servingStateSha256;
      if (!servingStateSha256 || grantItems.some((item) =>
        item.servingStateSha256 !== servingStateSha256)) {
        throw new Error(`이관 serving receipt가 불완전합니다: ${grantId}`);
      }
      const current = await loadPromotionGrantSnapshot(tx, grantId);
      if (promotionGrantSnapshotStateSha256(current) !== servingStateSha256) {
        throw new Error(`serving_after_drift: ${grantId}`);
      }
    }
    for (const item of items) {
      if (!item.migratedQuestionId || item.status !== "applied" || !item.afterSha256) {
        throw new Error(`rollback 가능한 applied item이 아닙니다: ${item.legacyQuestionId}`);
      }
      const [legacyAnswers, migratedAnswers] = await Promise.all([
        answerCount(tx, item.legacyQuestionId),
        answerCount(tx, item.migratedQuestionId),
      ]);
      if (legacyAnswers > 0 || migratedAnswers > 0) {
        throw new Error(`post_migration_answers_present: ${item.migratedQuestionId}`);
      }
      const current = await loadAfterSnapshot(
        tx,
        item.grantId,
        item.legacyQuestionId,
        item.migratedQuestionId,
      );
      if (snapshotSha256(current) !== item.afterSha256) {
        throw new Error(`after_drift: ${item.legacyQuestionId}`);
      }
    }
    await updateReleaseStatus(tx, release.id, "active", "rolling_back", input.executedBy);
    const links = await loadConfirmedLinks(tx);
    for (const operation of [...sortedOperations(plan)].reverse()) {
      const item = items.find((candidate) => candidate.legacyQuestionId === operation.legacyQuestion.id)!;
      const before = parseBeforeSnapshot(item.beforeSnapshot);
      const rolling = await tx.update(schema.analysisLabLegacyQuestionMigrationItems).set({
        status: "rolling_back",
        updatedAt: new Date(),
      }).where(and(
        eq(schema.analysisLabLegacyQuestionMigrationItems.id, item.id),
        eq(schema.analysisLabLegacyQuestionMigrationItems.status, "applied"),
      )).returning({ id: schema.analysisLabLegacyQuestionMigrationItems.id });
      if (rolling.length !== 1) throw new Error("이관 rollback item CAS가 실패했습니다.");

      const retiredSuccessor = await tx.update(schema.grantConfirmationQuestions).set({
        grantCriteriaId: null,
        evaluationCriterionId: null,
        invalidatedAt: new Date(),
        invalidationReason: "legacy_question_migration_rolled_back",
      }).where(eq(schema.grantConfirmationQuestions.id, item.migratedQuestionId!))
        .returning({ id: schema.grantConfirmationQuestions.id });
      if (retiredSuccessor.length !== 1) throw new Error("이관 successor rollback에 실패했습니다.");
      const restored = await tx.update(schema.grantConfirmationQuestions).set({
        grantCriteriaId: before.legacyQuestion.grantCriteriaId,
        evaluationCriterionId: before.legacyQuestion.evaluationCriterionId,
        invalidatedAt: before.legacyQuestion.invalidatedAt
          ? new Date(before.legacyQuestion.invalidatedAt)
          : null,
        invalidationReason: before.legacyQuestion.invalidationReason,
      }).where(eq(schema.grantConfirmationQuestions.id, item.legacyQuestionId))
        .returning({ id: schema.grantConfirmationQuestions.id });
      if (restored.length !== 1) throw new Error("legacy 질문 rollback에 실패했습니다.");
      const restoredBefore = await loadBeforeSnapshot(tx, operation, true);
      if (snapshotSha256(restoredBefore) !== item.beforeSha256) {
        throw new Error(`rollback_restore_mismatch: ${item.legacyQuestionId}`);
      }
      await invalidateMatchStates(tx, item.grantId, links);
      const receipt = await tx.update(schema.analysisLabLegacyQuestionMigrationItems).set({
        status: "rolled_back",
        error: null,
        rolledBackAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(schema.analysisLabLegacyQuestionMigrationItems.id, item.id),
        eq(schema.analysisLabLegacyQuestionMigrationItems.status, "rolling_back"),
      )).returning({ id: schema.analysisLabLegacyQuestionMigrationItems.id });
      if (receipt.length !== 1) throw new Error("이관 rollback receipt CAS가 실패했습니다.");
    }
    for (const grantId of uniqueGrantIds(plan)) {
      const grantItems = items.filter((item) => item.grantId === grantId);
      const beforeServingSha256 = grantItems[0]?.beforeServingSha256;
      if (!beforeServingSha256 || grantItems.some((item) =>
        item.beforeServingSha256 !== beforeServingSha256)) {
        throw new Error(`이관 rollback serving baseline이 불완전합니다: ${grantId}`);
      }
      const restored = await loadPromotionGrantSnapshot(tx, grantId);
      if (promotionGrantSnapshotStateSha256(restored) !== beforeServingSha256) {
        throw new Error(`serving_rollback_drift: ${grantId}`);
      }
    }
    await updateReleaseStatus(tx, release.id, "rolling_back", "rolled_back", input.executedBy);
    return { releaseId: input.releaseId, itemCount: items.length, replayed: false };
  });
}

function assertReleasePlan(plan: LegacyQuestionMigrationReleasePlan): LegacyQuestionMigrationReleasePlan {
  serializeLegacyQuestionMigrationReleasePlan(plan);
  if (
    plan.schema !== LEGACY_QUESTION_MIGRATION_RELEASE_PLAN_SCHEMA
    || plan.authority.status !== "offline_write_plan_only"
    || plan.authority.serviceDatabaseWritesMade !== 0
    || plan.authority.migrationAuthorized !== false
    || plan.authority.releaseAuthorized !== false
    || plan.authority.promotionAuthorized !== false
    || plan.authority.liveQuestionWriteAuthorized !== false
  ) throw new Error("이관 release plan의 offline authority 경계가 잘못됐습니다.");
  assertSha256(plan.contentSha256, "release plan content");
  if (plan.operations.length === 0) throw new Error("이관 release plan에 적용 operation이 없습니다.");
  const questionIds = new Set<string>();
  for (const operation of plan.operations) {
    if (questionIds.has(operation.legacyQuestion.id)) {
      throw new Error(`이관 release plan의 legacy 질문이 중복됩니다: ${operation.legacyQuestion.id}`);
    }
    questionIds.add(operation.legacyQuestion.id);
    if (
      operation.legacyQuestion.expectedAnswerCount !== 0
      || operation.retireLegacy.questionId !== operation.legacyQuestion.id
      || operation.question.supersedesQuestionId !== operation.legacyQuestion.id
      || operation.question.criterionStableKey !== operation.criterionStableKey
      || operation.question.minimumVersion <= operation.legacyQuestion.version
      || operation.question.answerType !== "single"
      || !["company_fact", "per_notice"].includes(operation.question.reusable)
      || operation.question.evaluationContractVersion !== "confirmation-evaluation-v2"
      || operation.question.promptVer !== LEGACY_QUESTION_MIGRATION_RELEASE_PROMPT_VERSION
      || operation.question.options.length !== 3
      || operation.question.options.some((option, index) => (
        option.value !== ["yes", "no", "unknown"][index]
        || option.evaluation !== ["satisfied", "unsatisfied", "unknown"][index]
      ))
      || (operation.question.reusable === "company_fact" && !operation.question.conditionKey)
      || (operation.question.reusable === "per_notice" && operation.question.conditionKey !== null)
    ) throw new Error(`이관 release operation 의미 계약이 잘못됐습니다: ${operation.legacyQuestion.id}`);
    assertSha256(operation.question.definitionSha256, "question definition");
    assertSha256(operation.question.sourceRevisionSha256, "source revision");
    assertSha256(operation.question.sourceRawSha256, "source raw");
    assertSha256(operation.question.criterionRef.sourceSpanHash, "criterion source span");
    if (operation.question.definitionSha256 !== questionDefinitionSha256({
      prompt: operation.question.prompt,
      options: [...operation.question.options],
      answerType: operation.question.answerType,
      reusable: operation.question.reusable,
      conditionKey: operation.question.conditionKey,
      evaluationContractVersion: operation.question.evaluationContractVersion,
      sourceRevisionSha256: operation.question.sourceRevisionSha256,
      sourceRawSha256: operation.question.sourceRawSha256,
    })) throw new Error(`이관 질문 definition 결속이 다릅니다: ${operation.legacyQuestion.id}`);
  }
  return plan;
}

function sortedOperations(plan: LegacyQuestionMigrationReleasePlan): LegacyQuestionMigrationReleaseOperation[] {
  return [...plan.operations].sort((left, right) =>
    `${left.grantId}:${left.legacyQuestion.id}`.localeCompare(`${right.grantId}:${right.legacyQuestion.id}`));
}

async function lockGrantIds(tx: CunoteDbSession, grantIds: readonly string[]): Promise<void> {
  for (const grantId of [...new Set(grantIds)].sort()) await acquireGrantPublicationLock(tx, grantId);
}

async function loadRelease(db: CunoteDbSession, releaseId: string) {
  const [release] = await db.select().from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId)).limit(1);
  return release ?? null;
}

async function requireBoundRelease(
  db: CunoteDbSession,
  releaseId: string,
  plan: LegacyQuestionMigrationReleasePlan,
) {
  const release = await loadRelease(db, releaseId);
  if (!release) throw new Error("이관 release 원장이 없습니다.");
  if (
    release.manifestSha256 !== plan.contentSha256
    || release.releasePlanSha256 !== plan.contentSha256
    || snapshotSha256(release.manifest) !== snapshotSha256(plan)
  ) throw new Error("이관 release DB plan 결속이 다릅니다.");
  return release;
}

async function assertPreparedReplay(
  db: CunoteDbSession,
  release: NonNullable<Awaited<ReturnType<typeof loadRelease>>>,
  releaseId: string,
  plan: LegacyQuestionMigrationReleasePlan,
) {
  await requireBoundRelease(db, releaseId, plan);
  const items = await loadBoundItems(db, release.id, plan);
  return { releaseDbId: release.id, releaseId, itemIds: items.map((item) => item.id), replayed: true };
}

async function loadBoundItems(
  db: CunoteDbSession,
  releaseDbId: string,
  plan: LegacyQuestionMigrationReleasePlan,
) {
  const items = await db.select().from(schema.analysisLabLegacyQuestionMigrationItems)
    .where(eq(schema.analysisLabLegacyQuestionMigrationItems.releaseDbId, releaseDbId));
  if (items.length !== plan.operations.length) throw new Error("이관 release item 수가 plan과 다릅니다.");
  for (const operation of plan.operations) {
    const item = items.find((candidate) => candidate.legacyQuestionId === operation.legacyQuestion.id);
    if (
      !item
      || item.grantId !== operation.grantId
      || item.criterionId !== operation.criterionId
      || item.planSha256 !== plan.contentSha256
      || item.operationSha256 !== operationSha256(operation)
    ) throw new Error(`이관 release item 결속이 다릅니다: ${operation.legacyQuestion.id}`);
  }
  return items;
}

async function loadBeforeSnapshot(
  db: CunoteDbSession,
  operation: LegacyQuestionMigrationReleaseOperation,
  lockSource: boolean,
): Promise<LegacyQuestionMigrationBeforeSnapshot> {
  const source = await loadDeepAnalysisSourceBinding({
    db,
    grantId: operation.grantId,
    lockRaw: lockSource,
  });
  const [criterion] = await db.select({
    id: schema.grantCriteria.id,
    grantId: schema.grantCriteria.grantId,
    stableKey: schema.grantCriteria.stableKey,
    dimension: schema.grantCriteria.dimension,
    kind: schema.grantCriteria.kind,
    sourceSpan: schema.grantCriteria.sourceSpan,
  }).from(schema.grantCriteria).where(eq(schema.grantCriteria.id, operation.criterionId)).limit(1);
  const [legacy] = await db.select().from(schema.grantConfirmationQuestions)
    .where(eq(schema.grantConfirmationQuestions.id, operation.legacyQuestion.id)).limit(1);
  if (!source || !criterion || !legacy) {
    throw new Error(`이관 baseline 행이 없습니다: ${operation.legacyQuestion.id}`);
  }
  return {
    schema: BEFORE_SCHEMA,
    grantId: operation.grantId,
    criterion,
    source: {
      sourceRevisionSha256: source.sourceRevisionSha256,
      sourceRawSha256: source.sourceRawSha256,
    },
    legacyQuestion: questionSnapshot(legacy),
    legacyAnswerCount: await answerCount(db, legacy.id),
  };
}

function assertOperationBaseline(
  operation: LegacyQuestionMigrationReleaseOperation,
  before: LegacyQuestionMigrationBeforeSnapshot,
): void {
  const question = before.legacyQuestion;
  if (
    before.grantId !== operation.grantId
    || before.criterion.id !== operation.criterionId
    || before.criterion.grantId !== operation.grantId
    || before.criterion.stableKey !== operation.criterionStableKey
    || before.criterion.dimension !== operation.question.criterionRef.dimension
    || before.criterion.kind !== operation.question.criterionRef.kind
    || sourceSpanHash(before.criterion.sourceSpan) !== operation.question.criterionRef.sourceSpanHash
    || before.source.sourceRevisionSha256 !== operation.question.sourceRevisionSha256
    || before.source.sourceRawSha256 !== operation.question.sourceRawSha256
    || question.grantId !== operation.grantId
    || question.grantCriteriaId !== operation.criterionId
    || question.evaluationCriterionId !== null
    || question.evaluationContractVersion !== null
    || question.invalidatedAt !== null
    || question.version !== operation.legacyQuestion.version
    || question.definitionSha256 !== operation.legacyQuestion.definitionSha256
    || before.legacyAnswerCount !== operation.legacyQuestion.expectedAnswerCount
  ) throw new Error(`baseline_drift: ${operation.legacyQuestion.id}`);
}

async function assertNoExistingSuccessor(
  db: CunoteDbSession,
  operation: LegacyQuestionMigrationReleaseOperation,
): Promise<void> {
  const rows = await db.select({ id: schema.grantConfirmationQuestions.id })
    .from(schema.grantConfirmationQuestions)
    .where(and(
      eq(schema.grantConfirmationQuestions.grantId, operation.grantId),
      eq(schema.grantConfirmationQuestions.criterionStableKey, operation.criterionStableKey),
      eq(schema.grantConfirmationQuestions.definitionSha256, operation.question.definitionSha256),
    ));
  if (rows.some((row) => row.id !== operation.legacyQuestion.id)) {
    throw new Error(`migration_successor_already_exists: ${operation.legacyQuestion.id}`);
  }
}

async function loadAfterSnapshot(
  db: CunoteDbSession,
  grantId: string,
  legacyQuestionId: string,
  migratedQuestionId: string,
): Promise<LegacyQuestionMigrationAfterSnapshot> {
  const rows = await db.select().from(schema.grantConfirmationQuestions)
    .where(inArray(schema.grantConfirmationQuestions.id, [legacyQuestionId, migratedQuestionId]));
  const legacy = rows.find((row) => row.id === legacyQuestionId);
  const migrated = rows.find((row) => row.id === migratedQuestionId);
  if (!legacy || !migrated) throw new Error(`이관 after 질문 행이 없습니다: ${legacyQuestionId}`);
  return {
    schema: AFTER_SCHEMA,
    grantId,
    legacyQuestion: questionSnapshot(legacy),
    migratedQuestion: questionSnapshot(migrated),
  };
}

function assertAppliedSnapshot(
  operation: LegacyQuestionMigrationReleaseOperation,
  after: LegacyQuestionMigrationAfterSnapshot,
): void {
  if (
    after.grantId !== operation.grantId
    || after.legacyQuestion.invalidationReason !== operation.retireLegacy.invalidationReason
    || after.legacyQuestion.invalidatedAt === null
    || after.legacyQuestion.grantCriteriaId !== null
    || after.migratedQuestion.evaluationCriterionId !== operation.criterionId
    || after.migratedQuestion.evaluationContractVersion !== operation.question.evaluationContractVersion
    || after.migratedQuestion.definitionSha256 !== operation.question.definitionSha256
    || after.migratedQuestion.supersedesQuestionId !== operation.legacyQuestion.id
    || after.migratedQuestion.invalidatedAt !== null
  ) throw new Error(`이관 after snapshot이 plan과 다릅니다: ${operation.legacyQuestion.id}`);
}

async function assertAppliedItemsCurrent(
  db: CunoteDbSession,
  plan: LegacyQuestionMigrationReleasePlan,
  items: Awaited<ReturnType<typeof loadBoundItems>>,
): Promise<void> {
  for (const operation of plan.operations) {
    const item = items.find((candidate) => candidate.legacyQuestionId === operation.legacyQuestion.id)!;
    if (item.status !== "applied" || !item.migratedQuestionId || !item.afterSha256) {
      throw new Error(`이관 applied receipt가 불완전합니다: ${item.legacyQuestionId}`);
    }
    const current = await loadAfterSnapshot(
      db,
      item.grantId,
      item.legacyQuestionId,
      item.migratedQuestionId,
    );
    if (snapshotSha256(current) !== item.afterSha256) {
      throw new Error(`after_drift: ${item.legacyQuestionId}`);
    }
  }
  for (const grantId of uniqueGrantIds(plan)) {
    const grantItems = items.filter((item) => item.grantId === grantId);
    const servingStateSha256 = grantItems[0]?.servingStateSha256;
    if (!servingStateSha256 || grantItems.some((item) =>
      item.servingStateSha256 !== servingStateSha256)) {
      throw new Error(`이관 serving receipt가 불완전합니다: ${grantId}`);
    }
    const current = await loadPromotionGrantSnapshot(db, grantId);
    if (promotionGrantSnapshotStateSha256(current) !== servingStateSha256) {
      throw new Error(`serving_after_drift: ${grantId}`);
    }
  }
}

/** 제한 이관이 참조할 현재 promotion parent와 직전 successor frontier를 유일하게 확정한다. */
export async function loadCurrentLegacyQuestionMigrationParent(
  db: CunoteDbSession,
  grantId: string,
): Promise<{
  promotionItemId: string;
  parentAfterSha256: string;
  currentServingStateSha256: string;
}> {
  const rows = await db.select({
    promotionItemId: schema.analysisLabPromotionItems.id,
    releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
    releaseManifest: schema.analysisLabPromotionReleases.manifest,
    afterSha256: schema.analysisLabPromotionItems.afterSha256,
    appliedAt: schema.analysisLabPromotionItems.appliedAt,
  }).from(schema.analysisLabPromotionItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionReleases.id, schema.analysisLabPromotionItems.releaseDbId),
    )
    .where(and(
      eq(schema.analysisLabPromotionItems.grantId, grantId),
      eq(schema.analysisLabPromotionItems.status, "applied"),
      inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
    ));
  if (rows.length !== 1) {
    throw new Error(`legacy question migration parent가 유일하지 않습니다: ${grantId} (${rows.length})`);
  }
  const row = rows[0]!;
  if (!row.afterSha256 || !row.appliedAt) {
    throw new Error(`legacy question migration parent receipt가 불완전합니다: ${grantId}`);
  }
  const manifest = validatePromotionReleaseManifest(row.releaseManifest);
  if (manifest.manifestSha256 !== row.releaseManifestSha256) {
    throw new Error(`legacy question migration parent manifest가 불일치합니다: ${grantId}`);
  }
  const current = await loadPromotionGrantSnapshot(db, grantId);
  const currentServingStateSha256 = promotionGrantSnapshotStateSha256(current);
  const successors = await loadLegacyQuestionMigrationServingStates(db, [row.promotionItemId]);
  if (!promotionStateMatchesParentOrMigration({
    currentStateSha256: currentServingStateSha256,
    parentAfterSha256: row.afterSha256,
    successor: successors.get(row.promotionItemId),
    grantId,
  })) {
    throw new Error(`legacy question migration parent matching state가 변경됐습니다: ${grantId}`);
  }
  return {
    promotionItemId: row.promotionItemId,
    parentAfterSha256: row.afterSha256,
    currentServingStateSha256,
  };
}

/** 원래 promotion rollback이 적용된 질문 successor를 고아로 만들지 않게 한다. */
export async function assertNoAppliedLegacyQuestionMigrationForParent(
  db: CunoteDbSession,
  parentPromotionItemId: string,
): Promise<void> {
  const rows = await db.select({ id: schema.analysisLabLegacyQuestionMigrationItems.id })
    .from(schema.analysisLabLegacyQuestionMigrationItems)
    .where(and(
      eq(schema.analysisLabLegacyQuestionMigrationItems.parentPromotionItemId, parentPromotionItemId),
      eq(schema.analysisLabLegacyQuestionMigrationItems.status, "applied"),
    ));
  if (rows.length > 0) throw new Error("legacy_question_migration_applied");
}

function uniqueGrantIds(plan: LegacyQuestionMigrationReleasePlan): string[] {
  return [...new Set(plan.operations.map((operation) => operation.grantId))].sort();
}

async function answerCount(db: CunoteDbSession, questionId: string): Promise<number> {
  const [row] = await db.select({ value: count() }).from(schema.companyGrantConfirmations)
    .where(eq(schema.companyGrantConfirmations.questionId, questionId));
  return Number(row?.value ?? 0);
}

async function loadConfirmedLinks(db: CunoteDbSession) {
  return db.select({
    canonicalGrantId: schema.dedupLinks.canonicalGrantId,
    memberGrantId: schema.dedupLinks.memberGrantId,
  }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true));
}

async function invalidateMatchStates(
  db: CunoteDbSession,
  grantId: string,
  links: Awaited<ReturnType<typeof loadConfirmedLinks>>,
): Promise<void> {
  const affected = expandConfirmedGrantComponentIds([grantId], links);
  await db.delete(schema.matchState).where(inArray(schema.matchState.grantId, affected));
}

async function updateReleaseStatus(
  db: CunoteDbSession,
  releaseDbId: string,
  expected: string,
  status: "applying" | "active" | "rolling_back" | "rolled_back",
  executedBy: string,
): Promise<void> {
  const updated = await db.update(schema.analysisLabPromotionReleases).set({
    status,
    executedBy,
    ...(status === "applying" ? { startedAt: new Date() } : {}),
    ...(status === "active" ? { completedAt: new Date() } : {}),
    ...(status === "rolled_back" ? { rolledBackAt: new Date() } : {}),
  }).where(and(
    eq(schema.analysisLabPromotionReleases.id, releaseDbId),
    eq(schema.analysisLabPromotionReleases.status, expected),
  )).returning({ id: schema.analysisLabPromotionReleases.id });
  if (updated.length !== 1) throw new Error(`이관 release 상태 CAS가 실패했습니다: ${expected} -> ${status}`);
}

function questionSnapshot(row: ConfirmationQuestionRow): QuestionSnapshot {
  return {
    id: row.id,
    grantId: row.grantId,
    grantCriteriaId: row.grantCriteriaId,
    evaluationCriterionId: row.evaluationCriterionId,
    evaluationContractVersion: row.evaluationContractVersion,
    sourceRevisionSha256: row.sourceRevisionSha256,
    sourceRawSha256: row.sourceRawSha256,
    criterionStableKey: row.criterionStableKey,
    definitionSha256: row.definitionSha256,
    version: row.version,
    supersedesQuestionId: row.supersedesQuestionId,
    criterionRef: row.criterionRef,
    prompt: row.prompt,
    options: row.options,
    answerType: row.answerType,
    reusable: row.reusable,
    conditionKey: row.conditionKey,
    promptVer: row.promptVer,
    provenance: row.provenance,
    invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
    invalidationReason: row.invalidationReason,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseBeforeSnapshot(value: unknown): LegacyQuestionMigrationBeforeSnapshot {
  const snapshot = value as LegacyQuestionMigrationBeforeSnapshot;
  if (!snapshot || snapshot.schema !== BEFORE_SCHEMA || !snapshot.legacyQuestion?.id) {
    throw new Error("이관 before snapshot 형식이 잘못됐습니다.");
  }
  return snapshot;
}

function operationSha256(operation: LegacyQuestionMigrationReleaseOperation): string {
  return snapshotSha256(operation);
}

function snapshotSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalLegacyQuestionMigrationReviewJson(value))
    .digest("hex");
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} SHA-256 형식이 잘못됐습니다.`);
}
