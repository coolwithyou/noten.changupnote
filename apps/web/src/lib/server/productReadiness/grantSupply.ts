import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  canonicalConfirmationQuestionDraftJson,
  confirmationQuestionDraftPacketBody,
  parseConfirmationQuestionDraftPacket,
} from "@cunote/contracts/confirmation-question-draft";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import { assertIsolatedProductTestDb } from "../db/assertIsolatedProductTestDb";
import type { AnalysisLaunchPromotionDependencies } from "../analysis-lab/analysis-launch-promotion";
import * as schema from "../db/schema";
import { labReviewFilePath, readLabReview, validateReviewerEmail } from "../analysis-lab/review-store";
import { analysisLabDir, labRunFilePath, listLabRunSummaries, readLabRun } from "../analysis-lab/run-store";
import {
  classifyManualConfirmationCriterion,
  indexManualConfirmationEvaluationSelectors,
  resolveManualConfirmationEvaluationsForPreparation,
  type ManualConfirmationEvaluationSelector,
} from "../analysis-lab/manual-confirmation-evaluations";
import { assessPromotionReviewRisk } from "../analysis-lab/promotion-review-risk";
import { hasCompleteReviewCoverage } from "../analysis-lab/quality-report";
import { loadCurrentGrantEvidence, type CurrentGrantEvidence } from "../analysis-lab/deep-repair-promotion";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import { validatePromotionReleaseManifest } from "../analysis-serving/promotionReleaseContract";
import { assertReceiptBackedPromotionMutationAdmitted } from "../analysis-lab/promotion-mutation-admission";
import { releasePlanItemHasUnsafePendingCriteria } from "../analysis-lab/promotion-release";
import {
  createApprovedQuestionPreparationReleasePort,
  createQuestionPreparationAdapter,
  type ApprovedQuestionPreparationReleasePort,
} from "./questionPreparationAdapter";
import type { LabRun } from "../analysis-lab/lab-contract";
import {
  GRANT_NEXT_WORK_EXECUTION_SCHEMA,
  createGrantNextWorkSnapshot,
  executeGrantNextWork,
  type GrantNextWorkAdapter,
  type GrantNextWorkExecutionResult,
  type GrantNextWorkSnapshot,
} from "./grantNextWorkExecution";
import { loadCurrentGrantReadiness } from "./grantReadinessLoader";
import type { GrantNextWorkAction } from "./grantNextWork";
import { createDrizzleSourceRebindPort, createSourceRebindAdapter } from "./sourceRebindAdapter";
import { applySourceRebindRelease, loadApprovedSourceRebindRelease } from "./sourceRebindRelease";

export const GRANT_SUPPLY_PLAN_SCHEMA = "grant-supply-plan-v1" as const;

export interface GrantSupplyAsset {
  readonly runId: string;
  readonly sourceRevisionSha256: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string | null;
  readonly runSha256: string;
  readonly currentBinding: "verified" | "stale";
  readonly reviewStatus: "unreviewed" | "held" | "reviewed";
  readonly reviewSha256: string | null;
  readonly questionDemand: "unknown" | "none" | "present";
  readonly manualStatus: "absent" | "selection_required" | "active" | "withdrawn";
  readonly manualSelection: { readonly revision: number; readonly artifactSha256: string } | null;
  readonly draftPacketSha256: string | null;
}

export type GrantSupplyAssetInventory =
  | { readonly status: "checked"; readonly assets: readonly GrantSupplyAsset[] }
  | { readonly status: "unavailable"; readonly reason: string };

export interface GrantSupplyRunSelection {
  readonly grantId: string;
  readonly runId: string;
  readonly runSha256: string;
}

export interface GrantSupplyRunCandidate {
  readonly runId: string;
  readonly runSha256: string;
  readonly sourceRevisionSha256: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string | null;
  readonly currentBinding: GrantSupplyAsset["currentBinding"];
}

const MAX_REPORTED_RUN_CANDIDATES = 50;

interface DraftPacketBinding {
  readonly sha256: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string | null;
  readonly runArtifactSha256: string;
  readonly reviewArtifactSha256: string;
}

export type GrantSupplyStage =
  | "ready"
  | "source_review"
  | "review_existing_analysis"
  | "prepare_question_draft"
  | "review_question_draft"
  | "prepare_promotion_release"
  | "await_approved_model_run"
  | "await_approved_release"
  | "recheck_recruitment"
  | "asset_inventory_unavailable"
  | "asset_selection_conflict";

export interface GrantSupplyPlan {
  readonly schema: typeof GRANT_SUPPLY_PLAN_SCHEMA;
  readonly grantId: string;
  readonly evidenceSha256: string;
  readonly nextWorkAction: GrantNextWorkSnapshot["nextWork"]["action"];
  readonly stage: GrantSupplyStage;
  readonly reason: string;
  readonly owner: "ingestion" | "reviewer" | "release" | "model_authority" | "none";
  readonly requiredInput: string | null;
  readonly reusedRunId: string | null;
  readonly assetBinding: GrantSupplyAsset | null;
  readonly candidateRuns: readonly GrantSupplyRunCandidate[];
  readonly candidateRunCount: number;
  readonly candidatesTruncated: boolean;
  readonly modelCalls: 0;
}

export interface InactiveGrantSupplyAssessment {
  readonly schema: "grant-supply-inactive-v1";
  readonly grantId: string;
  readonly reason: "not_open_visible_in_current_kst_application_window";
}

export type GrantSupplyAssessment = GrantSupplyPlan | InactiveGrantSupplyAssessment;

export const GRANT_SUPPLY_WORK_SCHEMA = "grant-supply-work-v1" as const;
export type GrantSupplyDiscoverySource = "bizinfo" | "kstartup";
const MAX_GRANT_SUPPLY_DISCOVERY_TARGETS = 500;

export interface GrantSupplyWorkItem {
  readonly schema: typeof GRANT_SUPPLY_WORK_SCHEMA;
  readonly source: GrantSupplyDiscoverySource;
  readonly sourceId: string;
  readonly grantId: string | null;
  readonly discoveredBy: "collection_event" | "current_state";
  readonly eventRawSha256: string | null;
  readonly currentRawSha256: string | null;
  readonly status: "pending" | "complete" | "inactive" | "failed";
  readonly stage: GrantSupplyStage | "inactive" | "failed";
  readonly owner: GrantSupplyPlan["owner"];
  readonly assessment: GrantSupplyAssessment | null;
  readonly reason: string;
  readonly requiredInput: string | null;
  readonly target: {
    readonly grantId: string | null;
    readonly runId: string | null;
    readonly runSha256: string | null;
    readonly draftPacketSha256: string | null;
    readonly manualRevision: number | null;
    readonly manualArtifactSha256: string | null;
  };
}

export interface GrantSupplyDiscoveryReport {
  readonly schema: "grant-supply-discovery-v1";
  readonly source: GrantSupplyDiscoverySource;
  readonly selection: { readonly sourceIds: readonly string[] } | {
    readonly since: string;
    readonly until: string;
    readonly afterSourceId: string | null;
  };
  readonly items: readonly GrantSupplyWorkItem[];
  /** 다음 페이지는 같은 기간과 이 cursor로 다시 조회한다. null이면 기간을 모두 읽었다. */
  readonly nextCursor: string | null;
}

interface GrantSupplyEventCandidate {
  readonly sourceId: string;
  readonly rawHash: string;
  readonly collectedAt: Date;
}

