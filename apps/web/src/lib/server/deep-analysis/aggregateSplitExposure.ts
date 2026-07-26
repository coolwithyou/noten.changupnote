import {
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
} from "@cunote/contracts";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  max,
  sql,
} from "drizzle-orm";

import type { CunoteDb, CunoteDbSession } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { validatePromotionReleaseManifest } from "../analysis-lab/promotion-release";
import { appendVerifiedDeepAnalysisStageReceipt } from "./receipts";
import { verifyDeepAnalysisReleaseServing } from "./verify-serving-cli";

type AggregateSplitCase = typeof schema.grantAggregateSplitCases.$inferSelect;
type AggregateSplitChild = typeof schema.grantAggregateSplitChildren.$inferSelect;
type DeepAnalysisRun = typeof schema.grantDeepAnalysisRuns.$inferSelect;

export interface AggregateSplitExposureCandidate {
  splitCase: AggregateSplitCase;
  children: AggregateSplitChild[];
  parentServingState: string | null;
  childServingStates: Map<string, string>;
  release: typeof schema.analysisLabPromotionReleases.$inferSelect;
  items: Array<{
    id: string;
    grantId: string;
    status: string;
    deepAnalysisRunId: string;
    run: DeepAnalysisRun;
    stageReceipts: Partial<Record<
      "publication_complete" | "serving_complete" | "analysis_fresh",
      { status: string; evidence: Record<string, unknown> }
    >>;
  }>;
}

export interface AggregateSplitExposureGateResult {
  ready: boolean;
  phase: "ready" | "resume" | "complete" | "blocked";
  firstBlocker: { code: string; message: string } | null;
}

export interface AggregateSplitExposurePort {
  loadCandidate(): Promise<AggregateSplitExposureCandidate>;
  transitionVisibility(
    candidate: AggregateSplitExposureCandidate,
  ): Promise<{
    outcome: "transitioned" | "resumed" | "already_visible";
    candidate: AggregateSplitExposureCandidate;
  }>;
  verifyServing(
    candidate: AggregateSplitExposureCandidate,
  ): Promise<{ failures: Array<{ grantId: string; stage: string; issues: string[] }> }>;
  finalizeVisibility(candidate: AggregateSplitExposureCandidate): Promise<void>;
  rollbackVisibility(
    candidate: AggregateSplitExposureCandidate,
    failure: AggregateSplitExposureFailure,
  ): Promise<void>;
  appendRollbackReceipts(
    candidate: AggregateSplitExposureCandidate,
    failure: AggregateSplitExposureFailure,
  ): Promise<void>;
}

export interface AggregateSplitExposureFailure {
  code: string;
  message: string;
}

export interface AggregateSplitExposureResult {
  splitCaseId: string;
  releaseId: string;
  outcome: "already_visible" | "visible";
  childCount: number;
}

/**
 * E-3B-3B의 외부 seam. S12 gate 뒤 atomic visibility 전환, 기존 S13/S14 verifier,
 * 성공 확정 또는 visibility rollback을 한 호출 뒤에 숨긴다.
 */
export async function runAggregateSplitExposure(
  port: AggregateSplitExposurePort,
): Promise<AggregateSplitExposureResult> {
  const initial = await port.loadCandidate();
  const initialGate = evaluateAggregateSplitExposureGate(initial);
  if (!initialGate.ready) {
    throw exposureError(
      initialGate.firstBlocker?.code ?? "aggregate_split_exposure_gate_failed",
      initialGate.firstBlocker?.message ?? "통합공고 노출 전환 gate가 닫혀 있습니다.",
    );
  }
  const transition = await port.transitionVisibility(initial);
  if (transition.outcome === "already_visible") {
    return {
      splitCaseId: transition.candidate.splitCase.id,
      releaseId: transition.candidate.release.releaseId,
      outcome: "already_visible",
      childCount: transition.candidate.children.length,
    };
  }

  try {
    const verification = await port.verifyServing(transition.candidate);
    if (verification.failures.length > 0) {
      throw exposureError(
        "aggregate_split_serving_verification_failed",
        verification.failures
          .map((failure) => `${failure.grantId}:${failure.stage}:${failure.issues.join("|")}`)
          .join(", "),
      );
    }
    await port.finalizeVisibility(transition.candidate);
    return {
      splitCaseId: transition.candidate.splitCase.id,
      releaseId: transition.candidate.release.releaseId,
      outcome: "visible",
      childCount: transition.candidate.children.length,
    };
  } catch (error) {
    const failure = normalizeExposureFailure(error);
    await port.rollbackVisibility(transition.candidate, failure);
    try {
      await port.appendRollbackReceipts(transition.candidate, failure);
    } catch (receiptError) {
      throw exposureError(
        "aggregate_split_rollback_receipt_failed",
        `${failure.message}; rollback receipt: ${
          receiptError instanceof Error ? receiptError.message : String(receiptError)
        }`,
      );
    }
    throw new AggregateSplitExposureError(failure.code, failure.message);
  }
}

