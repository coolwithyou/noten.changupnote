import { and, eq, inArray, isNull } from "drizzle-orm";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { questionDefinitionSha256 } from "../analysis-lab/promote";
import { acquireGrantPublicationLock } from "../ingestion/grantPublicationLock";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import {
  parseGrantSourceChangeImpact,
  type GrantSourceChangeImpact,
} from "../ingestion/grantSourceChangeImpact";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
} from "../analysis-serving/promotionSnapshot";
import {
  sha256Canonical,
  validatePromotionReleaseManifest,
} from "../analysis-serving/promotionReleaseContract";
import { resolvePromotionServingEvidence } from "../analysis-serving/promotionServing";
import {
  loadLegacyQuestionMigrationServingStates,
  promotionStateMatchesParentOrMigration,
} from "./legacyQuestionMigrationServing";
import {
  loadSourceRebindServingStates,
  sourceRebindFrontierMatchesServingState,
} from "./sourceRebindServing";

export const SOURCE_REBIND_RELEASE_SCHEMA = "source-rebind-release-v1" as const;

export interface SourceRebindQuestionPlan {
  readonly questionId: string;
  readonly criterionId: string;
  readonly questionVersion: number;
  readonly beforeDefinitionSha256: string;
  readonly afterDefinitionSha256: string;
  readonly answerCount: number;
}

export interface SourceRebindReleaseManifest {
  readonly schema: typeof SOURCE_REBIND_RELEASE_SCHEMA;
  readonly releaseId: string;
  readonly revision: 1;
  readonly gitCommit: string;
  readonly buildDigest: string;
  readonly grantId: string;
  readonly parent: {
    readonly promotionItemId: string;
    readonly runId: string;
    readonly afterSha256: string;
    readonly currentServingStateSha256: string;
    readonly rootSourceRevisionSha256: string;
    readonly sourceRevisionSha256: string;
  };
  readonly source: {
    readonly previousRawSha256: string;
    readonly currentRawSha256: string;
    readonly currentRevisionSha256: string;
    readonly currentMaterialRevisionSha256: string;
  };
  readonly sourceChangeImpact: GrantSourceChangeImpact;
  readonly sourceChangeImpactSha256: string;
  readonly questions: readonly SourceRebindQuestionPlan[];
  readonly releasePlanSha256: string;
  readonly manifestSha256: string;
}

export interface SourceRebindAdmissionMaterial {
  readonly grantId: string;
  readonly parent: SourceRebindReleaseManifest["parent"];
  readonly source: SourceRebindReleaseManifest["source"];
  readonly sourceChangeImpact: GrantSourceChangeImpact;
  readonly questions: readonly SourceRebindQuestionPlan[];
}

export interface AppliedSourceRebindResult {
  readonly servingStateSha256: string;
  readonly reboundQuestionCount: number;
  readonly reboundAnswerCount: number;
  readonly replayed: boolean;
}

/** 현재 DB의 exact promotion/source/question frontier에서 승인 가능한 manifest를 만든다. */
export async function buildCurrentSourceRebindReleaseManifest(input: {
  readonly db: CunoteDbSession;
  readonly grantId: string;
  readonly releaseId: string;
  readonly gitCommit: string;
  readonly buildDigest: string;
}): Promise<SourceRebindReleaseManifest> {
  const material = await loadSourceRebindAdmissionMaterial(input.db, input.grantId, false);
  return createSourceRebindReleaseManifest({
    releaseId: input.releaseId,
    gitCommit: input.gitCommit,
    buildDigest: input.buildDigest,
    material,
  });
}

export function createSourceRebindReleaseManifest(input: {
  readonly releaseId: string;
  readonly gitCommit: string;
  readonly buildDigest: string;
  readonly material: SourceRebindAdmissionMaterial;
}): SourceRebindReleaseManifest {
  const releaseId = nonEmpty(input.releaseId, "release_id");
  const gitCommit = nonEmpty(input.gitCommit, "git_commit");
  const buildDigest = nonEmpty(input.buildDigest, "build_digest");
  assertAdmissionMaterial(input.material);
  const questions = [...input.material.questions].sort((left, right) =>
    left.questionId.localeCompare(right.questionId));
  const sourceChangeImpactSha256 = sha256Canonical(input.material.sourceChangeImpact);
  const plan = {
    grantId: input.material.grantId,
    parent: input.material.parent,
    source: input.material.source,
    sourceChangeImpact: input.material.sourceChangeImpact,
    sourceChangeImpactSha256,
    questions,
  };
  const releasePlanSha256 = sha256Canonical({
    schema: "source-rebind-release-plan-v1",
    ...plan,
  });
  const body = {
    schema: SOURCE_REBIND_RELEASE_SCHEMA,
    releaseId,
    revision: 1 as const,
    gitCommit,
    buildDigest,
    ...plan,
    releasePlanSha256,
  };
  return Object.freeze({
    ...body,
    questions: Object.freeze(questions),
    manifestSha256: sha256Canonical(body),
  });
}