interface GrantSupplyCurrentCandidate {
  readonly id: string;
  readonly sourceId: string;
  readonly currentRawSha256?: string | null;
}

type GrantSupplyDiscoveryTarget = Pick<
  GrantSupplyWorkItem,
  "source" | "sourceId" | "grantId" | "discoveredBy" | "eventRawSha256" | "currentRawSha256"
>;

/** 커밋된 event와 현행 grant 상태를 지정 source/기간 또는 exact source ID 안에서 재발견한다. */
export async function discoverGrantSupplyWork(input: {
  readonly db: CunoteDbSession;
  readonly source: GrantSupplyDiscoverySource;
  readonly sourceIds?: readonly string[];
  readonly since?: Date;
  readonly until?: Date;
  readonly afterSourceId?: string;
  readonly asOf?: Date;
  readonly runSelections?: readonly GrantSupplyRunSelection[];
  readonly manualConfirmationSelections?: readonly ManualConfirmationEvaluationSelector[];
}): Promise<GrantSupplyDiscoveryReport> {
  const exactIds = input.sourceIds === undefined ? null : [...new Set(input.sourceIds)].sort();
  const windowMode = input.since !== undefined || input.until !== undefined;
  if ((exactIds !== null) === windowMode) throw new Error("grant_supply_discovery_selection_required");
  if (exactIds && (exactIds.length > MAX_GRANT_SUPPLY_DISCOVERY_TARGETS
      || exactIds.some((id) => !id.trim()))) {
    throw new Error("grant_supply_discovery_source_id_limit_or_invalid");
  }
  if (windowMode && (!input.since || !input.until
      || !Number.isFinite(input.since.getTime())
      || !Number.isFinite(input.until.getTime())
      || input.until <= input.since
      || input.until.getTime() - input.since.getTime() > 31 * 24 * 60 * 60 * 1000)) {
    throw new Error("grant_supply_discovery_window_invalid");
  }
  if (input.afterSourceId !== undefined && (!windowMode || !input.afterSourceId.trim())) {
    throw new Error("grant_supply_discovery_cursor_invalid");
  }
  const selection = exactIds !== null
    ? { sourceIds: exactIds }
    : { since: input.since!.toISOString(), until: input.until!.toISOString(),
      afterSourceId: input.afterSourceId ?? null };
  if (exactIds?.length === 0) {
    return { schema: "grant-supply-discovery-v1", source: input.source, selection, items: [], nextCursor: null };
  }
  // 이벤트 수와 공고 수는 다르다. source ID 순서로 합집합을 페이지화해 같은
  // 공고의 여러 revision이 페이지 경계에서 중복되거나 누락되지 않게 한다.
  const page = windowMode ? await readGrantSupplyDiscoverySourceIdPage({
    db: input.db, source: input.source, since: input.since!, until: input.until!,
    ...(input.afterSourceId !== undefined ? { afterSourceId: input.afterSourceId } : {}),
  }) : { sourceIds: exactIds!, nextCursor: null };
  const pageIds = page.sourceIds;
  const events = windowMode && pageIds.length > 0
    ? await input.db.execute(sql`
      select distinct on (source_id) source_id as "sourceId", raw_hash as "rawHash",
        collected_at as "collectedAt"
      from grant_collection_events
      where source = ${input.source} and ${inArray(schema.grantCollectionEvents.sourceId, pageIds)}
        and collected_at >= ${input.since!.toISOString()}::timestamptz
        and collected_at < ${input.until!.toISOString()}::timestamptz
      order by source_id, collected_at desc, id desc
    `) as unknown as GrantSupplyEventCandidate[]
    : [];
  const current = await input.db.select({
    id: schema.grants.id,
    sourceId: schema.grants.sourceId,
    currentRawSha256: schema.grantRaw.rawHash,
  }).from(schema.grants).leftJoin(schema.grantRaw, and(
    eq(schema.grantRaw.source, schema.grants.source),
    eq(schema.grantRaw.sourceId, schema.grants.sourceId),
  )).where(and(
    eq(schema.grants.source, input.source),
    inArray(schema.grants.sourceId, pageIds),
  )).limit(MAX_GRANT_SUPPLY_DISCOVERY_TARGETS + 1);
  if (current.length > MAX_GRANT_SUPPLY_DISCOVERY_TARGETS) {
    throw new Error("grant_supply_discovery_grant_limit_exceeded");
  }
  const targets = buildGrantSupplyDiscoveryTargets({
    source: input.source,
    sourceIds: pageIds,
    events,
    current,
  });
  const items = await assessGrantSupplyDiscoveryTargets({
    targets,
    assess: async (grantId) => {
      const [assessment] = await assessPublishedGrantSupply({
        db: input.db,
        grantIds: [grantId],
        ...(input.asOf ? { asOf: input.asOf } : {}),
        ...(input.runSelections ? { runSelections: input.runSelections.filter(
          (selection) => selection.grantId === grantId,
        ) } : {}),
        ...(input.manualConfirmationSelections ? {
          manualConfirmationSelections: input.manualConfirmationSelections.filter(
            (selection) => selection.grantId === grantId,
          ),
        } : {}),
      });
      if (!assessment) throw new Error("current_assessment_missing");
      return assessment;
    },
  });
  return {
    schema: "grant-supply-discovery-v1",
    source: input.source,
    selection,
    items,
    nextCursor: page.nextCursor,
  };
}

/** 기간 이벤트와 status-only 갱신을 고유 source ID 순으로 합쳐 bounded page를 읽는다. */
export async function readGrantSupplyDiscoverySourceIdPage(input: {
  readonly db: CunoteDbSession;
  readonly source: GrantSupplyDiscoverySource;
  readonly since: Date;
  readonly until: Date;
  readonly afterSourceId?: string;
  readonly limit?: number;
}): Promise<{ readonly sourceIds: readonly string[]; readonly nextCursor: string | null }> {
  const limit = input.limit ?? MAX_GRANT_SUPPLY_DISCOVERY_TARGETS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_GRANT_SUPPLY_DISCOVERY_TARGETS) {
    throw new Error("grant_supply_discovery_page_limit_invalid");
  }
  const pageRows = await input.db.execute(sql`
    select source_id as "sourceId" from (
      select source_id from grant_collection_events
      where source = ${input.source} and collected_at >= ${input.since.toISOString()}::timestamptz
        and collected_at < ${input.until.toISOString()}::timestamptz
      union
      select source_id from grants
      where source = ${input.source} and updated_at >= ${input.since.toISOString()}::timestamptz
        and updated_at < ${input.until.toISOString()}::timestamptz
    ) as candidates
    where source_id > ${input.afterSourceId ?? ""}
    order by source_id
    limit ${limit + 1}
  `) as unknown as { sourceId: string }[];
  const sourceIds = pageRows.slice(0, limit).map((row) => row.sourceId);
  return { sourceIds, nextCursor: pageRows.length > limit ? sourceIds.at(-1)! : null };
}