export function evaluateAggregateSplitExposureGate(
  candidate: AggregateSplitExposureCandidate,
): AggregateSplitExposureGateResult {
  const { splitCase, children, release, items } = candidate;
  if (
    splitCase.status !== "completed"
    || splitCase.materializationStatus !== "prepared"
    || splitCase.promotionStatus !== "enqueued"
  ) {
    return blocked(
      "aggregate_split_exposure_case_not_ready",
      "분리·child 준비·깊은 분석 enqueue가 완료된 case가 아닙니다.",
    );
  }
  const expectedCount = splitCase.programCount;
  if (
    expectedCount === null
    || expectedCount <= 1
    || children.length !== expectedCount
    || splitCase.preparedChildCount !== expectedCount
    || splitCase.stagedChildCount !== expectedCount
    || splitCase.enqueuedChildCount !== expectedCount
  ) {
    return blocked(
      "aggregate_split_exposure_child_count_mismatch",
      "manifest/prepared/staged/enqueued child 수가 일치하지 않습니다.",
    );
  }
  if (release.status !== "active") {
    return blocked(
      "aggregate_split_exposure_release_not_active",
      `promotion release가 active가 아닙니다: ${release.status}`,
    );
  }
  const gateSummary = release.gateSummary;
  if (
    !isRecord(gateSummary)
    || gateSummary.schema !== "aggregate-split-publication-gate-v1"
    || gateSummary.verdict !== "PASS"
    || gateSummary.splitCaseId !== splitCase.id
    || gateSummary.parentGrantId !== splitCase.grantId
    || Number(gateSummary.childCount) !== expectedCount
  ) {
    return blocked(
      "aggregate_split_exposure_release_gate_mismatch",
      "release gate summary가 이 case의 전체 child PASS 증적과 일치하지 않습니다.",
    );
  }
  const manifest = validatePromotionReleaseManifest(release.manifest);
  const manifestGrantIds = manifest.plans.map((plan) => plan.grantId).sort();
  const childIds = children.map((child) => child.id).sort();
  if (
    manifest.releaseId !== release.releaseId
    || manifest.manifestSha256 !== release.manifestSha256
    || manifest.releasePlanSha256 !== release.releasePlanSha256
    || manifestGrantIds.length !== childIds.length
    || manifestGrantIds.some((grantId, index) => grantId !== childIds[index])
  ) {
    return blocked(
      "aggregate_split_exposure_manifest_child_set_mismatch",
      "immutable release manifest의 grant 집합이 case 전체 child 집합과 다릅니다.",
    );
  }
  if (items.length !== expectedCount) {
    return blocked(
      "aggregate_split_exposure_item_count_mismatch",
      "promotion release item 수가 case 전체 child 수와 다릅니다.",
    );
  }
  const itemByGrantId = new Map(items.map((item) => [item.grantId, item]));
  for (const child of children) {
    const item = itemByGrantId.get(child.id);
    if (!item || item.status !== "applied") {
      return blocked(
        "aggregate_split_exposure_item_not_applied",
        `${child.id} promotion item이 applied가 아닙니다.`,
      );
    }
    if (
      item.run.grantId !== child.id
      || item.run.id !== item.deepAnalysisRunId
      || item.run.sourceRevisionSha256 !== child.sourceRevisionSha256
      || item.run.inputSha256 !== child.inputSha256
      || item.run.status !== "passed"
    ) {
      return blocked(
        "aggregate_split_exposure_run_identity_mismatch",
        `${child.id}의 applied item/run/sealed child identity가 다릅니다.`,
      );
    }
    const publication = item.stageReceipts.publication_complete;
    if (
      publication?.status !== "passed"
      || publication.evidence.releaseId !== release.releaseId
      || publication.evidence.promotionItemId !== item.id
    ) {
      return blocked(
        "aggregate_split_exposure_s12_not_passed",
        `${child.id}의 최신 S12가 이 release/item의 passed receipt가 아닙니다.`,
      );
    }
  }

  const parentState = candidate.parentServingState;
  const childStates = children.map(
    (child) => candidate.childServingStates.get(child.id) ?? "missing",
  );
  if (
    splitCase.exposureStatus === "visible"
    || splitCase.exposureStatus === "verifying"
  ) {
    if (
      splitCase.exposureReleaseId !== release.releaseId
      || parentState !== "suppressed"
      || childStates.some((state) => state !== "visible")
    ) {
      return blocked(
        "aggregate_split_exposure_state_drift",
        "verifying/visible 원장과 parent/child serving state가 다릅니다.",
      );
    }
    const servingComplete = items.every((item) =>
      receiptMatchesReleaseItem(
        item.stageReceipts.serving_complete,
        release.releaseId,
        item.id,
      ));
    const analysisFresh = items.every((item) =>
      receiptMatchesReleaseItem(
        item.stageReceipts.analysis_fresh,
        release.releaseId,
        item.id,
      ));
    if (splitCase.exposureStatus === "visible") {
      if (!servingComplete || !analysisFresh || !splitCase.servingVerifiedAt) {
        return blocked(
          "aggregate_split_exposure_visible_receipt_mismatch",
          "visible 원장에 대응하는 최신 S13/S14 passed receipt가 없습니다.",
        );
      }
      return { ready: true, phase: "complete", firstBlocker: null };
    }
    return { ready: true, phase: "resume", firstBlocker: null };
  }
  if (!["not_ready", "rolled_back"].includes(splitCase.exposureStatus)) {
    return blocked(
      "aggregate_split_exposure_status_invalid",
      `지원하지 않는 exposure 상태입니다: ${splitCase.exposureStatus}`,
    );
  }
  if (
    parentState !== "visible"
    || childStates.some((state) => state !== "staged")
  ) {
    return blocked(
      "aggregate_split_exposure_pre_state_invalid",
      "전환 전 parent는 visible, 모든 child는 staged여야 합니다.",
    );
  }
  return { ready: true, phase: "ready", firstBlocker: null };
}