export function validateSourceRebindReleaseManifest(value: unknown): SourceRebindReleaseManifest {
  if (!isRecord(value) || value.schema !== SOURCE_REBIND_RELEASE_SCHEMA) {
    throw new Error("source_rebind_manifest_schema_invalid");
  }
  const manifest = value as unknown as SourceRebindReleaseManifest;
  if (
    manifest.revision !== 1
    || !Array.isArray(manifest.questions)
    || manifest.manifestSha256 !== sha256Canonical(withoutManifestSha(manifest))
  ) throw new Error("source_rebind_manifest_hash_invalid");
  const rebuilt = createSourceRebindReleaseManifest({
    releaseId: manifest.releaseId,
    gitCommit: manifest.gitCommit,
    buildDigest: manifest.buildDigest,
    material: {
      grantId: manifest.grantId,
      parent: manifest.parent,
      source: manifest.source,
      sourceChangeImpact: manifest.sourceChangeImpact,
      questions: manifest.questions,
    },
  });
  if (
    rebuilt.releasePlanSha256 !== manifest.releasePlanSha256
    || rebuilt.sourceChangeImpactSha256 !== manifest.sourceChangeImpactSha256
    || rebuilt.manifestSha256 !== manifest.manifestSha256
  ) throw new Error("source_rebind_manifest_binding_invalid");
  return manifest;
}

/** 승인 전 원장은 현재 exact frontier가 manifest와 같을 때만 준비한다. */
export async function prepareSourceRebindReleaseLedger(input: {
  readonly db: CunoteDb;
  readonly manifest: SourceRebindReleaseManifest;
  readonly createdBy: string;
}): Promise<{ releaseDbId: string; itemId: string; replayed: boolean }> {
  const manifest = validateSourceRebindReleaseManifest(input.manifest);
  const createdBy = nonEmpty(input.createdBy, "created_by");
  return input.db.transaction(async (tx) => {
    await acquireGrantPublicationLock(tx, manifest.grantId);
    const existing = await loadReleaseAndItem(tx, manifest, false);
    if (existing) {
      if (existing.release.status === "active" && existing.item.status === "applied") {
        await assertAppliedSourceRebindCurrent(tx, manifest, existing.item.servingStateSha256);
      } else {
        await assertCurrentAdmissionMatches(tx, manifest, true);
      }
      return { releaseDbId: existing.release.id, itemId: existing.item.id, replayed: true };
    }
    await assertCurrentAdmissionMatches(tx, manifest, true);
    const [release] = await tx.insert(schema.analysisLabPromotionReleases).values({
      releaseId: manifest.releaseId,
      revision: manifest.revision,
      manifestSha256: manifest.manifestSha256,
      releasePlanSha256: manifest.releasePlanSha256,
      manifest: manifest as unknown as Record<string, unknown>,
      gitCommit: manifest.gitCommit,
      buildDigest: manifest.buildDigest,
      status: "prepared",
      createdBy,
    }).returning({ id: schema.analysisLabPromotionReleases.id });
    if (!release) throw new Error("source_rebind_release_insert_failed");
    const beforeSnapshot = beforeReceiptSnapshot(manifest);
    const [item] = await tx.insert(schema.analysisLabSourceRebindItems).values({
      releaseDbId: release.id,
      grantId: manifest.grantId,
      parentPromotionItemId: manifest.parent.promotionItemId,
      impactSha256: manifest.sourceChangeImpactSha256,
      previousSourceRevisionSha256: manifest.parent.sourceRevisionSha256,
      previousSourceRawSha256: manifest.source.previousRawSha256,
      currentSourceRevisionSha256: manifest.source.currentRevisionSha256,
      currentSourceRawSha256: manifest.source.currentRawSha256,
      currentMaterialSourceRevisionSha256: manifest.source.currentMaterialRevisionSha256,
      beforeSnapshot,
      beforeSha256: sha256Canonical(beforeSnapshot),
      beforeServingSha256: manifest.parent.currentServingStateSha256,
      status: "prepared",
    }).returning({ id: schema.analysisLabSourceRebindItems.id });
    if (!item) throw new Error("source_rebind_item_insert_failed");
    return { releaseDbId: release.id, itemId: item.id, replayed: false };
  });
}