/** 한 공고 판정 실패가 나머지 후보와 이미 준비된 단계를 가리지 않는다. */
export async function assessGrantSupplyDiscoveryTargets(input: {
  readonly targets: readonly GrantSupplyDiscoveryTarget[];
  readonly assess: (grantId: string) => Promise<GrantSupplyAssessment>;
}): Promise<GrantSupplyWorkItem[]> {
  const items: GrantSupplyWorkItem[] = [];
  for (let offset = 0; offset < input.targets.length; offset += 8) {
    items.push(...await Promise.all(input.targets.slice(offset, offset + 8)
      .map(async (target): Promise<GrantSupplyWorkItem> => {
      if (!target.grantId) return grantSupplyFailedWork(target,
        target.discoveredBy === "collection_event" ? "collection_event_grant_missing" : "current_grant_missing");
      try {
        const assessment = await input.assess(target.grantId);
        const asset = assessment.schema === GRANT_SUPPLY_PLAN_SCHEMA ? assessment.assetBinding : null;
        const status = assessment.schema === "grant-supply-inactive-v1" ? "inactive"
          : assessment.stage === "ready" ? "complete" : "pending";
        return {
          schema: GRANT_SUPPLY_WORK_SCHEMA,
          ...target,
          status,
          stage: assessment.schema === GRANT_SUPPLY_PLAN_SCHEMA ? assessment.stage : "inactive",
          owner: assessment.schema === GRANT_SUPPLY_PLAN_SCHEMA ? assessment.owner : "none",
          assessment,
          reason: assessment.reason,
          requiredInput: assessment.schema === GRANT_SUPPLY_PLAN_SCHEMA ? assessment.requiredInput : null,
          target: {
            grantId: target.grantId,
            runId: asset?.runId ?? null,
            runSha256: asset?.runSha256 ?? null,
            draftPacketSha256: asset?.draftPacketSha256 ?? null,
            manualRevision: asset?.manualSelection?.revision ?? null,
            manualArtifactSha256: asset?.manualSelection?.artifactSha256 ?? null,
          },
        };
      } catch (error) {
        if (isSharedGrantSupplyDiscoveryFailure(error)) throw error;
        return grantSupplyFailedWork(target, error instanceof Error ? error.message : String(error));
      }
      })));
  }
  return items;
}

/** 접속·권한·schema·서버 장애는 대상별 보류로 위장하면 다음 페이지까지 거짓 보고한다. */
export function isSharedGrantSupplyDiscoveryFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : null;
  if (code && (/^(08|28|53)/u.test(code) || code.startsWith("57P")
      || code === "58030" || code === "42P01" || code === "42703")) return true;
  return "cause" in error && isSharedGrantSupplyDiscoveryFailure(error.cause);
}

/** 중복 이벤트는 한 source ID로 합치고, event 없는 현재 상태 갱신도 보존한다. */
export function buildGrantSupplyDiscoveryTargets(input: {
  readonly source: GrantSupplyDiscoverySource;
  readonly sourceIds: readonly string[] | null;
  readonly events: readonly GrantSupplyEventCandidate[];
  readonly current: readonly GrantSupplyCurrentCandidate[];
}): GrantSupplyDiscoveryTarget[] {
  const latestEvent = new Map<string, GrantSupplyEventCandidate>();
  for (const event of input.events) {
    const previous = latestEvent.get(event.sourceId);
    if (!previous || event.collectedAt > previous.collectedAt) latestEvent.set(event.sourceId, event);
  }
  const currentBySourceId = new Map(input.current.map((grant) => [grant.sourceId, grant]));
  const ids = new Set(input.sourceIds ?? []);
  for (const sourceId of latestEvent.keys()) ids.add(sourceId);
  for (const grant of input.current) ids.add(grant.sourceId);
  return [...ids].sort().map((sourceId) => ({
    source: input.source,
    sourceId,
    grantId: currentBySourceId.get(sourceId)?.id ?? null,
    discoveredBy: latestEvent.has(sourceId) ? "collection_event" : "current_state",
    eventRawSha256: latestEvent.get(sourceId)?.rawHash ?? null,
    currentRawSha256: currentBySourceId.get(sourceId)?.currentRawSha256 ?? null,
  }));
}

function grantSupplyFailedWork(
  candidate: GrantSupplyDiscoveryTarget,
  reason: string,
): GrantSupplyWorkItem {
  return {
    schema: GRANT_SUPPLY_WORK_SCHEMA,
    ...candidate,
    status: "failed",
    stage: "failed",
    owner: "none",
    assessment: null,
    reason,
    requiredInput: "current_grant_and_supply_evidence",
    target: {
      grantId: candidate.grantId,
      runId: null,
      runSha256: null,
      draftPacketSha256: null,
      manualRevision: null,
      manualArtifactSha256: null,
    },
  };
}

/** 일반 수집 완료 뒤 candidate ID만으로 현재 자산·다음 작업을 다시 조회한다. 쓰기는 하지 않는다. */
export async function assessPublishedGrantSupply(input: {
  readonly db: CunoteDbSession;
  readonly grantIds: readonly string[];
  readonly asOf?: Date;
  readonly manualConfirmationSelections?: readonly ManualConfirmationEvaluationSelector[];
  readonly runSelections?: readonly GrantSupplyRunSelection[];
}): Promise<GrantSupplyAssessment[]> {
  const grantIds = [...new Set(input.grantIds)].sort();
  if (grantIds.length === 0) return [];
  if (grantIds.length > 500) throw new Error("grant_supply_candidate_limit_exceeded");
  const manualSelections = indexManualConfirmationEvaluationSelectors(
    input.manualConfirmationSelections ?? [], grantIds,
  );
  const runSelections = indexGrantSupplyRunSelections(input.runSelections ?? [], grantIds);
  const [grants, rows] = await Promise.all([
    input.db.select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
    }).from(schema.grants).where(inArray(schema.grants.id, grantIds)),
    loadCurrentGrantReadiness({
      db: input.db,
      grantIds,
      limit: grantIds.length,
      ...(input.asOf ? { asOf: input.asOf } : {}),
    }),
  ]);
  const grantsById = new Map(grants.map((grant) => [grant.id, grant]));
  const rowsById = new Map(rows.map((row) => [row.grantId, row]));
  return Promise.all(grantIds.map(async (grantId): Promise<GrantSupplyAssessment> => {
    const grant = grantsById.get(grantId);
    if (!grant) throw new Error("grant_supply_candidate_disappeared");
    const row = rowsById.get(grantId);
    if (!row) return {
      schema: "grant-supply-inactive-v1",
      grantId,
      reason: "not_open_visible_in_current_kst_application_window",
    };
    const snapshot = createGrantNextWorkSnapshot({
      grantId,
      readinessInput: row.input,
      sourceChangeImpact: row.sourceChangeImpact ?? null,
    });
    const assets = snapshot.nextWork.action === "condition_analysis"
      || snapshot.nextWork.action === "condition_review"
      ? await loadStoredGrantSupplyAssets({
        grantId,
        source: grant.source,
        sourceId: grant.sourceId,
        sourceRevisionSha256: row.input.source.revisionSha256 ?? "",
        ...(manualSelections.get(grantId) ? { manualSelection: manualSelections.get(grantId)! } : {}),
      })
      : { status: "checked" as const, assets: [] };
    return planGrantSupply({
      snapshot, inventory: assets,
      ...(runSelections.get(grantId) ? { runSelection: runSelections.get(grantId)! } : {}),
    });
  }));
}