export function createAggregateSplitExposurePort(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  splitCaseId: string;
  actor: string;
  now?: () => Date;
}): AggregateSplitExposurePort {
  const now = input.now ?? (() => new Date());
  return {
    loadCandidate: () => loadAggregateSplitExposureCandidate(input.db, input.splitCaseId),
    transitionVisibility: (candidate) => transitionAggregateSplitVisibility(input.db, {
      expectedReleaseId: candidate.release.releaseId,
      splitCaseId: input.splitCaseId,
      actor: input.actor,
      now: now(),
    }),
    verifyServing: async (candidate) => {
      const result = await verifyDeepAnalysisReleaseServing({
        db: input.db,
        storage: input.storage,
        releaseId: candidate.release.releaseId,
        scope: "all",
        observationMode: "release_verification",
        verificationMode: "full",
        monitorExecutionId: null,
        monitorRuntime: "local",
      });
      return { failures: result.failures };
    },
    finalizeVisibility: (candidate) => finalizeAggregateSplitVisibility(input.db, {
      expectedReleaseId: candidate.release.releaseId,
      splitCaseId: input.splitCaseId,
      now: now(),
    }),
    rollbackVisibility: (candidate, failure) => rollbackAggregateSplitVisibility(input.db, {
      expectedReleaseId: candidate.release.releaseId,
      splitCaseId: input.splitCaseId,
      failure,
      now: now(),
    }),
    appendRollbackReceipts: (candidate, failure) =>
      appendAggregateSplitRollbackReceipts({
        db: input.db,
        storage: input.storage,
        candidate,
        failure,
      }),
  };
}

export async function runAggregateSplitExposureInvocation(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  splitCaseId: string;
  actor: string;
  now?: () => Date;
}): Promise<AggregateSplitExposureResult> {
  return runAggregateSplitExposure(createAggregateSplitExposurePort(input));
}