export async function approveSourceRebindRelease(input: {
  readonly db: CunoteDb;
  readonly manifest: SourceRebindReleaseManifest;
  readonly approvedBy: string;
  readonly approvalArtifactSha256: string;
}): Promise<void> {
  const manifest = validateSourceRebindReleaseManifest(input.manifest);
  const approvedBy = nonEmpty(input.approvedBy, "approved_by");
  exactSha(input.approvalArtifactSha256, "approval_artifact");
  await input.db.transaction(async (tx) => {
    const bound = await loadReleaseAndItem(tx, manifest, true);
    if (!bound) throw new Error("source_rebind_release_missing");
    if (bound.release.status === "approved") {
      if (
        bound.release.approvedBy !== approvedBy
        || bound.release.approvalArtifactSha256 !== input.approvalArtifactSha256
      ) throw new Error("source_rebind_approval_binding_mismatch");
      return;
    }
    if (bound.release.status !== "prepared") throw new Error("source_rebind_release_not_prepared");
    if (bound.release.createdBy === approvedBy) throw new Error("source_rebind_actor_separation_required");
    const rows = await tx.update(schema.analysisLabPromotionReleases).set({
      status: "approved",
      approvedBy,
      approvedAt: new Date(),
      approvalArtifactSha256: input.approvalArtifactSha256,
    }).where(and(
      eq(schema.analysisLabPromotionReleases.id, bound.release.id),
      eq(schema.analysisLabPromotionReleases.status, "prepared"),
    )).returning({ id: schema.analysisLabPromotionReleases.id });
    if (rows.length !== 1) throw new Error("source_rebind_approval_cas_failed");
  });
}

/** 질문과 기존 답변의 source binding을 보존적 successor receipt와 한 transaction에서 전진시킨다. */
export async function applySourceRebindRelease(input: {
  readonly db: CunoteDb;
  readonly manifest: SourceRebindReleaseManifest;
  readonly executedBy: string;
}): Promise<AppliedSourceRebindResult> {
  const manifest = validateSourceRebindReleaseManifest(input.manifest);
  const executedBy = nonEmpty(input.executedBy, "executed_by");
  return input.db.transaction(async (tx) => {
    await acquireGrantPublicationLock(tx, manifest.grantId);
    const bound = await loadReleaseAndItem(tx, manifest, true);
    if (!bound) throw new Error("source_rebind_release_missing");
    if (bound.release.approvedBy === executedBy) throw new Error("source_rebind_actor_separation_required");
    if (bound.release.status === "active" && bound.item.status === "applied") {
      await assertAppliedSourceRebindCurrent(tx, manifest, bound.item.servingStateSha256);
      return {
        servingStateSha256: bound.item.servingStateSha256!,
        reboundQuestionCount: bound.item.reboundQuestionCount ?? 0,
        reboundAnswerCount: bound.item.reboundAnswerCount ?? 0,
        replayed: true,
      };
    }
    if (bound.release.status !== "approved" || bound.item.status !== "prepared") {
      throw new Error(`source_rebind_release_not_applicable:${bound.release.status}/${bound.item.status}`);
    }
    await assertCurrentAdmissionMatches(tx, manifest, true);
    await updateReleaseStatus(tx, bound.release.id, "approved", "applying", executedBy);
    const applying = await tx.update(schema.analysisLabSourceRebindItems).set({
      status: "applying",
      error: null,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.analysisLabSourceRebindItems.id, bound.item.id),
      eq(schema.analysisLabSourceRebindItems.status, "prepared"),
    )).returning({ id: schema.analysisLabSourceRebindItems.id });
    if (applying.length !== 1) throw new Error("source_rebind_item_cas_failed");

    let reboundQuestionCount = 0;
    let reboundAnswerCount = 0;
    for (const question of manifest.questions) {
      const questionRows = await tx.update(schema.grantConfirmationQuestions).set({
        sourceRevisionSha256: manifest.source.currentRevisionSha256,
        sourceRawSha256: manifest.source.currentRawSha256,
        definitionSha256: question.afterDefinitionSha256,
      }).where(and(
        eq(schema.grantConfirmationQuestions.id, question.questionId),
        eq(schema.grantConfirmationQuestions.grantId, manifest.grantId),
        eq(schema.grantConfirmationQuestions.evaluationCriterionId, question.criterionId),
        eq(schema.grantConfirmationQuestions.evaluationContractVersion, "confirmation-evaluation-v2"),
        eq(schema.grantConfirmationQuestions.sourceRevisionSha256, manifest.parent.sourceRevisionSha256),
        eq(schema.grantConfirmationQuestions.sourceRawSha256, manifest.source.previousRawSha256),
        eq(schema.grantConfirmationQuestions.definitionSha256, question.beforeDefinitionSha256),
        eq(schema.grantConfirmationQuestions.version, question.questionVersion),
        isNull(schema.grantConfirmationQuestions.invalidatedAt),
      )).returning({ id: schema.grantConfirmationQuestions.id });
      if (questionRows.length !== 1) throw new Error(`source_rebind_question_cas_failed:${question.questionId}`);
      reboundQuestionCount += 1;
      const answerRows = await tx.update(schema.companyGrantConfirmations).set({
        sourceRevisionSha256: manifest.source.currentRevisionSha256,
        sourceRawSha256: manifest.source.currentRawSha256,
        questionDefinitionSha256: question.afterDefinitionSha256,
      }).where(and(
        eq(schema.companyGrantConfirmations.questionId, question.questionId),
        eq(schema.companyGrantConfirmations.grantId, manifest.grantId),
        eq(schema.companyGrantConfirmations.evaluationCriterionId, question.criterionId),
        eq(schema.companyGrantConfirmations.sourceRevisionSha256, manifest.parent.sourceRevisionSha256),
        eq(schema.companyGrantConfirmations.sourceRawSha256, manifest.source.previousRawSha256),
        eq(schema.companyGrantConfirmations.questionDefinitionSha256, question.beforeDefinitionSha256),
        eq(schema.companyGrantConfirmations.questionVersion, question.questionVersion),
      )).returning({ questionId: schema.companyGrantConfirmations.questionId });
      if (answerRows.length !== question.answerCount) {
        throw new Error(`source_rebind_answer_cas_failed:${question.questionId}`);
      }
      reboundAnswerCount += answerRows.length;
    }
    await invalidateMatchStates(tx, manifest.grantId);
    const current = await loadPromotionGrantSnapshot(tx, manifest.grantId);
    const servingStateSha256 = promotionGrantSnapshotStateSha256(current);
    const afterSnapshot = {
      schema: "source-rebind-after-v1",
      grantId: manifest.grantId,
      currentSourceRevisionSha256: manifest.source.currentRevisionSha256,
      currentSourceRawSha256: manifest.source.currentRawSha256,
      currentMaterialSourceRevisionSha256: manifest.source.currentMaterialRevisionSha256,
      servingStateSha256,
      reboundQuestionCount,
      reboundAnswerCount,
    };
    const itemRows = await tx.update(schema.analysisLabSourceRebindItems).set({
      afterSnapshot,
      afterSha256: sha256Canonical(afterSnapshot),
      servingStateSha256,
      reboundQuestionCount,
      reboundAnswerCount,
      status: "applied",
      error: null,
      appliedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.analysisLabSourceRebindItems.id, bound.item.id),
      eq(schema.analysisLabSourceRebindItems.status, "applying"),
    )).returning({ id: schema.analysisLabSourceRebindItems.id });
    if (itemRows.length !== 1) throw new Error("source_rebind_receipt_cas_failed");
    await updateReleaseStatus(tx, bound.release.id, "applying", "active", executedBy);
    return { servingStateSha256, reboundQuestionCount, reboundAnswerCount, replayed: false };
  });
}