/** 커밋된 수집 공고 ID에서 current evidence를 다시 읽는다. 수집 트랜잭션과 분리한다. */
export async function loadCurrentGrantSupplySnapshot(input: {
  readonly db: CunoteDbSession;
  readonly grantId: string;
  readonly asOf?: Date;
}): Promise<GrantNextWorkSnapshot | null> {
  const rows = await loadCurrentGrantReadiness({
    db: input.db,
    grantIds: [input.grantId],
    limit: 1,
    ...(input.asOf ? { asOf: input.asOf } : {}),
  });
  const row = rows[0];
  return row ? createGrantNextWorkSnapshot({
    grantId: row.grantId,
    readinessInput: row.input,
    sourceChangeImpact: row.sourceChangeImpact ?? null,
  }) : null;
}

/** 승인된 adapter만 전달받아 수집 시점의 evidence를 CAS로 재확인하고 후속 준비도를 재평가한다. */
export async function executeApprovedGrantSupply(input: {
  readonly db: CunoteDb;
  readonly grantId: string;
  readonly expectedEvidenceSha256: string;
  readonly adapters?: ReadonlyMap<GrantNextWorkAction, GrantNextWorkAdapter>;
  readonly approvedRelease?: {
    readonly releaseId: string;
    readonly manifestSha256: string;
    readonly executedBy: string;
  };
  readonly asOf?: Date;
  readonly manualConfirmationSelection?: ManualConfirmationEvaluationSelector;
  readonly runSelection?: GrantSupplyRunSelection;
  /** 전용 PostgreSQL 통합검사용. 기존 자산 조회·formal verifier를 실제 코드로 유지한다. */
  readonly isolatedAnalysisLaunch?: AnalysisLaunchPromotionDependencies;
}): Promise<GrantNextWorkExecutionResult> {
  if (input.isolatedAnalysisLaunch) await assertIsolatedProductTestDb(input.db);
  if (input.manualConfirmationSelection
      && input.manualConfirmationSelection.grantId !== input.grantId) {
    throw new Error("grant_supply_manual_selection_grant_mismatch");
  }
  if (input.runSelection) {
    indexGrantSupplyRunSelections([input.runSelection], [input.grantId]);
  }
  const [grant] = await input.db.select({
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
  }).from(schema.grants).where(inArray(schema.grants.id, [input.grantId])).limit(1);
  if (!grant) throw new Error("grant_supply_current_grant_unavailable");
  const currentSnapshot = await loadCurrentGrantSupplySnapshot(input);
  if (!currentSnapshot) throw new Error("grant_supply_current_grant_unavailable");
  const inventory = currentSnapshot.nextWork.action === "condition_analysis"
    || currentSnapshot.nextWork.action === "condition_review"
    ? await loadStoredGrantSupplyAssets({
      grantId: input.grantId,
      source: grant.source,
      sourceId: grant.sourceId,
      sourceRevisionSha256: currentSnapshot.readinessInput.source.revisionSha256 ?? "",
      ...(input.isolatedAnalysisLaunch?.loadCurrentGrantEvidence ? {
        loadCurrentEvidence: input.isolatedAnalysisLaunch.loadCurrentGrantEvidence,
      } : {}),
      ...(input.manualConfirmationSelection ? { manualSelection: input.manualConfirmationSelection } : {}),
    })
    : { status: "checked" as const, assets: [] };
  const plan = planGrantSupply({
    snapshot: currentSnapshot, inventory,
    ...(input.runSelection ? { runSelection: input.runSelection } : {}),
  });
  if (plan.evidenceSha256 !== input.expectedEvidenceSha256 && input.approvedRelease
      && plan.stage === "ready" && currentSnapshot.nextWork.action === "reuse_ready") {
    const rebound = await recoverAppliedSourceRebindSupply({
      db: input.db,
      grantId: input.grantId,
      expectedEvidenceSha256: input.expectedEvidenceSha256,
      afterEvidenceSha256: plan.evidenceSha256,
      approvedRelease: input.approvedRelease,
    });
    if (rebound) return rebound;
    const recovered = await recoverAppliedGrantSupply({
      db: input.db,
      grantId: input.grantId,
      expectedEvidenceSha256: input.expectedEvidenceSha256,
      afterEvidenceSha256: plan.evidenceSha256,
      approvedRelease: input.approvedRelease,
      ...(input.isolatedAnalysisLaunch ? { isolatedAnalysisLaunch: input.isolatedAnalysisLaunch } : {}),
    });
    if (recovered) return recovered;
  }
  const canApplyBoundAsset = Boolean(
    input.approvedRelease && plan.assetBinding
    && (plan.stage === "prepare_promotion_release" || plan.stage === "await_approved_release"
      || plan.stage === "review_existing_analysis")
    && plan.nextWorkAction === "condition_analysis",
  );
  const gated = gateGrantSupplyExecutionPlan(plan, input.expectedEvidenceSha256);
  if (gated && !canApplyBoundAsset) return gated;
  const adapters = new Map(input.adapters ?? []);
  if (input.approvedRelease) {
    const port = createApprovedQuestionPreparationReleasePort(input.db, input.isolatedAnalysisLaunch);
    if (canApplyBoundAsset) {
      adapters.set(plan.nextWorkAction, createApprovedAnalysisPromotionAdapter({
        ...input.approvedRelease,
        asset: plan.assetBinding!,
        supplyPlanEvidenceSha256: plan.evidenceSha256,
        port,
      }));
    } else if (plan.nextWorkAction === "question_preparation") {
      adapters.set("question_preparation", createQuestionPreparationAdapter({
        releaseId: input.approvedRelease.releaseId,
        expectedManifestSha256: input.approvedRelease.manifestSha256,
        executedBy: input.approvedRelease.executedBy,
        port,
      }));
    } else if (plan.nextWorkAction === "source_rebind") {
      adapters.set("source_rebind", createSourceRebindAdapter({
        releaseId: input.approvedRelease.releaseId,
        expectedManifestSha256: input.approvedRelease.manifestSha256,
        executedBy: input.approvedRelease.executedBy,
        port: createDrizzleSourceRebindPort({ db: input.db }),
      }));
    }
  }
  const executed = await executeGrantNextWork({
    grantId: input.grantId,
    expectedEvidenceSha256: currentSnapshot.evidenceSha256,
    adapters,
    approvedAnalysisReuse: canApplyBoundAsset,
    loadSnapshot: async (grantId) => {
      const snapshot = await loadCurrentGrantSupplySnapshot({
        db: input.db,
        grantId,
        ...(input.asOf ? { asOf: input.asOf } : {}),
      });
      if (!snapshot) throw new Error("grant_supply_current_grant_unavailable");
      return snapshot;
    },
  });
  const result = plan.evidenceSha256 === currentSnapshot.evidenceSha256
    ? executed : { ...executed, beforeEvidenceSha256: plan.evidenceSha256 };
  if (result.status === "completed" && result.nextAction !== "reuse_ready") {
    return { ...result, status: "partial", reason: "approved_release_applied_but_serving_not_ready" };
  }
  return plan.stage === "review_existing_analysis" && result.status === "completed"
    ? { ...result, reason: "formal_independent_review_release_applied_and_serving_ready" }
    : result;
}