async function loadAggregateSplitExposureCandidate(
  db: CunoteDbSession,
  splitCaseId: string,
): Promise<AggregateSplitExposureCandidate> {
  const [splitCase] = await db
    .select()
    .from(schema.grantAggregateSplitCases)
    .where(eq(schema.grantAggregateSplitCases.id, splitCaseId))
    .limit(1);
  if (!splitCase) {
    throw exposureError(
      "aggregate_split_exposure_case_missing",
      `통합공고 분리 case가 없습니다: ${splitCaseId}`,
    );
  }
  const children = await db
    .select()
    .from(schema.grantAggregateSplitChildren)
    .where(eq(schema.grantAggregateSplitChildren.splitCaseId, splitCaseId))
    .orderBy(asc(schema.grantAggregateSplitChildren.ordinal));
  const releaseRows = splitCase.exposureReleaseId
    ? await db
      .select()
      .from(schema.analysisLabPromotionReleases)
      .where(eq(
        schema.analysisLabPromotionReleases.releaseId,
        splitCase.exposureReleaseId,
      ))
      .limit(1)
    : await db
      .select()
      .from(schema.analysisLabPromotionReleases)
      .where(and(
        eq(schema.analysisLabPromotionReleases.status, "active"),
        sql`${schema.analysisLabPromotionReleases.gateSummary}->>'splitCaseId' = ${splitCaseId}`,
      ))
      .orderBy(
        desc(schema.analysisLabPromotionReleases.createdAt),
        desc(schema.analysisLabPromotionReleases.id),
      )
      .limit(1);
  const [release] = releaseRows;
  if (!release) {
    throw exposureError(
      "aggregate_split_exposure_release_missing",
      "이 case의 active aggregate-split promotion release가 없습니다.",
    );
  }
  const itemRows = await db
    .select()
    .from(schema.analysisLabPromotionItems)
    .where(eq(schema.analysisLabPromotionItems.releaseDbId, release.id));
  const runIds = itemRows.flatMap(
    (item) => item.deepAnalysisRunId ? [item.deepAnalysisRunId] : [],
  );
  const grantIds = [splitCase.grantId, ...children.map((child) => child.id)];
  const [grantRows, runRows, receiptRows] = await Promise.all([
    db
      .select({
        id: schema.grants.id,
        servingState: schema.grants.servingState,
      })
      .from(schema.grants)
      .where(inArray(schema.grants.id, grantIds)),
    runIds.length > 0
      ? db
        .select()
        .from(schema.grantDeepAnalysisRuns)
        .where(inArray(schema.grantDeepAnalysisRuns.id, runIds))
      : [],
    runIds.length > 0
      ? db
        .select({
          id: schema.grantDeepAnalysisStageReceipts.id,
          runId: schema.grantDeepAnalysisStageReceipts.runId,
          stage: schema.grantDeepAnalysisStageReceipts.stage,
          status: schema.grantDeepAnalysisStageReceipts.status,
          evidence: schema.grantDeepAnalysisStageReceipts.evidence,
        })
        .from(schema.grantDeepAnalysisStageReceipts)
        .where(and(
          inArray(schema.grantDeepAnalysisStageReceipts.runId, runIds),
          inArray(schema.grantDeepAnalysisStageReceipts.stage, [
            "publication_complete",
            "serving_complete",
            "analysis_fresh",
          ]),
        ))
        .orderBy(
          desc(schema.grantDeepAnalysisStageReceipts.attempt),
          desc(schema.grantDeepAnalysisStageReceipts.createdAt),
          desc(schema.grantDeepAnalysisStageReceipts.id),
        )
      : [],
  ]);
  const grantStateById = new Map(
    grantRows.map((grant) => [grant.id, grant.servingState]),
  );
  const runById = new Map(runRows.map((run) => [run.id, run]));
  const latestReceiptByRunStage = new Map<string, (typeof receiptRows)[number]>();
  for (const receipt of receiptRows) {
    const key = `${receipt.runId}\u0000${receipt.stage}`;
    if (!latestReceiptByRunStage.has(key)) latestReceiptByRunStage.set(key, receipt);
  }
  const items = itemRows.flatMap((item) => {
    if (!item.deepAnalysisRunId) return [];
    const run = runById.get(item.deepAnalysisRunId);
    if (!run) return [];
    const stageReceipts: AggregateSplitExposureCandidate["items"][number]["stageReceipts"] = {};
    for (const stage of [
      "publication_complete",
      "serving_complete",
      "analysis_fresh",
    ] as const) {
      const receipt = latestReceiptByRunStage.get(`${run.id}\u0000${stage}`);
      if (receipt) {
        stageReceipts[stage] = {
          status: receipt.status,
          evidence: receipt.evidence,
        };
      }
    }
    return [{
      id: item.id,
      grantId: item.grantId,
      status: item.status,
      deepAnalysisRunId: item.deepAnalysisRunId,
      run,
      stageReceipts,
    }];
  });
  return {
    splitCase,
    children,
    parentServingState: grantStateById.get(splitCase.grantId) ?? null,
    childServingStates: new Map(
      children.map((child) => [child.id, grantStateById.get(child.id) ?? "missing"]),
    ),
    release,
    items,
  };
}