export async function loadApprovedSourceRebindRelease(input: {
  readonly db: CunoteDbSession;
  readonly releaseId: string;
  readonly expectedManifestSha256: string;
  readonly grantId: string;
}): Promise<{
  readonly status: string;
  readonly manifest: SourceRebindReleaseManifest;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly approvalArtifactSha256: string | null;
}> {
  const [release] = await input.db.select().from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, input.releaseId)).limit(1);
  if (!release) throw new Error("source_rebind_release_missing");
  const manifest = validateSourceRebindReleaseManifest(release.manifest);
  if (
    release.manifestSha256 !== input.expectedManifestSha256
    || manifest.manifestSha256 !== input.expectedManifestSha256
    || manifest.grantId !== input.grantId
    || release.releasePlanSha256 !== manifest.releasePlanSha256
  ) throw new Error("source_rebind_release_ledger_mismatch");
  return {
    status: release.status,
    manifest,
    approvedBy: release.approvedBy,
    approvedAt: release.approvedAt,
    approvalArtifactSha256: release.approvalArtifactSha256,
  };
}

/** 원 promotion rollback이 적용된 source successor를 고아로 만들지 않게 한다. */
export async function assertNoAppliedSourceRebindForParent(
  db: CunoteDbSession,
  parentPromotionItemId: string,
): Promise<void> {
  const rows = await db.select({ id: schema.analysisLabSourceRebindItems.id })
    .from(schema.analysisLabSourceRebindItems)
    .where(and(
      eq(schema.analysisLabSourceRebindItems.parentPromotionItemId, parentPromotionItemId),
      eq(schema.analysisLabSourceRebindItems.status, "applied"),
    ));
  if (rows.length > 0) throw new Error("source_rebind_applied");
}

