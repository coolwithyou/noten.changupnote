// 공모 딥분석 실험실 — 확정 자산 승격 파이프라인 CLI (tsx 단독 실행, Phase B-4).
//
// ⚠️ 실험실 "DB 쓰기 0 원칙"의 **의도된 유일한 경계 통과 지점**이다. 검수·감사 확정
// criteria(B)를 grant_criteria 로, 확인 질문을 grant_confirmation_questions 로 발행한다.
// **기본은 release dry-run** — immutable release manifest의 대상·baseline·source·guard만
// 검증하고 DB 는 read 만 한다. 실쓰기는 receipt 기반 exact release와
// aggregate/shadow/dry-run 승인 원장에 묶인 경우에만 열린다.
//
// 릴리스 dry-run: pnpm lab:promote -- --release=<id> --dry-run
// 실발행: pnpm lab:promote -- --release=<id> [--grantId=<canary>] --write
//          --confirm=<manifestShaPrefix> --actor=<executor>
//
// 쓰기 경로(manifest-bound, per-grant 트랜잭션):
//   안정 키 기준 grant_criteria upsert → 질문 upsert(ID/FK 보존) → 소멸 질문 soft-invalidate
//   → 소멸 criterion만 삭제 → 해당 grantId의 match_state 삭제.
import { and, eq, inArray } from "drizzle-orm";
import {
  executePromotionWrites,
  findExistingQuestionForDefinition,
  indexExistingCriteriaByStableKey,
  nextQuestionVersion,
  type ExistingPromotionQuestion,
  type GrantPromotionPlan,
  type PromotionWritePort,
} from "./promote";
import { getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import {
  applyPreparedGrantApplicationPrecompute,
  prepareGrantApplicationPrecompute,
  type PreparedGrantApplicationPrecompute,
} from "../documents/applicationPrecomputeMaterialization";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import { acquireGrantPublicationLock } from "../ingestion/grantPublicationLock";
import { criterionInsertValues } from "../ingestion/normalizedGrantPublisher";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { verifyPromotionReleaseSources } from "./promotion-candidates";
import {
  buildPromotionApplicationPrecomputeReceipt,
  readBundledPromotionApplicationPrecompute,
  type PromotionApplicationPrecomputeEvidence,
} from "./application-precompute-release";
import {
  assertManifestConfirmation,
  promotionReleaseArtifactPath,
  readPromotionReleaseManifest,
  releasePlanItemHasUnsafePendingCriteria,
  writeImmutablePromotionArtifact,
  type PromotionDryRunArtifact,
  type PromotionReleaseManifest,
  type PromotionReleasePlanItem,
} from "./promotion-release";
import { assertReceiptBackedPromotionMutationAdmitted } from "./promotion-mutation-admission";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotHashes,
  promotionGrantSnapshotStateSha256,
  snapshotMatchesReleaseBaseline,
} from "./promotion-snapshot";

loadMonorepoEnv();

// ---- argv 파싱 ------------------------------------------------------------------------

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

// ---- Drizzle 쓰기 포트 (per-grant 트랜잭션 — 승인된 exact release만 호출) ---------------