async function transitionAggregateSplitVisibility(
  db: CunoteDb,
  input: {
    splitCaseId: string;
    expectedReleaseId: string;
    actor: string;
    now: Date;
  },
): Promise<{
  outcome: "transitioned" | "resumed" | "already_visible";
  candidate: AggregateSplitExposureCandidate;
}> {
  return db.transaction(async (tx) => {
    await setShortTransactionTimeouts(tx);
    await lockAggregateSplitExposureRows(tx, input.splitCaseId);
    const candidate = await loadAggregateSplitExposureCandidate(tx, input.splitCaseId);
    if (candidate.release.releaseId !== input.expectedReleaseId) {
      throw exposureError(
        "aggregate_split_exposure_release_changed",
        "gate 검증 뒤 active release가 달라졌습니다.",
      );
    }
    const gate = evaluateAggregateSplitExposureGate(candidate);
    if (!gate.ready) {
      throw exposureError(
        gate.firstBlocker?.code ?? "aggregate_split_exposure_gate_changed",
        gate.firstBlocker?.message ?? "transaction 안에서 exposure gate가 달라졌습니다.",
      );
    }
    if (gate.phase === "complete") {
      return { outcome: "already_visible", candidate };
    }
    if (gate.phase === "resume") return { outcome: "resumed", candidate };

    const childIds = candidate.children.map((child) => child.id);
    const parentUpdated = await tx
      .update(schema.grants)
      .set({ servingState: "suppressed" })
      .where(and(
        eq(schema.grants.id, candidate.splitCase.grantId),
        eq(schema.grants.servingState, "visible"),
      ))
      .returning({ id: schema.grants.id });
    const childrenUpdated = await tx
      .update(schema.grants)
      .set({ servingState: "visible" })
      .where(and(
        inArray(schema.grants.id, childIds),
        eq(schema.grants.servingState, "staged"),
      ))
      .returning({ id: schema.grants.id });
    if (parentUpdated.length !== 1 || childrenUpdated.length !== childIds.length) {
      throw exposureError(
        "aggregate_split_exposure_atomic_update_failed",
        "parent/전체 child serving state CAS가 실패했습니다.",
      );
    }
    const caseUpdated = await tx
      .update(schema.grantAggregateSplitCases)
      .set({
        exposureStatus: "verifying",
        exposureReleaseId: candidate.release.releaseId,
        exposedChildCount: childIds.length,
        childrenVisibleAt: input.now,
        servingVerifiedAt: null,
        visibilityRolledBackAt: null,
        exposureActor: input.actor,
        exposureLastErrorCode: null,
        exposureLastErrorMessage: null,
        updatedAt: input.now,
      })
      .where(and(
        eq(schema.grantAggregateSplitCases.id, input.splitCaseId),
        inArray(schema.grantAggregateSplitCases.exposureStatus, [
          "not_ready",
          "rolled_back",
        ]),
      ))
      .returning({ id: schema.grantAggregateSplitCases.id });
    if (caseUpdated.length !== 1) {
      throw exposureError(
        "aggregate_split_exposure_case_cas_failed",
        "case exposure 상태 CAS가 실패했습니다.",
      );
    }
    const transitioned = await loadAggregateSplitExposureCandidate(tx, input.splitCaseId);
    const transitionedGate = evaluateAggregateSplitExposureGate(transitioned);
    if (!transitionedGate.ready || transitionedGate.phase !== "resume") {
      throw exposureError(
        "aggregate_split_exposure_readback_failed",
        transitionedGate.firstBlocker?.message
          ?? "parent/child visibility transaction readback이 실패했습니다.",
      );
    }
    return { outcome: "transitioned", candidate: transitioned };
  });
}