async function loadSourceRebindAdmissionMaterial(
  db: CunoteDbSession,
  grantId: string,
  lockRows: boolean,
): Promise<SourceRebindAdmissionMaterial> {
  const source = await loadDeepAnalysisSourceBinding({ db, grantId, lockRaw: lockRows });
  if (!source) throw new Error("source_rebind_current_source_missing");
  const [grant] = await db.select({
    id: schema.grants.id,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
  }).from(schema.grants).where(eq(schema.grants.id, grantId)).limit(1);
  if (!grant) throw new Error("source_rebind_grant_missing");
  const [event] = await db.select({
    changeImpact: schema.grantCollectionEvents.changeImpact,
  }).from(schema.grantCollectionEvents).where(and(
    eq(schema.grantCollectionEvents.source, grant.source),
    eq(schema.grantCollectionEvents.sourceId, grant.sourceId),
    eq(schema.grantCollectionEvents.rawHash, source.sourceRawSha256),
  )).limit(1);
  const sourceChangeImpact = parseGrantSourceChangeImpact(event?.changeImpact);
  if (!sourceChangeImpact) throw new Error("source_rebind_impact_missing");

  const parent = await loadSourceRebindParent(db, grantId);
  const questionQuery = db.select({
    id: schema.grantConfirmationQuestions.id,
    evaluationCriterionId: schema.grantConfirmationQuestions.evaluationCriterionId,
    evaluationContractVersion: schema.grantConfirmationQuestions.evaluationContractVersion,
    sourceRevisionSha256: schema.grantConfirmationQuestions.sourceRevisionSha256,
    sourceRawSha256: schema.grantConfirmationQuestions.sourceRawSha256,
    definitionSha256: schema.grantConfirmationQuestions.definitionSha256,
    version: schema.grantConfirmationQuestions.version,
    prompt: schema.grantConfirmationQuestions.prompt,
    options: schema.grantConfirmationQuestions.options,
    answerType: schema.grantConfirmationQuestions.answerType,
    reusable: schema.grantConfirmationQuestions.reusable,
    conditionKey: schema.grantConfirmationQuestions.conditionKey,
  }).from(schema.grantConfirmationQuestions).where(and(
    eq(schema.grantConfirmationQuestions.grantId, grantId),
    eq(schema.grantConfirmationQuestions.evaluationContractVersion, "confirmation-evaluation-v2"),
    isNull(schema.grantConfirmationQuestions.invalidatedAt),
  ));
  const questionRows = lockRows ? await questionQuery.for("update") : await questionQuery;
  const questions: SourceRebindQuestionPlan[] = [];
  for (const row of questionRows) {
    if (
      !row.evaluationCriterionId
      || row.sourceRevisionSha256 !== parent.sourceRevisionSha256
      || row.sourceRawSha256 !== sourceChangeImpact.previousRawSha256
      || row.answerType !== "single"
      || (row.reusable !== "per_notice" && row.reusable !== "company_fact")
      || !Array.isArray(row.options)
    ) throw new Error(`source_rebind_question_baseline_invalid:${row.id}`);
    const answerQuery = db.select({
      evaluationCriterionId: schema.companyGrantConfirmations.evaluationCriterionId,
      sourceRevisionSha256: schema.companyGrantConfirmations.sourceRevisionSha256,
      sourceRawSha256: schema.companyGrantConfirmations.sourceRawSha256,
      questionDefinitionSha256: schema.companyGrantConfirmations.questionDefinitionSha256,
      questionVersion: schema.companyGrantConfirmations.questionVersion,
    }).from(schema.companyGrantConfirmations).where(eq(
      schema.companyGrantConfirmations.questionId,
      row.id,
    ));
    const answerRows = lockRows ? await answerQuery.for("update") : await answerQuery;
    if (answerRows.some((answer) =>
      answer.evaluationCriterionId !== row.evaluationCriterionId
      || answer.sourceRevisionSha256 !== parent.sourceRevisionSha256
      || answer.sourceRawSha256 !== sourceChangeImpact.previousRawSha256
      || answer.questionDefinitionSha256 !== row.definitionSha256
      || answer.questionVersion !== row.version)) {
      throw new Error(`source_rebind_answer_baseline_invalid:${row.id}`);
    }
    questions.push({
      questionId: row.id,
      criterionId: row.evaluationCriterionId,
      questionVersion: row.version,
      beforeDefinitionSha256: row.definitionSha256,
      afterDefinitionSha256: questionDefinitionSha256({
        prompt: row.prompt,
        options: row.options as never,
        answerType: "single",
        reusable: row.reusable,
        conditionKey: row.conditionKey,
        evaluationContractVersion: "confirmation-evaluation-v2",
        sourceRevisionSha256: source.sourceRevisionSha256,
        sourceRawSha256: source.sourceRawSha256,
      }),
      answerCount: answerRows.length,
    });
  }
  return {
    grantId,
    parent,
    source: {
      previousRawSha256: sourceChangeImpact.previousRawSha256!,
      currentRawSha256: source.sourceRawSha256,
      currentRevisionSha256: source.sourceRevisionSha256,
      currentMaterialRevisionSha256: source.materialSourceRevisionSha256,
    },
    sourceChangeImpact,
    questions,
  };
}

