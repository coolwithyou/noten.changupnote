import { and, eq, inArray } from "drizzle-orm";
import {
  assertManifestConfirmation,
  readPromotionReleaseManifest,
} from "./promotion-release";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
  type PromotionCriterionSnapshot,
  type PromotionGrantSnapshot,
  type PromotionQuestionSnapshot,
} from "./promotion-snapshot";
import { getCunoteDb, type CunoteDb, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { acquireGrantPublicationLock } from "../ingestion/grantPublicationLock";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

type GrantCriterionInsert = typeof schema.grantCriteria.$inferInsert;

export function rollbackDriftReason(input: {
  itemStatus: string;
  expectedAfterSha256: string | null;
  currentSha256: string;
}): string | null {
  if (input.itemStatus !== "applied") return `item_status:${input.itemStatus}`;
  if (!input.expectedAfterSha256) return "after_hash_missing";
  if (input.expectedAfterSha256 !== input.currentSha256) return "rollback_drift";
  return null;
}

function criterionRestoreValues(row: PromotionCriterionSnapshot) {
  return {
    id: row.id,
    grantId: row.grantId,
    dimension: row.dimension as GrantCriterionInsert["dimension"],
    operator: row.operator as GrantCriterionInsert["operator"],
    value: row.value,
    kind: row.kind as GrantCriterionInsert["kind"],
    weight: row.weight,
    confidence: row.confidence,
    sourceSpan: row.sourceSpan,
    rawText: row.rawText,
    sourceField: row.sourceField,
    stableKey: row.stableKey,
    needsReview: row.needsReview,
    parserVersion: row.parserVersion,
  };
}

function questionRestoreValues(row: PromotionQuestionSnapshot) {
  return {
    id: row.id,
    grantId: row.grantId,
    grantCriteriaId: row.grantCriteriaId,
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
    invalidatedAt: row.invalidatedAt ? new Date(row.invalidatedAt) : null,
    invalidationReason: row.invalidationReason,
    createdAt: new Date(row.createdAt),
  };
}

async function restoreBeforeSnapshot(
  tx: CunoteDbSession,
  before: PromotionGrantSnapshot,
): Promise<void> {
  const currentQuestions = await tx
    .select({ id: schema.grantConfirmationQuestions.id })
    .from(schema.grantConfirmationQuestions)
    .where(eq(schema.grantConfirmationQuestions.grantId, before.grantId));
  if (currentQuestions.length > 0) {
    await tx
      .update(schema.grantConfirmationQuestions)
      .set({
        grantCriteriaId: null,
        invalidatedAt: new Date(),
        invalidationReason: "release_rolled_back",
      })
      .where(inArray(
        schema.grantConfirmationQuestions.id,
        currentQuestions.map((question) => question.id),
      ));
  }
  await tx
    .delete(schema.grantCriteria)
    .where(eq(schema.grantCriteria.grantId, before.grantId));
  if (before.criteria.length > 0) {
    await tx.insert(schema.grantCriteria).values(before.criteria.map(criterionRestoreValues));
  }

  const currentQuestionIds = new Set(currentQuestions.map((question) => question.id));
  for (const question of before.questions) {
    const values = questionRestoreValues(question);
    if (currentQuestionIds.has(question.id)) {
      await tx
        .update(schema.grantConfirmationQuestions)
        .set(values)
        .where(eq(schema.grantConfirmationQuestions.id, question.id));
    } else {
      await tx.insert(schema.grantConfirmationQuestions).values(values);
    }
  }
}

async function rollbackItem(input: {
  db: CunoteDb;
  releaseDbId: string;
  grantId: string;
  confirmedLinks: Array<{ canonicalGrantId: string; memberGrantId: string }>;
}): Promise<void> {
  await input.db.transaction(async (tx) => {
    await acquireGrantPublicationLock(tx, input.grantId);
    const [ledgerItem] = await tx
      .select()
      .from(schema.analysisLabPromotionItems)
      .where(and(
        eq(schema.analysisLabPromotionItems.releaseDbId, input.releaseDbId),
        eq(schema.analysisLabPromotionItems.grantId, input.grantId),
      ))
      .limit(1);
    if (!ledgerItem) throw new Error(`release item 원장 누락: ${input.grantId}`);
    const current = await loadPromotionGrantSnapshot(tx, input.grantId, input.confirmedLinks);
    const drift = rollbackDriftReason({
      itemStatus: ledgerItem.status,
      expectedAfterSha256: ledgerItem.afterSha256,
      currentSha256: promotionGrantSnapshotStateSha256(current),
    });
    if (drift) throw new Error(`${drift}: ${input.grantId}`);
    await tx
      .update(schema.analysisLabPromotionItems)
      .set({ status: "rolling_back", updatedAt: new Date() })
      .where(eq(schema.analysisLabPromotionItems.id, ledgerItem.id));

    const before = ledgerItem.beforeSnapshot as unknown as PromotionGrantSnapshot;
    await restoreBeforeSnapshot(tx, before);
    const affectedGrantIds = expandConfirmedGrantComponentIds(
      [input.grantId],
      input.confirmedLinks,
    );
    await tx
      .delete(schema.matchState)
      .where(inArray(schema.matchState.grantId, affectedGrantIds));
    const restored = await loadPromotionGrantSnapshot(tx, input.grantId, input.confirmedLinks);
    const restoredSha = promotionGrantSnapshotStateSha256(restored);
    if (restoredSha !== ledgerItem.beforeSha256) {
      throw new Error(`rollback_restore_mismatch: ${input.grantId}`);
    }
    const updated = await tx
      .update(schema.analysisLabPromotionItems)
      .set({
        status: "rolled_back",
        error: null,
        rolledBackAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.analysisLabPromotionItems.id, ledgerItem.id),
        eq(schema.analysisLabPromotionItems.status, "rolling_back"),
      ))
      .returning({ id: schema.analysisLabPromotionItems.id });
    if (updated.length !== 1) throw new Error(`rollback receipt 기록 실패: ${input.grantId}`);
  });
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  if (!releaseId) throw new Error("--release가 필요합니다.");
  const manifest = await readPromotionReleaseManifest(releaseId);
  const db = getCunoteDb();
  const [release] = await db
    .select()
    .from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId))
    .limit(1);
  if (!release) throw new Error("DB release 원장을 찾지 못했습니다.");
  if (!["canary_running", "canary_passed", "applying", "active", "partial_failed"].includes(release.status)) {
    throw new Error(`rollback 가능한 release 상태가 아닙니다: ${release.status}`);
  }
  const items = await db
    .select()
    .from(schema.analysisLabPromotionItems)
    .where(eq(schema.analysisLabPromotionItems.releaseDbId, release.id));
  const applied = items.filter((item) => item.status === "applied");
  if (applied.length === 0) throw new Error("rollback 대상 applied item이 없습니다.");
  const confirmedLinks = await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));
  const drifted: Array<{ grantId: string; reason: string }> = [];
  for (const item of applied) {
    const snapshot = await loadPromotionGrantSnapshot(db, item.grantId, confirmedLinks);
    const reason = rollbackDriftReason({
      itemStatus: item.status,
      expectedAfterSha256: item.afterSha256,
      currentSha256: promotionGrantSnapshotStateSha256(snapshot),
    });
    if (reason) drifted.push({ grantId: item.grantId, reason });
  }
  console.log(
    `[rollback] dry-run: ${releaseId} · 대상 ${applied.length} · drift ${drifted.length}`,
  );
  for (const drift of drifted) console.error(`[rollback] ${drift.grantId}: ${drift.reason}`);
  if (!hasFlag("write")) return drifted.length === 0 ? 0 : 2;
  assertManifestConfirmation(manifest, readArg("confirm"));
  const actor = readArg("actor")?.trim();
  if (!actor) throw new Error("--actor에 rollback 실행 담당자 식별자가 필요합니다.");
  if (drifted.length > 0) throw new Error("rollback drift가 있어 실복구를 거부합니다.");

  const started = await db
    .update(schema.analysisLabPromotionReleases)
    .set({ status: "rolling_back", executedBy: actor })
    .where(and(
      eq(schema.analysisLabPromotionReleases.id, release.id),
      eq(schema.analysisLabPromotionReleases.status, release.status),
    ))
    .returning({ id: schema.analysisLabPromotionReleases.id });
  if (started.length !== 1) throw new Error("rollback 상태 CAS가 실패했습니다.");
  const failures: string[] = [];
  for (const item of applied) {
    try {
      await rollbackItem({
        db,
        releaseDbId: release.id,
        grantId: item.grantId,
        confirmedLinks,
      });
      console.log(`[rollback] 복구 완료: ${item.grantId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${item.grantId}:${message}`);
      console.error(`[rollback] 복구 실패: ${item.grantId} · ${message}`);
    }
  }
  await db
    .update(schema.analysisLabPromotionReleases)
    .set({
      status: failures.length === 0 ? "rolled_back" : "partial_failed",
      rolledBackAt: failures.length === 0 ? new Date() : null,
    })
    .where(eq(schema.analysisLabPromotionReleases.id, release.id));
  return failures.length === 0 ? 0 : 2;
}

async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 정리 실패는 rollback 결과를 가리지 않는다.
  }
}

if (process.argv[1]?.endsWith("promotion-rollback.ts")) {
  main()
    .then(async (code) => {
      await closeDbIfLoaded();
      process.exit(code);
    })
    .catch(async (error) => {
      console.error("[rollback] 실패:", error instanceof Error ? error.message : error);
      await closeDbIfLoaded();
      process.exit(1);
    });
}