async function finalizeAggregateSplitVisibility(
  db: CunoteDb,
  input: {
    splitCaseId: string;
    expectedReleaseId: string;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await setShortTransactionTimeouts(tx);
    await lockAggregateSplitExposureRows(tx, input.splitCaseId);
    const candidate = await loadAggregateSplitExposureCandidate(tx, input.splitCaseId);
    if (candidate.release.releaseId !== input.expectedReleaseId) {
      throw exposureError(
        "aggregate_split_exposure_finalize_release_changed",
        "S13/S14 뒤 release identity가 달라졌습니다.",
      );
    }
    const gate = evaluateAggregateSplitExposureGate(candidate);
    const allServingPassed = candidate.items.every((item) =>
      receiptMatchesReleaseItem(
        item.stageReceipts.serving_complete,
        candidate.release.releaseId,
        item.id,
      ));
    const allFreshPassed = candidate.items.every((item) =>
      receiptMatchesReleaseItem(
        item.stageReceipts.analysis_fresh,
        candidate.release.releaseId,
        item.id,
      ));
    if (
      !gate.ready
      || gate.phase !== "resume"
      || !allServingPassed
      || !allFreshPassed
    ) {
      throw exposureError(
        "aggregate_split_exposure_finalize_receipts_missing",
        gate.firstBlocker?.message ?? "전체 child의 latest S13/S14 passed receipt가 없습니다.",
      );
    }
    const updated = await tx
      .update(schema.grantAggregateSplitCases)
      .set({
        exposureStatus: "visible",
        servingVerifiedAt: input.now,
        exposureLastErrorCode: null,
        exposureLastErrorMessage: null,
        updatedAt: input.now,
      })
      .where(and(
        eq(schema.grantAggregateSplitCases.id, input.splitCaseId),
        eq(schema.grantAggregateSplitCases.exposureStatus, "verifying"),
        eq(schema.grantAggregateSplitCases.exposureReleaseId, input.expectedReleaseId),
      ))
      .returning({ id: schema.grantAggregateSplitCases.id });
    if (updated.length !== 1) {
      throw exposureError(
        "aggregate_split_exposure_finalize_cas_failed",
        "serving verified 상태 확정 CAS가 실패했습니다.",
      );
    }
  });
}

async function rollbackAggregateSplitVisibility(
  db: CunoteDb,
  input: {
    splitCaseId: string;
    expectedReleaseId: string;
    failure: AggregateSplitExposureFailure;
    now: Date;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await setShortTransactionTimeouts(tx);
    await lockAggregateSplitExposureRows(tx, input.splitCaseId);
    const [splitCase] = await tx
      .select()
      .from(schema.grantAggregateSplitCases)
      .where(eq(schema.grantAggregateSplitCases.id, input.splitCaseId))
      .limit(1);
    if (!splitCase) throw new Error("rollback할 split case가 없습니다.");
    if (
      splitCase.exposureStatus === "rolled_back"
      && splitCase.exposureReleaseId === input.expectedReleaseId
    ) {
      return;
    }
    if (
      splitCase.exposureStatus !== "verifying"
      || splitCase.exposureReleaseId !== input.expectedReleaseId
    ) {
      throw exposureError(
        "aggregate_split_exposure_rollback_state_invalid",
        "verifying 중인 동일 release case만 visibility rollback할 수 있습니다.",
      );
    }
    const children = await tx
      .select({ id: schema.grantAggregateSplitChildren.id })
      .from(schema.grantAggregateSplitChildren)
      .where(eq(schema.grantAggregateSplitChildren.splitCaseId, input.splitCaseId));
    const childIds = children.map((child) => child.id);
    const parentUpdated = await tx
      .update(schema.grants)
      .set({ servingState: "visible" })
      .where(and(
        eq(schema.grants.id, splitCase.grantId),
        eq(schema.grants.servingState, "suppressed"),
      ))
      .returning({ id: schema.grants.id });
    const childrenUpdated = await tx
      .update(schema.grants)
      .set({ servingState: "staged" })
      .where(and(
        inArray(schema.grants.id, childIds),
        eq(schema.grants.servingState, "visible"),
      ))
      .returning({ id: schema.grants.id });
    if (parentUpdated.length !== 1 || childrenUpdated.length !== childIds.length) {
      throw exposureError(
        "aggregate_split_exposure_rollback_update_failed",
        "parent/전체 child visibility rollback CAS가 실패했습니다.",
      );
    }
    const updated = await tx
      .update(schema.grantAggregateSplitCases)
      .set({
        exposureStatus: "rolled_back",
        exposedChildCount: 0,
        servingVerifiedAt: null,
        visibilityRolledBackAt: input.now,
        exposureLastErrorCode: input.failure.code,
        exposureLastErrorMessage: input.failure.message.slice(0, 2_000),
        updatedAt: input.now,
      })
      .where(and(
        eq(schema.grantAggregateSplitCases.id, input.splitCaseId),
        eq(schema.grantAggregateSplitCases.exposureStatus, "verifying"),
        eq(schema.grantAggregateSplitCases.exposureReleaseId, input.expectedReleaseId),
      ))
      .returning({ id: schema.grantAggregateSplitCases.id });
    if (updated.length !== 1) {
      throw exposureError(
        "aggregate_split_exposure_rollback_case_cas_failed",
        "rollback 원장 CAS가 실패했습니다.",
      );
    }
  });
}