async function loadSourceRebindParent(
  db: CunoteDbSession,
  grantId: string,
): Promise<SourceRebindReleaseManifest["parent"]> {
  const rows = await db.select({
    promotionItemId: schema.analysisLabPromotionItems.id,
    runId: schema.analysisLabPromotionItems.runId,
    planSha256: schema.analysisLabPromotionItems.planSha256,
    deepAnalysisRunId: schema.analysisLabPromotionItems.deepAnalysisRunId,
    afterSha256: schema.analysisLabPromotionItems.afterSha256,
    appliedAt: schema.analysisLabPromotionItems.appliedAt,
    releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
    releaseManifest: schema.analysisLabPromotionReleases.manifest,
    deepRunSourceRevisionSha256: schema.grantDeepAnalysisRuns.sourceRevisionSha256,
    deepRunAttachmentManifestSha256: schema.grantDeepAnalysisRuns.attachmentManifestSha256,
    deepRunStatus: schema.grantDeepAnalysisRuns.status,
  }).from(schema.analysisLabPromotionItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionReleases.id, schema.analysisLabPromotionItems.releaseDbId),
    )
    .leftJoin(
      schema.grantDeepAnalysisRuns,
      eq(schema.analysisLabPromotionItems.deepAnalysisRunId, schema.grantDeepAnalysisRuns.id),
    )
    .where(and(
      eq(schema.analysisLabPromotionItems.grantId, grantId),
      eq(schema.analysisLabPromotionItems.status, "applied"),
      isNull(schema.analysisLabPromotionItems.rolledBackAt),
      inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
    ));
  const ordered = rows
    .filter((candidate): candidate is typeof candidate & { appliedAt: Date } =>
      candidate.appliedAt instanceof Date)
    .sort((left, right) => right.appliedAt.getTime() - left.appliedAt.getTime());
  const row = ordered[0];
  if (!row || ordered[1]?.appliedAt.getTime() === row.appliedAt.getTime()) {
    throw new Error(`source_rebind_parent_not_unique:${grantId}:${rows.length}`);
  }
  if (!row.afterSha256 || !row.appliedAt) throw new Error("source_rebind_parent_receipt_incomplete");
  const manifest = validatePromotionReleaseManifest(row.releaseManifest);
  if (manifest.manifestSha256 !== row.releaseManifestSha256) {
    throw new Error("source_rebind_parent_manifest_mismatch");
  }
  const serving = resolvePromotionServingEvidence({
    grantId,
    runId: row.runId,
    planSha256: row.planSha256,
    deepAnalysisRunId: row.deepAnalysisRunId,
    releaseManifestSha256: row.releaseManifestSha256,
    manifest: row.releaseManifest,
    deepRunSourceRevisionSha256: row.deepRunSourceRevisionSha256,
  });
  if (!serving) throw new Error("source_rebind_parent_provenance_invalid");
  const artifact = manifest.sourceArtifacts.find((candidate) =>
    candidate.grantId === grantId && candidate.runId === row.runId);
  const sourceRevisionSha256 = artifact?.sourceRevisionSha256
    ?? artifact?.localLabEvidence?.analysisLaunch?.sourceRevisionSha256
    ?? artifact?.localLabEvidence?.deepRepair?.sourceRevisionSha256;
  exactSha(sourceRevisionSha256, "parent_source_revision");
  const attachmentManifestSha256 = artifact?.localLabEvidence?.analysisLaunch?.attachmentManifestSha256
    ?? artifact?.localLabEvidence?.deepRepair?.attachmentManifestSha256
    ?? row.deepRunAttachmentManifestSha256;
  if (row.deepAnalysisRunId && (
    row.deepRunStatus !== "passed"
    || artifact?.deepAnalysisRunId !== row.deepAnalysisRunId
    || row.deepRunSourceRevisionSha256 !== sourceRevisionSha256
    || row.deepRunAttachmentManifestSha256 !== attachmentManifestSha256
  )) throw new Error("source_rebind_parent_deep_run_binding_invalid");
  const current = await loadPromotionGrantSnapshot(db, grantId);
  const currentServingStateSha256 = promotionGrantSnapshotStateSha256(current);
  const [migrations, sourceRebinds] = await Promise.all([
    loadLegacyQuestionMigrationServingStates(db, [row.promotionItemId]),
    loadSourceRebindServingStates(db, [row.promotionItemId]),
  ]);
  const sourceRebind = sourceRebinds.get(row.promotionItemId);
  const sourceFrontierCurrent = sourceRebind?.rootSourceRevisionSha256 === sourceRevisionSha256
    && sourceRebindFrontierMatchesServingState({
      state: sourceRebind,
      grantId,
      currentStateSha256: currentServingStateSha256,
    });
  if (!sourceFrontierCurrent && !promotionStateMatchesParentOrMigration({
    currentStateSha256: currentServingStateSha256,
    parentAfterSha256: row.afterSha256,
    successor: migrations.get(row.promotionItemId),
    grantId,
  })) throw new Error("source_rebind_parent_serving_drift");
  return {
    promotionItemId: row.promotionItemId,
    runId: row.runId,
    afterSha256: row.afterSha256,
    currentServingStateSha256,
    rootSourceRevisionSha256: sourceRevisionSha256!,
    sourceRevisionSha256: sourceFrontierCurrent
      ? sourceRebind!.currentSourceRevisionSha256
      : sourceRevisionSha256!,
  };
}