/** 응답 유실 후 source successor와 현행 serving이 일치할 때만 쓰기 없이 성공을 복원한다. */
async function recoverAppliedSourceRebindSupply(input: {
  readonly db: CunoteDb;
  readonly grantId: string;
  readonly expectedEvidenceSha256: string;
  readonly afterEvidenceSha256: string;
  readonly approvedRelease: { readonly releaseId: string; readonly manifestSha256: string; readonly executedBy: string };
}): Promise<GrantNextWorkExecutionResult | null> {
  const [release] = await input.db.select({ id: schema.analysisLabPromotionReleases.id })
    .from(schema.analysisLabPromotionReleases)
    .where(and(
      eq(schema.analysisLabPromotionReleases.releaseId, input.approvedRelease.releaseId),
      eq(schema.analysisLabPromotionReleases.manifestSha256, input.approvedRelease.manifestSha256),
    )).limit(1);
  if (!release) return null;
  const [item] = await input.db.select({
    status: schema.analysisLabSourceRebindItems.status,
    afterSnapshot: schema.analysisLabSourceRebindItems.afterSnapshot,
  })
    .from(schema.analysisLabSourceRebindItems)
    .where(and(
      eq(schema.analysisLabSourceRebindItems.releaseDbId, release.id),
      eq(schema.analysisLabSourceRebindItems.grantId, input.grantId),
    )).limit(1);
  if (item?.status !== "applied") return null;
  if (item.afterSnapshot?.beforeEvidenceSha256 !== input.expectedEvidenceSha256) {
    throw new Error("grant_supply_rebind_recovery_before_evidence_mismatch");
  }
  const approved = await loadApprovedSourceRebindRelease({
    db: input.db,
    releaseId: input.approvedRelease.releaseId,
    expectedManifestSha256: input.approvedRelease.manifestSha256,
    grantId: input.grantId,
  });
  if (approved.status !== "active" || !approved.approvedBy
      || approved.approvedBy === input.approvedRelease.executedBy) {
    throw new Error("grant_supply_rebind_recovery_approval_invalid");
  }
  const applied = await applySourceRebindRelease({
    db: input.db,
    manifest: approved.manifest,
    executedBy: input.approvedRelease.executedBy,
  });
  if (!applied.replayed) throw new Error("grant_supply_rebind_recovery_replayed_write_invalid");
  return {
    schema: GRANT_NEXT_WORK_EXECUTION_SCHEMA,
    grantId: input.grantId,
    action: "reuse_ready",
    status: "already_complete",
    beforeEvidenceSha256: input.expectedEvidenceSha256,
    afterEvidenceSha256: input.afterEvidenceSha256,
    nextAction: "reuse_ready",
    reason: "source_rebind_applied_and_serving_verified",
    adapterReceiptSha256: sha256Canonical({
      releaseId: input.approvedRelease.releaseId,
      manifestSha256: input.approvedRelease.manifestSha256,
      grantId: input.grantId,
      servingStateSha256: applied.servingStateSha256,
    }),
    modelCalls: 0,
    externalWrites: 0,
  };
}

/** 응답 유실 뒤에는 적용 item과 현행 serving이 모두 일치할 때만 쓰기 없이 성공을 재구성한다. */
async function recoverAppliedGrantSupply(input: {
  readonly db: CunoteDb;
  readonly grantId: string;
  readonly expectedEvidenceSha256: string;
  readonly afterEvidenceSha256: string;
  readonly approvedRelease: { readonly releaseId: string; readonly manifestSha256: string; readonly executedBy: string };
  readonly isolatedAnalysisLaunch?: AnalysisLaunchPromotionDependencies;
}): Promise<GrantNextWorkExecutionResult | null> {
  if (!/^[a-f0-9]{64}$/u.test(input.expectedEvidenceSha256)) return null;
  const [release] = await input.db.select({ id: schema.analysisLabPromotionReleases.id })
    .from(schema.analysisLabPromotionReleases)
    .where(and(
      eq(schema.analysisLabPromotionReleases.releaseId, input.approvedRelease.releaseId),
      eq(schema.analysisLabPromotionReleases.manifestSha256, input.approvedRelease.manifestSha256),
    )).limit(1);
  if (!release) return null;
  const [item] = await input.db.select({
    status: schema.analysisLabPromotionItems.status,
    supplyPlanEvidenceSha256: schema.analysisLabPromotionItems.supplyPlanEvidenceSha256,
  })
    .from(schema.analysisLabPromotionItems)
    .where(and(
      eq(schema.analysisLabPromotionItems.releaseDbId, release.id),
      eq(schema.analysisLabPromotionItems.grantId, input.grantId),
    )).limit(1);
  if (item?.status !== "applied") return null;
  if (item.supplyPlanEvidenceSha256 !== input.expectedEvidenceSha256) {
    throw new Error("grant_supply_promotion_recovery_before_evidence_mismatch");
  }
  const { applyApprovedPromotionCanary } = await import("../analysis-lab/promote-cli");
  const applied = await applyApprovedPromotionCanary({
    db: input.db,
    releaseId: input.approvedRelease.releaseId,
    grantId: input.grantId,
    expectedManifestSha256: input.approvedRelease.manifestSha256,
    actor: input.approvedRelease.executedBy,
    supplyPlanEvidenceSha256: input.expectedEvidenceSha256,
    ...(input.isolatedAnalysisLaunch ? { isolatedAnalysisLaunch: input.isolatedAnalysisLaunch } : {}),
  });
  if (!applied.replayed || applied.externalWrites !== 0) {
    throw new Error("grant_supply_promotion_recovery_replayed_write_invalid");
  }
  return {
    schema: GRANT_NEXT_WORK_EXECUTION_SCHEMA,
    grantId: input.grantId,
    action: "reuse_ready",
    status: "already_complete",
    beforeEvidenceSha256: input.expectedEvidenceSha256,
    afterEvidenceSha256: input.afterEvidenceSha256,
    nextAction: "reuse_ready",
    reason: "approved_release_applied_and_serving_verified",
    adapterReceiptSha256: sha256Canonical({
      releaseId: input.approvedRelease.releaseId,
      manifestSha256: input.approvedRelease.manifestSha256,
      grantId: input.grantId,
      supplyPlanEvidenceSha256: input.expectedEvidenceSha256,
      afterStateSha256: applied.afterStateSha256,
    }),
    modelCalls: 0,
    externalWrites: 0,
  };
}

/** 자산을 다시 읽은 계획과 exact SHA가 같을 때만 기존 DB adapter로 위임한다. */
export function gateGrantSupplyExecutionPlan(
  plan: GrantSupplyPlan,
  expectedEvidenceSha256: string,
): GrantNextWorkExecutionResult | null {
  if (plan.evidenceSha256 !== expectedEvidenceSha256) {
    throw new Error("grant_supply_plan_drift");
  }
  if (!plan.assetBinding && plan.stage !== "asset_inventory_unavailable"
      && plan.stage !== "asset_selection_conflict") return null;
  return Object.freeze({
    schema: GRANT_NEXT_WORK_EXECUTION_SCHEMA,
    grantId: plan.grantId,
    action: plan.nextWorkAction,
    status: "blocked",
    beforeEvidenceSha256: plan.evidenceSha256,
    afterEvidenceSha256: null,
    nextAction: plan.nextWorkAction,
    reason: plan.assetBinding
      ? "bound_asset_review_or_release_execution_not_connected"
      : plan.stage,
    adapterReceiptSha256: null,
    modelCalls: 0,
    externalWrites: 0,
  });
}