async function appendAggregateSplitRollbackReceipts(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  candidate: AggregateSplitExposureCandidate;
  failure: AggregateSplitExposureFailure;
}): Promise<void> {
  for (const item of input.candidate.items) {
    for (const stage of ["serving_complete", "analysis_fresh"] as const) {
      const [attemptRow] = await input.db
        .select({ value: max(schema.grantDeepAnalysisStageReceipts.attempt) })
        .from(schema.grantDeepAnalysisStageReceipts)
        .where(and(
          eq(schema.grantDeepAnalysisStageReceipts.runId, item.run.id),
          eq(schema.grantDeepAnalysisStageReceipts.stage, stage),
        ));
      await appendVerifiedDeepAnalysisStageReceipt({
        db: input.db,
        storage: input.storage,
        grantId: item.run.grantId,
        sourceRevisionSha256: item.run.sourceRevisionSha256,
        publicRunId: item.run.runId,
        databaseRunId: item.run.id,
        stage,
        status: stage === "serving_complete" ? "failed" : "blocked",
        verifierVersion: DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
        evidence: {
          schema: "aggregate-split-exposure-rollback-v1",
          splitCaseId: input.candidate.splitCase.id,
          releaseId: input.candidate.release.releaseId,
          promotionItemId: item.id,
          rollback: {
            parentServingState: "visible",
            childServingState: "staged",
          },
          failure: input.failure,
        },
        attempt: Number(attemptRow?.value ?? 0) + 1,
      });
    }
  }
}

async function lockAggregateSplitExposureRows(
  tx: CunoteDbSession,
  splitCaseId: string,
): Promise<void> {
  const rows = await tx.execute(sql`
    SELECT grant_id
    FROM grant_aggregate_split_cases
    WHERE id = ${splitCaseId}::uuid
    FOR UPDATE
  `);
  void rows;
  await tx.execute(sql`
    SELECT target_grant.id
    FROM grants target_grant
    WHERE target_grant.id = (
      SELECT split_case.grant_id
      FROM grant_aggregate_split_cases split_case
      WHERE split_case.id = ${splitCaseId}::uuid
    )
    OR target_grant.id IN (
      SELECT child.id
      FROM grant_aggregate_split_children child
      WHERE child.split_case_id = ${splitCaseId}::uuid
    )
    ORDER BY target_grant.id
    FOR UPDATE
  `);
}

async function setShortTransactionTimeouts(tx: CunoteDbSession): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
}

function receiptMatchesReleaseItem(
  receipt: { status: string; evidence: Record<string, unknown> } | undefined,
  releaseId: string,
  promotionItemId: string,
): boolean {
  return receipt?.status === "passed"
    && receipt.evidence.releaseId === releaseId
    && receipt.evidence.promotionItemId === promotionItemId;
}

function blocked(
  code: string,
  message: string,
): AggregateSplitExposureGateResult {
  return {
    ready: false,
    phase: "blocked",
    firstBlocker: { code, message },
  };
}

export class AggregateSplitExposureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AggregateSplitExposureError";
  }
}

function exposureError(code: string, message: string): AggregateSplitExposureError {
  return new AggregateSplitExposureError(code, message);
}

function normalizeExposureFailure(error: unknown): AggregateSplitExposureFailure {
  if (error instanceof AggregateSplitExposureError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "aggregate_split_exposure_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