async function assertCurrentAdmissionMatches(
  db: CunoteDbSession,
  manifest: SourceRebindReleaseManifest,
  lockRows: boolean,
): Promise<void> {
  const current = await loadSourceRebindAdmissionMaterial(db, manifest.grantId, lockRows);
  const rebuilt = createSourceRebindReleaseManifest({
    releaseId: manifest.releaseId,
    gitCommit: manifest.gitCommit,
    buildDigest: manifest.buildDigest,
    material: current,
  });
  if (rebuilt.manifestSha256 !== manifest.manifestSha256) {
    throw new Error("source_rebind_admission_drift");
  }
}

async function loadReleaseAndItem(
  db: CunoteDbSession,
  manifest: SourceRebindReleaseManifest,
  required: boolean,
) {
  const [release] = await db.select().from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, manifest.releaseId)).limit(1);
  if (!release) {
    if (required) throw new Error("source_rebind_release_missing");
    return null;
  }
  if (
    release.manifestSha256 !== manifest.manifestSha256
    || release.releasePlanSha256 !== manifest.releasePlanSha256
    || sha256Canonical(release.manifest) !== sha256Canonical(manifest)
  ) throw new Error("source_rebind_release_ledger_mismatch");
  const [item] = await db.select().from(schema.analysisLabSourceRebindItems)
    .where(eq(schema.analysisLabSourceRebindItems.releaseDbId, release.id)).limit(1);
  if (!item) {
    if (required) throw new Error("source_rebind_item_missing");
    return null;
  }
  if (
    item.grantId !== manifest.grantId
    || item.parentPromotionItemId !== manifest.parent.promotionItemId
    || item.impactSha256 !== manifest.sourceChangeImpactSha256
    || item.previousSourceRevisionSha256 !== manifest.parent.sourceRevisionSha256
    || item.previousSourceRawSha256 !== manifest.source.previousRawSha256
    || item.currentSourceRevisionSha256 !== manifest.source.currentRevisionSha256
    || item.currentSourceRawSha256 !== manifest.source.currentRawSha256
    || item.currentMaterialSourceRevisionSha256 !== manifest.source.currentMaterialRevisionSha256
    || item.beforeServingSha256 !== manifest.parent.currentServingStateSha256
    || item.beforeSha256 !== sha256Canonical(beforeReceiptSnapshot(manifest))
  ) throw new Error("source_rebind_item_binding_mismatch");
  return { release, item };
}

async function assertAppliedSourceRebindCurrent(
  db: CunoteDbSession,
  manifest: SourceRebindReleaseManifest,
  expectedServingStateSha256: string | null,
): Promise<void> {
  if (!expectedServingStateSha256) throw new Error("source_rebind_serving_receipt_missing");
  const source = await loadDeepAnalysisSourceBinding({ db, grantId: manifest.grantId, lockRaw: true });
  if (!source) throw new Error("source_rebind_applied_source_drift");
  const current = await loadPromotionGrantSnapshot(db, manifest.grantId);
  const currentStateSha256 = promotionGrantSnapshotStateSha256(current);
  if (
    source.sourceRevisionSha256 === manifest.source.currentRevisionSha256
    && source.sourceRawSha256 === manifest.source.currentRawSha256
    && source.materialSourceRevisionSha256 === manifest.source.currentMaterialRevisionSha256
    && currentStateSha256 === expectedServingStateSha256
  ) return;
  const states = await loadSourceRebindServingStates(db, [manifest.parent.promotionItemId]);
  const frontier = states.get(manifest.parent.promotionItemId);
  if (
    frontier?.rootSourceRevisionSha256 !== manifest.parent.rootSourceRevisionSha256
    || !frontier.sourceRevisionChain.includes(manifest.source.currentRevisionSha256)
    || !sourceRebindFrontierMatchesServingState({
      state: frontier,
      grantId: manifest.grantId,
      currentStateSha256,
    })
    || frontier.currentSourceRevisionSha256 !== source.sourceRevisionSha256
    || frontier.currentSourceRawSha256 !== source.sourceRawSha256
    || frontier.currentMaterialSourceRevisionSha256 !== source.materialSourceRevisionSha256
  ) throw new Error("source_rebind_applied_successor_drift");
}