function createDrizzlePromotionPort(
  db: CunoteDb,
  confirmedLinks: Array<{ canonicalGrantId: string; memberGrantId: string }>,
  releaseContext?: {
    releaseDbId: string;
    itemByGrantId: ReadonlyMap<string, PromotionReleasePlanItem>;
    prepareApplicationPrecompute?: (
      grantId: string,
      parentLabRunId: string,
    ) => Promise<{
      prepared: PreparedGrantApplicationPrecompute;
      evidence: PromotionApplicationPrecomputeEvidence;
    } | null>;
  },
): PromotionWritePort {
  return {
    async publishGrant(plan: GrantPromotionPlan) {
      const applicationPrecompute = releaseContext?.prepareApplicationPrecompute
        ? await releaseContext.prepareApplicationPrecompute(plan.grantId, plan.runId)
        : null;
      const publishResult = await db.transaction(async (tx) => {
        const releasePlanItem = releaseContext?.itemByGrantId.get(plan.grantId);
        if (releaseContext && !releasePlanItem) {
          throw new Error(`release manifest 밖의 공고 쓰기 거부: ${plan.grantId}`);
        }
        if (releasePlanItem) {
          await acquireGrantPublicationLock(tx, plan.grantId);
          const [ledgerItem] = await tx
            .select()
            .from(schema.analysisLabPromotionItems)
            .where(and(
              eq(schema.analysisLabPromotionItems.releaseDbId, releaseContext!.releaseDbId),
              eq(schema.analysisLabPromotionItems.grantId, plan.grantId),
            ))
            .limit(1);
          if (!ledgerItem) throw new Error(`release item 원장 누락: ${plan.grantId}`);
          const currentSnapshot = await loadPromotionGrantSnapshot(tx, plan.grantId, confirmedLinks);
          const currentSnapshotSha256 = promotionGrantSnapshotStateSha256(currentSnapshot);
          if (ledgerItem.status === "applied") {
            if (ledgerItem.afterSha256 === currentSnapshotSha256) {
              return {
                criteriaDeleted: 0,
                criteriaInserted: 0,
                criteriaUpdated: 0,
                questionsInserted: 0,
                questionsUpdated: 0,
                questionsInvalidated: 0,
                matchStatesDeleted: 0,
              };
            }
            throw new Error(`after_drift: 이미 적용된 공고 상태가 receipt와 다릅니다 (${plan.grantId})`);
          }
          if (ledgerItem.status !== "prepared" && ledgerItem.status !== "failed") {
            throw new Error(`release item 상태가 쓰기 가능하지 않습니다: ${ledgerItem.status}`);
          }
          if (
            !snapshotMatchesReleaseBaseline(currentSnapshot, releasePlanItem)
            || ledgerItem.beforeSha256 !== currentSnapshotSha256
          ) {
            throw new Error(`baseline_drift: manifest 준비 후 운영 기준이 변경됐습니다 (${plan.grantId})`);
          }
          await tx
            .update(schema.analysisLabPromotionItems)
            .set({ status: "applying", error: null, updatedAt: new Date() })
            .where(eq(schema.analysisLabPromotionItems.id, ledgerItem.id));
        }
        const existingCriteria = await tx
          .select({
            id: schema.grantCriteria.id,
            stableKey: schema.grantCriteria.stableKey,
            dimension: schema.grantCriteria.dimension,
            operator: schema.grantCriteria.operator,
            value: schema.grantCriteria.value,
            kind: schema.grantCriteria.kind,
            sourceSpan: schema.grantCriteria.sourceSpan,
          })
          .from(schema.grantCriteria)
          .where(eq(schema.grantCriteria.grantId, plan.grantId));
        const existingQuestions = await tx
          .select({
            id: schema.grantConfirmationQuestions.id,
            grantCriteriaId: schema.grantConfirmationQuestions.grantCriteriaId,
            criterionStableKey: schema.grantConfirmationQuestions.criterionStableKey,
            definitionSha256: schema.grantConfirmationQuestions.definitionSha256,
            version: schema.grantConfirmationQuestions.version,
            invalidatedAt: schema.grantConfirmationQuestions.invalidatedAt,
            prompt: schema.grantConfirmationQuestions.prompt,
            options: schema.grantConfirmationQuestions.options,
            answerType: schema.grantConfirmationQuestions.answerType,
            reusable: schema.grantConfirmationQuestions.reusable,
            conditionKey: schema.grantConfirmationQuestions.conditionKey,
          })
          .from(schema.grantConfirmationQuestions)
          .where(eq(schema.grantConfirmationQuestions.grantId, plan.grantId));
        const existingQuestionModels = existingQuestions as unknown as ExistingPromotionQuestion[];

        const criteriaByKey = indexExistingCriteriaByStableKey(existingCriteria);

        const criterionIds: string[] = [];
        let criteriaInserted = 0;
        let criteriaUpdated = 0;
        for (const [position, criterion] of plan.criteria.entries()) {
          const stableKey = plan.criterionStableKeys[position];
          if (!stableKey) throw new Error(`criterion 안정 키 누락: position ${position}`);
          const values = { ...criterionInsertValues(plan.grantId, criterion), stableKey };
          const existing = criteriaByKey.get(stableKey);
          if (existing) {
            const [row] = await tx
              .update(schema.grantCriteria)
              .set(values)
              .where(eq(schema.grantCriteria.id, existing.id))
              .returning({ id: schema.grantCriteria.id });
            if (!row) throw new Error(`criteria update 실패: ${existing.id}`);
            criterionIds.push(row.id);
            criteriaUpdated += 1;
          } else {
            const [row] = await tx
              .insert(schema.grantCriteria)
              .values(values)
              .onConflictDoUpdate({
                target: [schema.grantCriteria.grantId, schema.grantCriteria.stableKey],
                set: values,
              })
              .returning({ id: schema.grantCriteria.id });
            if (!row) throw new Error(`criteria upsert 실패: ${plan.grantId}`);
            criterionIds.push(row.id);
            criteriaInserted += 1;
          }
        }

        const activeQuestionIds = new Set<string>();
        const supersededQuestionIds = new Set<string>();
        let questionsInserted = 0;
        let questionsUpdated = 0;
        for (const question of plan.questions) {
          const grantCriteriaId = criterionIds[question.criteriaPosition];
          if (!grantCriteriaId) {
            throw new Error(`질문 앵커 누락: position ${question.criteriaPosition} (${plan.grantId})`);
          }
          const values = {
            grantId: plan.grantId,
            grantCriteriaId,
            criterionStableKey: question.criterionStableKey,
            definitionSha256: question.definitionSha256,
            criterionRef: question.criterionRef as unknown as Record<string, unknown>,
            prompt: question.prompt,
            options: question.options as unknown as Array<Record<string, unknown>>,
            answerType: question.answerType,
            reusable: question.reusable,
            conditionKey: question.conditionKey,
            promptVer: question.promptVer,
            provenance: question.provenance as unknown as Record<string, unknown>,
            invalidatedAt: null,
            invalidationReason: null,
          };
          const existing = findExistingQuestionForDefinition(
            existingQuestionModels,
            question.criterionStableKey,
            question.definitionSha256,
            grantCriteriaId,
          );
          const previousActive = existingQuestionModels.find((row) =>
            (
              row.criterionStableKey === question.criterionStableKey
              || (row.criterionStableKey === null && row.grantCriteriaId === grantCriteriaId)
            )
            && row.invalidatedAt === null
            && row.id !== existing?.id);
          if (previousActive) {
            await tx
              .update(schema.grantConfirmationQuestions)
              .set({
                grantCriteriaId: null,
                invalidatedAt: new Date(),
                invalidationReason: "semantic_definition_superseded",
              })
              .where(eq(schema.grantConfirmationQuestions.id, previousActive.id));
            supersededQuestionIds.add(previousActive.id);
          }
          if (existing) {
            const [row] = await tx
              .update(schema.grantConfirmationQuestions)
              .set({
                grantCriteriaId,
                criterionStableKey: question.criterionStableKey,
                criterionRef: question.criterionRef as unknown as Record<string, unknown>,
                promptVer: question.promptVer,
                provenance: question.provenance as unknown as Record<string, unknown>,
                invalidatedAt: null,
                invalidationReason: null,
              })
              .where(eq(schema.grantConfirmationQuestions.id, existing.id))
              .returning({ id: schema.grantConfirmationQuestions.id });
            if (!row) throw new Error(`question update 실패: ${existing.id}`);
            activeQuestionIds.add(row.id);
            questionsUpdated += 1;
          } else {
            const [row] = await tx
              .insert(schema.grantConfirmationQuestions)
              .values({
                ...values,
                version: nextQuestionVersion(
                  existingQuestionModels,
                  question.criterionStableKey,
                  grantCriteriaId,
                ),
                supersedesQuestionId: previousActive?.id ?? null,
              })
              .onConflictDoUpdate({
                target: [
                  schema.grantConfirmationQuestions.grantId,
                  schema.grantConfirmationQuestions.criterionStableKey,
                  schema.grantConfirmationQuestions.definitionSha256,
                ],
                set: {
                  grantCriteriaId,
                  criterionRef: question.criterionRef as unknown as Record<string, unknown>,
                  promptVer: question.promptVer,
                  provenance: question.provenance as unknown as Record<string, unknown>,
                  invalidatedAt: null,
                  invalidationReason: null,
                },
              })
              .returning({ id: schema.grantConfirmationQuestions.id });
            if (!row) throw new Error(`question upsert 실패: ${question.criterionStableKey}`);
            activeQuestionIds.add(row.id);
            questionsInserted += 1;
          }
        }

        const staleQuestionIds = existingQuestionModels
          .filter((row) => row.invalidatedAt === null)
          .map((row) => row.id)
          .filter((id) => !activeQuestionIds.has(id) && !supersededQuestionIds.has(id));
        const questionsInvalidated = staleQuestionIds.length === 0
          ? 0
          : (
              await tx
                .update(schema.grantConfirmationQuestions)
                .set({
                  grantCriteriaId: null,
                  invalidatedAt: new Date(),
                  invalidationReason: "anchor_criterion_removed_or_changed",
                })
                .where(inArray(schema.grantConfirmationQuestions.id, staleQuestionIds))
                .returning({ id: schema.grantConfirmationQuestions.id })
            ).length;

        const staleCriterionIds = existingCriteria
          .map((row) => row.id)
          .filter((id) => !criterionIds.includes(id));
        const criteriaDeleted = staleCriterionIds.length === 0
          ? 0
          : (
              await tx
                .delete(schema.grantCriteria)
                .where(inArray(schema.grantCriteria.id, staleCriterionIds))
                .returning({ id: schema.grantCriteria.id })
            ).length;

        // publisher 패턴: confirmed dedup 컴포넌트로 확장해 match_state 삭제 — 다음 로드에서 재계산.
        const affectedGrantIds = expandConfirmedGrantComponentIds([plan.grantId], confirmedLinks);
        const matchStatesDeleted = (
          await tx
            .delete(schema.matchState)
            .where(inArray(schema.matchState.grantId, affectedGrantIds))
            .returning({ companyId: schema.matchState.companyId })
        ).length;

        const result = {
          criteriaDeleted,
          criteriaInserted,
          criteriaUpdated,
          questionsInserted,
          questionsUpdated,
          questionsInvalidated,
          matchStatesDeleted,
        };
        const applicationPrecomputeReceipt = applicationPrecompute
          ? await applyPreparedGrantApplicationPrecompute({
              db: tx,
              prepared: applicationPrecompute.prepared,
            }).then((applied) => buildPromotionApplicationPrecomputeReceipt({
              evidence: applicationPrecompute.evidence,
              applied,
            }))
          : {
              schema: "analysis-lab-application-precompute-receipt-v1",
              status: "not_applicable",
              roundtripRunId: null,
              materialized: 0,
              reused: 0,
              protected: 0,
              terminalOnly: 0,
              fields: 0,
              completedAt: new Date().toISOString(),
            };
        if (releaseContext) {
          const afterSnapshot = await loadPromotionGrantSnapshot(tx, plan.grantId, confirmedLinks);
          const afterSha256 = promotionGrantSnapshotStateSha256(afterSnapshot);
          const updated = await tx
            .update(schema.analysisLabPromotionItems)
            .set({
              afterSnapshot: afterSnapshot as unknown as Record<string, unknown>,
              afterSha256,
              applicationPrecomputeReceipt: applicationPrecomputeReceipt as unknown as Record<string, unknown>,
              status: "applied",
              error: null,
              appliedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(
              eq(schema.analysisLabPromotionItems.releaseDbId, releaseContext.releaseDbId),
              eq(schema.analysisLabPromotionItems.grantId, plan.grantId),
              eq(schema.analysisLabPromotionItems.status, "applying"),
            ))
            .returning({ id: schema.analysisLabPromotionItems.id });
          if (updated.length !== 1) throw new Error(`release item receipt 기록 실패: ${plan.grantId}`);
        }
        return result;
      });
      return publishResult;
    },
  };
}

// ---- 메인 ----------------------------------------------------------------------------

function releaseDryRunGuard(
  item: PromotionReleasePlanItem,
): PromotionDryRunArtifact["items"][number]["guard"] {
  if (item.promotionPlan.conversion.error) return "conversion_error";
  if (item.promotionPlan.criteria.length === 0) return "empty_criteria";
  if (
    releasePlanItemHasUnsafePendingCriteria(item)
  ) return "pending_criteria";
  return "pass";
}

async function verifyManifestSources(manifest: PromotionReleaseManifest): Promise<string[]> {
  return verifyPromotionReleaseSources(manifest.sourceArtifacts);
}

async function loadReleaseLedger(releaseId: string) {
  const db = getCunoteDb();
  const [release] = await db
    .select()
    .from(schema.analysisLabPromotionReleases)
    .where(eq(schema.analysisLabPromotionReleases.releaseId, releaseId))
    .limit(1);
  if (!release) throw new Error(`DB release 원장을 찾지 못했습니다: ${releaseId}`);
  return { db, release };
}

async function mainRelease(releaseId: string): Promise<number> {
  const manifest = await readPromotionReleaseManifest(releaseId);
  const grantFilter = readArg("grantId")?.trim();
  const write = hasFlag("write");
  if (write) assertReceiptBackedPromotionMutationAdmitted(manifest);
  const { db, release } = await loadReleaseLedger(releaseId);
  if (
    release.manifestSha256 !== manifest.manifestSha256
    || release.releasePlanSha256 !== manifest.releasePlanSha256
  ) {
    throw new Error("DB release 원장과 immutable manifest hash가 일치하지 않습니다.");
  }

  const changedArtifacts = await verifyManifestSources(manifest);
  const ledgerItems = await db
    .select()
    .from(schema.analysisLabPromotionItems)
    .where(eq(schema.analysisLabPromotionItems.releaseDbId, release.id));
  const ledgerByGrantId = new Map(ledgerItems.map((item) => [item.grantId, item]));
  const confirmedLinks = await db
    .select({
      canonicalGrantId: schema.dedupLinks.canonicalGrantId,
      memberGrantId: schema.dedupLinks.memberGrantId,
    })
    .from(schema.dedupLinks)
    .where(eq(schema.dedupLinks.confirmed, true));
  const dryRunItems: PromotionDryRunArtifact["items"] = [];
  for (const item of manifest.plans) {
    const snapshot = await loadPromotionGrantSnapshot(db, item.grantId, confirmedLinks);
    const hashes = promotionGrantSnapshotHashes(snapshot);
    const ledgerItem = ledgerByGrantId.get(item.grantId);
    if (!ledgerItem) throw new Error(`release item 원장 누락: ${item.grantId}`);
    const baselineMatches = ledgerItem.status === "applied"
      ? ledgerItem.afterSha256 === promotionGrantSnapshotStateSha256(snapshot)
      : snapshotMatchesReleaseBaseline(snapshot, item)
        && ledgerItem.beforeSha256 === promotionGrantSnapshotStateSha256(snapshot);
    dryRunItems.push({
      grantId: item.grantId,
      planSha256: item.planSha256,
      beforeCriteriaSha256: hashes.criteriaSha256,
      beforeQuestionsSha256: hashes.questionsSha256,
      dedupComponentSha256: hashes.dedupComponentSha256,
      baselineMatches,
      guard: releaseDryRunGuard(item),
      criteriaCountAfter: item.criteriaCountAfter,
      questionCountAfter: item.questionCountAfter,
    });
  }
  const dryRunPass = changedArtifacts.length === 0
    && dryRunItems.every((item) => item.baselineMatches && item.guard === "pass");

  if (!write) {
    if (grantFilter) throw new Error("release dry-run은 manifest 전체를 검증하며 --grantId를 받지 않습니다.");
    const artifact: PromotionDryRunArtifact = {
      schema: "analysis-lab-promotion-dry-run-v1",
      releaseId,
      releasePlanSha256: manifest.releasePlanSha256,
      manifestSha256: manifest.manifestSha256,
      createdAt: new Date().toISOString(),
      items: dryRunItems,
      verdict: dryRunPass ? "PASS" : "FAIL",
    };
    await writeImmutablePromotionArtifact(
      promotionReleaseArtifactPath(releaseId, "dry-run.json"),
      artifact,
    );
    console.log(
      `[promote] release dry-run ${artifact.verdict}: ${releaseId} · ` +
      `baseline ${dryRunItems.filter((item) => item.baselineMatches).length}/${dryRunItems.length} · ` +
      `source drift ${changedArtifacts.length}`,
    );
    if (changedArtifacts.length > 0) {
      console.error(`[promote] source artifact drift: ${changedArtifacts.join(", ")}`);
    }
    return dryRunPass ? 0 : 2;
  }

  assertManifestConfirmation(manifest, readArg("confirm"));
  const actor = readArg("actor")?.trim();
  if (!actor) throw new Error("--actor에 실행 담당자 식별자가 필요합니다.");
  if (!dryRunPass) {
    throw new Error("현재 source/baseline/guard가 manifest dry-run 조건과 달라 쓰기를 거부합니다.");
  }
  if (!release.approvedBy || release.approvedBy === actor) {
    throw new Error("최초 release는 승인자와 실행자가 달라야 합니다.");
  }

  let targetItems: PromotionReleasePlanItem[];
  let nextRunningStatus: "canary_running" | "applying";
  if (grantFilter) {
    if (!manifest.canaryGrantIds.includes(grantFilter)) {
      throw new Error(`--grantId는 manifest canary allowlist에만 허용됩니다: ${grantFilter}`);
    }
    if (!["approved", "canary_running"].includes(release.status)) {
      throw new Error(`카나리 쓰기 가능한 release 상태가 아닙니다: ${release.status}`);
    }
    targetItems = manifest.plans.filter((item) => item.grantId === grantFilter);
    nextRunningStatus = "canary_running";
  } else {
    if (release.status !== "canary_passed") {
      throw new Error(`전체 쓰기는 canary_passed 상태에서만 가능합니다: ${release.status}`);
    }
    targetItems = manifest.plans;
    nextRunningStatus = "applying";
  }
  if (targetItems.length === 0) throw new Error("release 쓰기 대상이 0건입니다.");
  const sourceArtifactByGrantId = new Map(
    manifest.sourceArtifacts.map((artifact) => [artifact.grantId, artifact]),
  );
  const requiresApplicationPrecompute = targetItems.some((item) =>
    sourceArtifactByGrantId.get(item.grantId)?.applicationPrecompute !== undefined);
  const applicationStorage = createR2ObjectStorageFromEnv();
  if (requiresApplicationPrecompute && !applicationStorage) {
    throw new Error("Kordoc release artifact 반영에 필요한 R2 설정이 없습니다.");
  }

  const statusUpdated = await db
    .update(schema.analysisLabPromotionReleases)
    .set({
      status: nextRunningStatus,
      executedBy: actor,
      startedAt: release.startedAt ?? new Date(),
    })
    .where(and(
      eq(schema.analysisLabPromotionReleases.id, release.id),
      eq(schema.analysisLabPromotionReleases.status, release.status),
    ))
    .returning({ id: schema.analysisLabPromotionReleases.id });
  if (statusUpdated.length !== 1) throw new Error("release 실행 상태 CAS가 실패했습니다.");

  const itemByGrantId = new Map(manifest.plans.map((item) => [item.grantId, item]));
  const port = createDrizzlePromotionPort(db, confirmedLinks, {
    releaseDbId: release.id,
    itemByGrantId,
    ...(applicationStorage
      ? {
          prepareApplicationPrecompute: async (grantId: string, parentLabRunId: string) => {
            const evidence = sourceArtifactByGrantId.get(grantId)?.applicationPrecompute;
            if (!evidence) return null;
            const roundtripArtifacts = await readBundledPromotionApplicationPrecompute(evidence);
            const prepared = await prepareGrantApplicationPrecompute({
              grantId,
              parentLabRunId,
              db,
              storage: applicationStorage,
              roundtripArtifacts,
            });
            if (!prepared) {
              throw new Error(`release Kordoc 증거와 LabRun 참조가 일치하지 않습니다: ${grantId}`);
            }
            console.log(
              `[promote] Kordoc 선분석 준비: ${grantId} · `
                + `surface ${prepared.surfaces.length} · model ${evidence.model}`,
            );
            return { prepared, evidence };
          },
        }
      : {}),
  });
  const outcomes = await executePromotionWrites(
    targetItems.map((item) => item.promotionPlan),
    port,
  );
  const failures = outcomes.filter((outcome) => outcome.error !== null);
  for (const failure of failures) {
    await db
      .update(schema.analysisLabPromotionItems)
      .set({ status: "failed", error: failure.error, updatedAt: new Date() })
      .where(and(
        eq(schema.analysisLabPromotionItems.releaseDbId, release.id),
        eq(schema.analysisLabPromotionItems.grantId, failure.plan.grantId),
      ));
    console.error(`[promote] release item 실패: ${failure.plan.grantId} · ${failure.error}`);
  }

  let terminalStatus: "canary_running" | "canary_passed" | "active" | "partial_failed";
  if (failures.length > 0) {
    terminalStatus = "partial_failed";
  } else if (grantFilter) {
    const ledgerItems = await db
      .select({
        grantId: schema.analysisLabPromotionItems.grantId,
        status: schema.analysisLabPromotionItems.status,
      })
      .from(schema.analysisLabPromotionItems)
      .where(eq(schema.analysisLabPromotionItems.releaseDbId, release.id));
    const statusByGrant = new Map(ledgerItems.map((item) => [item.grantId, item.status]));
    terminalStatus = manifest.canaryGrantIds.every((grantId) => statusByGrant.get(grantId) === "applied")
      ? "canary_passed"
      : "canary_running";
  } else {
    terminalStatus = "active";
  }
  await db
    .update(schema.analysisLabPromotionReleases)
    .set({
      status: terminalStatus,
      completedAt: terminalStatus === "active" ? new Date() : null,
    })
    .where(eq(schema.analysisLabPromotionReleases.id, release.id));
  console.log(
    `[promote] release 쓰기 완료: ${releaseId} · 성공 ${outcomes.length - failures.length}` +
    ` · 실패 ${failures.length} · 상태 ${terminalStatus}`,
  );
  return failures.length === 0 ? 0 : 2;
}

async function main(): Promise<number> {
  const releaseId = readArg("release")?.trim();
  if (!releaseId) {
    throw new Error("--release가 필요합니다. legacy review/audit 후보 자동 수집 경로는 폐기됐습니다.");
  }
  return mainRelease(releaseId);
}

/** DB 커넥션이 로드된 경우에만 닫는다 — verify 계열 미종료 전례 방지(confirmations-cli 관행). */
async function closeDbIfLoaded(): Promise<void> {
  try {
    const { closeCunoteDb } = await import("../db/client");
    await closeCunoteDb();
  } catch {
    // 커넥션 정리 실패는 종료를 막지 않는다
  }
}

main()
  .then(async (code) => {
    await closeDbIfLoaded();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error("[promote] 실패:", error instanceof Error ? error.message : error);
    await closeDbIfLoaded();
    process.exit(1);
  });