/** 미발행 reviewed 자산은 승인된 exact promotion canary로만 재사용한다. */
export function createApprovedAnalysisPromotionAdapter(input: {
  readonly releaseId: string;
  readonly manifestSha256: string;
  readonly executedBy: string;
  readonly asset: GrantSupplyAsset;
  readonly supplyPlanEvidenceSha256: string;
  readonly port: ApprovedQuestionPreparationReleasePort;
  readonly loadRun?: (grantId: string, runId: string) => Promise<LabRun | null>;
}): GrantNextWorkAdapter {
  return {
    action: "condition_analysis",
    async execute(execution) {
      const snapshot = execution.snapshot;
      if (snapshot.nextWork.action !== "condition_analysis"
          || snapshot.readinessInput.analysis.status !== "missing"
          || snapshot.evidenceSha256 !== execution.expectedEvidenceSha256
          || input.asset.currentBinding !== "verified"
          || input.asset.reviewStatus === "held"
          || input.asset.manualStatus === "selection_required"
          || (input.asset.questionDemand === "present" && input.asset.manualStatus !== "active")) {
        throw new Error("grant_supply_analysis_asset_not_publishable");
      }
      const release = await input.port.loadApprovedRelease({
        releaseId: input.releaseId,
        expectedManifestSha256: input.manifestSha256,
        grantId: execution.grantId,
      });
      if (release.approvedBy === input.executedBy || !release.approvedBy
          || !/^[a-f0-9]{64}$/u.test(release.approvalArtifactSha256)) {
        throw new Error("grant_supply_release_actor_or_approval_invalid");
      }
      const manifest = validatePromotionReleaseManifest(release.manifest);
      assertReceiptBackedPromotionMutationAdmitted(manifest);
      const item = manifest.plans.find((candidate) => candidate.grantId === execution.grantId);
      const source = manifest.sourceArtifacts.find((candidate) => candidate.grantId === execution.grantId);
      const evidence = source?.localLabEvidence;
      const formalReview = evidence?.reviewMethod === "analysis_launch_independent_review"
        || evidence?.reviewMethod === "deep_repair_receipt";
      const attachmentSha = evidence?.analysisLaunch?.attachmentManifestSha256
        ?? evidence?.deepRepair?.attachmentManifestSha256 ?? null;
      const manual = source?.manualConfirmationEvaluationSelection;
      if (formalReview && item) {
        const run = await (input.loadRun ?? readLabRun)(execution.grantId, input.asset.runId);
        if (!run || run.grantId !== execution.grantId || run.runId !== input.asset.runId
            || run.inputSha256 !== input.asset.inputSha256
            || (run.attachmentManifestSha256 ?? null) !== input.asset.attachmentManifestSha256) {
          throw new Error("grant_supply_formal_run_binding_mismatch");
        }
        const requiredQuestionIndexes = item.promotionPlan.criterionIndexByPosition.filter((index) => {
          const criterion = run.criteria[index];
          if (!criterion) throw new Error("grant_supply_formal_criterion_missing");
          const demand = classifyManualConfirmationCriterion(criterion);
          if (demand === "admin_source_review") throw new Error("grant_supply_formal_criterion_review_required");
          return demand === "user_confirmation";
        });
        const coveredQuestionIndexes = item.promotionPlan.questions
          .filter((question) => question.evaluationContractVersion === "confirmation-evaluation-v2")
          .map((question) => question.criterionIndex);
        if (requiredQuestionIndexes.length !== coveredQuestionIndexes.length
            || requiredQuestionIndexes.some((index) => !coveredQuestionIndexes.includes(index))) {
          throw new Error("grant_supply_formal_question_demand_uncovered");
        }
      }
      if (release.status !== "approved" && release.status !== "canary_running"
          && release.status !== "partial_failed" && release.status !== "canary_passed"
          || manifest.releaseId !== input.releaseId
          || manifest.manifestSha256 !== input.manifestSha256
          || release.manifestSha256 !== input.manifestSha256
          || release.releasePlanSha256 !== manifest.releasePlanSha256
          || !manifest.canaryGrantIds.includes(execution.grantId)
          || !item || !source || !evidence
          || (input.asset.reviewStatus === "unreviewed" && !formalReview)
          || (input.asset.reviewStatus === "reviewed" && evidence.reviewMethod !== "human")
          || source.runId !== input.asset.runId
          || source.runSha256 !== input.asset.runSha256
          || (source.reviewSha256 ?? null) !== input.asset.reviewSha256
          || source.sourceRevisionSha256 !== input.asset.sourceRevisionSha256
          || source.sourceRevisionSha256 !== snapshot.readinessInput.source.revisionSha256
          || evidence.inputSha256 !== input.asset.inputSha256
          || attachmentSha !== input.asset.attachmentManifestSha256
          || item.promotionPlan.runId !== input.asset.runId
          || item.pendingCount !== 0
          || releasePlanItemHasUnsafePendingCriteria(item)
          || item.promotionPlan.conversion.error
          || (item.promotionPlan.questions.length > 0 && (
            input.asset.manualStatus !== "active"
            || !manual || manual.intent !== "active"
            || manual.revision !== input.asset.manualSelection?.revision
            || manual.artifactSha256 !== input.asset.manualSelection?.artifactSha256
          ))
          || (input.asset.questionDemand === "present" && item.promotionPlan.questions.length === 0)
          || (input.asset.questionDemand === "none" && item.promotionPlan.questions.length !== 0)) {
        throw new Error("grant_supply_analysis_release_binding_mismatch");
      }
      const applied = await input.port.applyApprovedCanary({
        release,
        manifest,
        item,
        grantId: execution.grantId,
        expectedEvidenceSha256: execution.expectedEvidenceSha256,
        supplyPlanEvidenceSha256: input.supplyPlanEvidenceSha256,
        executedBy: input.executedBy,
      });
      if (!/^[a-f0-9]{64}$/u.test(applied.afterStateSha256)
          || applied.externalWrites !== (applied.replayed ? 0 : 1)) {
        throw new Error("grant_supply_analysis_apply_result_invalid");
      }
      return {
        action: "condition_analysis",
        receiptSha256: sha256Canonical({
          grantId: execution.grantId,
          beforeEvidenceSha256: execution.expectedEvidenceSha256,
          supplyPlanEvidenceSha256: input.supplyPlanEvidenceSha256,
          releaseId: input.releaseId,
          manifestSha256: input.manifestSha256,
          runSha256: input.asset.runSha256,
          afterStateSha256: applied.afterStateSha256,
          replayed: applied.replayed,
        }),
        modelCalls: 0,
        externalWrites: applied.externalWrites,
      };
    },
  };
}

/**
 * 로컬 구독 실험실의 현행 revision 자산만 조사한다. 목록 존재는 발행 승인이 아니며,
 * release는 exact selector/receipt/current DB를 자체 경계에서 다시 검증해야 한다.
 */