function assertAdmissionMaterial(material: SourceRebindAdmissionMaterial): void {
  exactUuid(material.grantId, "grant_id");
  exactUuid(material.parent.promotionItemId, "parent_item");
  nonEmpty(material.parent.runId, "parent_run");
  exactSha(material.parent.afterSha256, "parent_after");
  exactSha(material.parent.currentServingStateSha256, "parent_serving");
  exactSha(material.parent.rootSourceRevisionSha256, "parent_root_source_revision");
  exactSha(material.parent.sourceRevisionSha256, "parent_source_revision");
  exactSha(material.source.previousRawSha256, "previous_raw");
  exactSha(material.source.currentRawSha256, "current_raw");
  exactSha(material.source.currentRevisionSha256, "current_revision");
  exactSha(material.source.currentMaterialRevisionSha256, "current_material_revision");
  const impact = parseGrantSourceChangeImpact(material.sourceChangeImpact);
  if (
    !impact
    || impact.classification !== "evidence_refresh"
    || impact.requiresModelRun !== false
    || impact.changedDomains.length !== 1
    || impact.changedDomains[0] !== "raw"
    || impact.previousRawSha256 !== material.source.previousRawSha256
    || impact.currentRawSha256 !== material.source.currentRawSha256
    || material.source.previousRawSha256 === material.source.currentRawSha256
    || material.parent.sourceRevisionSha256 === material.source.currentRevisionSha256
  ) throw new Error("source_rebind_impact_not_meaning_invariant");
  const seen = new Set<string>();
  for (const question of material.questions) {
    exactUuid(question.questionId, "question_id");
    exactUuid(question.criterionId, "criterion_id");
    exactSha(question.beforeDefinitionSha256, "before_definition");
    exactSha(question.afterDefinitionSha256, "after_definition");
    if (
      seen.has(question.questionId)
      || !Number.isSafeInteger(question.questionVersion)
      || question.questionVersion < 1
      || !Number.isSafeInteger(question.answerCount)
      || question.answerCount < 0
      || question.beforeDefinitionSha256 === question.afterDefinitionSha256
    ) throw new Error(`source_rebind_question_plan_invalid:${question.questionId}`);
    seen.add(question.questionId);
  }
}

function beforeReceiptSnapshot(manifest: SourceRebindReleaseManifest): Record<string, unknown> {
  return {
    schema: "source-rebind-before-v1",
    grantId: manifest.grantId,
    parentPromotionItemId: manifest.parent.promotionItemId,
    parentServingStateSha256: manifest.parent.currentServingStateSha256,
    rootSourceRevisionSha256: manifest.parent.rootSourceRevisionSha256,
    previousSourceRevisionSha256: manifest.parent.sourceRevisionSha256,
    previousSourceRawSha256: manifest.source.previousRawSha256,
    sourceChangeImpactSha256: manifest.sourceChangeImpactSha256,
    questions: manifest.questions,
  };
}

async function invalidateMatchStates(db: CunoteDbSession, grantId: string): Promise<void> {
  const links = await db.select({
    canonicalGrantId: schema.dedupLinks.canonicalGrantId,
    memberGrantId: schema.dedupLinks.memberGrantId,
  }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true));
  const affected = expandConfirmedGrantComponentIds([grantId], links);
  await db.delete(schema.matchState).where(inArray(schema.matchState.grantId, affected));
}

async function updateReleaseStatus(
  db: CunoteDbSession,
  releaseDbId: string,
  expected: string,
  status: "applying" | "active",
  executedBy: string,
): Promise<void> {
  const rows = await db.update(schema.analysisLabPromotionReleases).set({
    status,
    executedBy,
    ...(status === "applying" ? { startedAt: new Date() } : { completedAt: new Date() }),
  }).where(and(
    eq(schema.analysisLabPromotionReleases.id, releaseDbId),
    eq(schema.analysisLabPromotionReleases.status, expected),
  )).returning({ id: schema.analysisLabPromotionReleases.id });
  if (rows.length !== 1) throw new Error("source_rebind_release_status_cas_failed");
}

function withoutManifestSha(manifest: SourceRebindReleaseManifest): Omit<SourceRebindReleaseManifest, "manifestSha256"> {
  const { manifestSha256: _manifestSha256, ...body } = manifest;
  return body;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`source_rebind_${label}_invalid`);
  return value.trim();
}

function exactSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`source_rebind_${label}_invalid`);
  }
}

function exactUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`source_rebind_${label}_invalid`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