export async function loadStoredGrantSupplyAssets(input: {
  readonly grantId: string;
  readonly source: string;
  readonly sourceId: string;
  readonly sourceRevisionSha256: string;
  readonly manualSelection?: ManualConfirmationEvaluationSelector;
  readonly loadCurrentEvidence?: (run: LabRun) => Promise<CurrentGrantEvidence>;
}): Promise<GrantSupplyAssetInventory> {
  // Cloud ingestion에는 로컬 구독 실험실이 배포되지 않는다. 조회 불가를 부재로 간주하지 않는다.
  let root: string;
  try {
    root = analysisLabDir();
    await access(root);
  } catch (error) {
    return { status: "unavailable", reason: `local_asset_root_unavailable:${(error as NodeJS.ErrnoException).code ?? "unknown"}` };
  }
  let summaries: Awaited<ReturnType<typeof listLabRunSummaries>>;
  let drafts: Map<string, DraftPacketBinding[]>;
  try {
    summaries = await listLabRunSummaries(input.source, input.sourceId);
    drafts = await loadDraftPacketShaByRun(input.grantId, input.sourceRevisionSha256);
  } catch (error) {
    return { status: "unavailable", reason: `local_asset_inventory_unavailable:${error instanceof Error ? error.message : String(error)}` };
  }
  const assets: GrantSupplyAsset[] = [];
  if (input.manualSelection && !summaries.some((summary) => summary.runId === input.manualSelection!.runId)) {
    return { status: "unavailable", reason: "manual_selection_run_not_found" };
  }
  for (const summary of summaries) {
    if (summary.outcome !== "publishable") continue;
    let run: Awaited<ReturnType<typeof readLabRun>>;
    try {
      run = await readLabRun(input.grantId, summary.runId);
    } catch (error) {
      return { status: "unavailable", reason: `local_run_unavailable:${error instanceof Error ? error.message : String(error)}` };
    }
    if (
      !run
    ) return { status: "unavailable", reason: "listed_run_disappeared" };
    if (
      run.source !== input.source
      || run.sourceId !== input.sourceId
      || run.sourceRevisionSha256 !== input.sourceRevisionSha256
    ) continue;
    let current: CurrentGrantEvidence;
    let review: Awaited<ReturnType<typeof readLabReview>>;
    let runArtifactSha256: string;
    let reviewArtifactSha256: string | null;
    let manual: Awaited<ReturnType<typeof resolveManualConfirmationEvaluationsForPreparation>> = null;
    let manualStatus: GrantSupplyAsset["manualStatus"] = "absent";
    try {
      current = await (input.loadCurrentEvidence ?? ((value) => loadCurrentGrantEvidence(value, new Date())))(run);
      review = await readLabReview(input.grantId, run.runId);
      const runBytes = await readFile(labRunFilePath(run.source, run.sourceId, run.runId));
      if (sha256Canonical(JSON.parse(runBytes.toString("utf8"))) !== sha256Canonical(run)) {
        throw new Error("run_changed_during_inventory");
      }
      runArtifactSha256 = createHash("sha256").update(runBytes).digest("hex");
      const reviewBytes = review
        ? await readFile(labReviewFilePath(run.source, run.sourceId, run.runId))
        : null;
      if (reviewBytes && sha256Canonical(JSON.parse(reviewBytes.toString("utf8"))) !== sha256Canonical(review)) {
        throw new Error("review_changed_during_inventory");
      }
      reviewArtifactSha256 = reviewBytes
        ? createHash("sha256").update(reviewBytes).digest("hex")
        : null;
      const selector = input.manualSelection?.runId === run.runId ? input.manualSelection : undefined;
      try {
        manual = await resolveManualConfirmationEvaluationsForPreparation(run, selector);
        if (manual) manualStatus = manual.selection.intent === "withdraw_all" ? "withdrawn" : "active";
      } catch (error) {
        if (!selector && error instanceof Error && error.message.includes("revision을 명시적으로 선택")) {
          manualStatus = "selection_required";
        } else {
          throw error;
        }
      }
    } catch (error) {
      return { status: "unavailable", reason: `local_asset_validation_unavailable:${error instanceof Error ? error.message : String(error)}` };
    }
    let reviewStatus: GrantSupplyAsset["reviewStatus"];
    let questionDemand: GrantSupplyAsset["questionDemand"];
    try {
      const reviewRisk = review ? assessPromotionReviewRisk({ run, review }) : null;
      const reviewComplete = Boolean(review
        && validateReviewerEmail(review.reviewerEmail).ok
        && review.grantId === run.grantId
        && review.runId === run.runId
        && hasCompleteReviewCoverage(run, review)
        && review.criterionReviews.every((item) =>
          item.verdict === "correct" || item.verdict === "needs_edit"
          || item.verdict === "wrong" || item.verdict === "unsure")
        && review.axisReviews.every((item) =>
          item.verdict === "confirmed_absent" || item.verdict === "missed_condition")
        && reviewRisk?.disposition !== "blocked");
      reviewStatus = !review ? "unreviewed" : reviewComplete ? "reviewed" : "held";
      const correct = new Set(review?.criterionReviews.filter((item) => item.verdict === "correct")
        .map((item) => item.criterionIndex) ?? []);
      const reviewedCriteria = run.criteria.filter((_, index) => correct.has(index));
      questionDemand = !reviewComplete ? "unknown"
        : reviewedCriteria.some((criterion) => classifyManualConfirmationCriterion(criterion) === "admin_source_review")
          ? "unknown"
          : reviewedCriteria.some((criterion) => classifyManualConfirmationCriterion(criterion) === "user_confirmation")
            ? "present" : "none";
    } catch (error) {
      return { status: "unavailable", reason: `review_or_criterion_invalid:${error instanceof Error ? error.message : String(error)}` };
    }
    const matchingDrafts = (drafts.get(run.runId) ?? []).filter((draft) =>
      draft.inputSha256 === run.inputSha256
      && draft.attachmentManifestSha256 === (run.attachmentManifestSha256 ?? null)
      && draft.runArtifactSha256 === runArtifactSha256
      && draft.reviewArtifactSha256 === reviewArtifactSha256);
    if (matchingDrafts.length > 1) {
      return { status: "unavailable", reason: "draft_packet_selection_conflict" };
    }
    assets.push({
      runId: run.runId,
      sourceRevisionSha256: input.sourceRevisionSha256,
      inputSha256: run.inputSha256,
      attachmentManifestSha256: run.attachmentManifestSha256 ?? null,
      runSha256: runArtifactSha256,
      currentBinding: current.sourceRevisionSha256 === input.sourceRevisionSha256
        && run.inputSha256 === current.inputSha256
        && run.attachmentManifestSha256 === current.attachmentManifestSha256
        ? "verified" : "stale",
      reviewStatus,
      reviewSha256: reviewArtifactSha256,
      questionDemand,
      manualStatus,
      manualSelection: manual ? {
        revision: manual.selection.revision,
        artifactSha256: manual.selection.artifactSha256,
      } : null,
      draftPacketSha256: matchingDrafts[0]?.sha256 ?? null,
    });
  }
  if (input.manualSelection && !assets.some((asset) => asset.runId === input.manualSelection!.runId)) {
    return { status: "unavailable", reason: "manual_selection_not_current_publishable_run" };
  }
  return { status: "checked", assets };
}

/** 현행 자산이 있으면 모델 대기 전에 재사용 단계로 보내며, 사람 결정을 생성하지 않는다. */
export function planGrantSupply(input: {
  readonly snapshot: GrantNextWorkSnapshot;
  readonly inventory: GrantSupplyAssetInventory;
  readonly runSelection?: GrantSupplyRunSelection;
}): GrantSupplyPlan {
  const { snapshot } = input;
  if (input.runSelection) {
    indexGrantSupplyRunSelections([input.runSelection], [snapshot.grantId]);
  }
  const sourceRevision = snapshot.readinessInput.source.revisionSha256;
  const assets = input.inventory.status === "checked"
    ? input.inventory.assets.filter((asset) => asset.sourceRevisionSha256 === sourceRevision)
    : [];
  const sortedAssets = [...assets].sort((left, right) => left.runId.localeCompare(right.runId));
  const candidateRuns = sortedAssets.slice(0, MAX_REPORTED_RUN_CANDIDATES).map((asset) => ({
    runId: asset.runId,
    runSha256: asset.runSha256,
    sourceRevisionSha256: asset.sourceRevisionSha256,
    inputSha256: asset.inputSha256,
    attachmentManifestSha256: asset.attachmentManifestSha256,
    currentBinding: asset.currentBinding,
  }));
  const selected = input.runSelection
    ? assets.find((asset) => asset.runId === input.runSelection!.runId
      && asset.runSha256 === input.runSelection!.runSha256) ?? null
    : assets.length === 1 ? assets[0]! : null;
  const selectionMismatch = Boolean(input.runSelection && !selected);
  const action = snapshot.nextWork.action;
  const base = {
    schema: GRANT_SUPPLY_PLAN_SCHEMA,
    grantId: snapshot.grantId,
    evidenceSha256: input.inventory.status === "checked" && assets.length === 0 && !input.runSelection
      ? snapshot.evidenceSha256
      : sha256Canonical({
        snapshot: snapshot.evidenceSha256,
        inventory: input.inventory,
        runSelection: input.runSelection ?? null,
      }),
    nextWorkAction: action,
    reusedRunId: selected?.runId ?? null,
    assetBinding: selected,
    candidateRuns,
    candidateRunCount: assets.length,
    candidatesTruncated: assets.length > MAX_REPORTED_RUN_CANDIDATES,
    modelCalls: 0 as const,
  };
  const step = (
    stage: GrantSupplyStage,
    owner: GrantSupplyPlan["owner"],
    reason: string,
    requiredInput: string | null,
  ): GrantSupplyPlan => Object.freeze({ ...base, stage, owner, reason, requiredInput });

  if (input.inventory.status === "unavailable") {
    return step("asset_inventory_unavailable", "reviewer", input.inventory.reason, "local_asset_inventory");
  }
  if (selectionMismatch || (assets.length > 1 && !input.runSelection)) {
    return step("asset_selection_conflict", "reviewer",
      selectionMismatch ? "selected_run_not_in_current_inventory_or_sha_mismatch"
        : "multiple_current_analysis_assets",
      "exact_run_id_and_sha256");
  }
  if (action === "reuse_ready") return step("ready", "none", "current_question_serving_verified", null);
  if (action === "source_recovery" || action === "source_change_review" ||
      action === "coverage_review" || action === "condition_review" && !selected) {
    return step("source_review", "reviewer", action, "current_source_and_criterion_evidence");
  }
  if (action === "recruitment_refresh") {
    return step("recheck_recruitment", "ingestion", "recruitment_state_owned_by_ingestion", "current_application_window");
  }
  if (action === "source_rebind") {
    return step("await_approved_release", "release", "source_rebind_requires_exact_approved_release", "release_id_and_manifest_sha256");
  }
  if (action === "condition_analysis" && !selected) {
    return step("await_approved_model_run", "model_authority", "no_current_publishable_analysis_asset", "approved_launch_manifest");
  }
  if (selected?.currentBinding === "stale") {
    return step("source_review", "reviewer", "analysis_input_or_attachment_drift", "current_input_and_attachment");
  }
  if (selected && selected.reviewStatus !== "reviewed") {
    return step("review_existing_analysis", "reviewer", "current_analysis_requires_human_review", "review_decision");
  }
  if (selected?.questionDemand === "unknown") {
    return step("source_review", "reviewer", "question_demand_not_verified", "reviewed_criterion_resolution");
  }
  if (selected?.manualStatus === "selection_required") {
    return step("review_question_draft", "reviewer", "manual_revision_requires_exact_selection", "manual_revision_and_artifact_sha256");
  }
  if (selected?.questionDemand === "present" && selected.manualStatus !== "active") {
    if (selected.manualStatus === "withdrawn") {
      return step("review_question_draft", "reviewer", "withdrawn_manual_questions_require_review", "reviewed_question_demand_or_withdrawal_decision");
    }
    if (!selected.draftPacketSha256) {
      return step("prepare_question_draft", "reviewer", "reviewed_analysis_has_no_question_draft", "offline_draft_packet");
    }
    return step("review_question_draft", "reviewer", "draft_requires_human_scope_key_and_wording_decision", "bound_manual_question_input");
  }
  if (action === "condition_analysis" || action === "condition_review") {
    return step("prepare_promotion_release", "release", "current_reviewed_asset_requires_promotion", "exact_release_plan_and_approval");
  }
  return step("await_approved_release", "release", "reviewed_questions_require_exact_approved_release", "release_id_and_manifest_sha256");
}

function indexGrantSupplyRunSelections(
  selections: readonly GrantSupplyRunSelection[],
  expectedGrantIds: readonly string[],
): ReadonlyMap<string, GrantSupplyRunSelection> {
  const expected = new Set(expectedGrantIds);
  const indexed = new Map<string, GrantSupplyRunSelection>();
  for (const selection of selections) {
    if (!expected.has(selection.grantId)) throw new Error("grant_supply_run_selection_grant_mismatch");
    if (!/^run-[0-9TZ.\-]{10,40}(?:-[a-f0-9]{4,8})?$/u.test(selection.runId)
        || !/^[a-f0-9]{64}$/u.test(selection.runSha256)) {
      throw new Error("grant_supply_run_selection_invalid");
    }
    if (indexed.has(selection.grantId)) throw new Error("grant_supply_run_selection_duplicate");
    indexed.set(selection.grantId, selection);
  }
  return indexed;
}

async function loadDraftPacketShaByRun(
  grantId: string,
  sourceRevisionSha256: string,
): Promise<Map<string, DraftPacketBinding[]>> {
  const directory = join(analysisLabDir(), "confirmation-question-drafts");
  let filenames: string[];
  try {
    filenames = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  if (filenames.length > 10_000) throw new Error("grant_supply_draft_inventory_limit_exceeded");
  const result = new Map<string, DraftPacketBinding[]>();
  for (const filename of filenames) {
    if (!/^[a-f0-9]{64}\.confirmation-question-draft\.json$/.test(filename)) continue;
    const bytes = await readFile(join(directory, filename));
    const raw = JSON.parse(bytes.toString("utf8")) as { source?: { grantId?: string } };
    if (raw.source?.grantId !== grantId) continue;
    const packet = parseConfirmationQuestionDraftPacket(raw);
    const contentSha256 = createHash("sha256")
      .update(canonicalConfirmationQuestionDraftJson(confirmationQuestionDraftPacketBody(packet)))
      .digest("hex");
    if (packet.contentSha256 !== contentSha256 || filename !== `${contentSha256}.confirmation-question-draft.json`) {
      throw new Error("grant_supply_draft_integrity_invalid");
    }
    if (packet.source.sourceRevisionSha256 === sourceRevisionSha256) {
      const current = result.get(packet.source.runId) ?? [];
      current.push({
        sha256: contentSha256,
        inputSha256: packet.source.inputSha256,
        attachmentManifestSha256: packet.source.attachmentManifestSha256,
        runArtifactSha256: packet.source.runArtifactSha256,
        reviewArtifactSha256: packet.source.reviewArtifactSha256,
      });
      result.set(packet.source.runId, current);
    }
  }
  return result;
}
