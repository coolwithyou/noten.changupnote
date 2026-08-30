import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { LabRun } from "@/lib/server/analysis-lab/lab-contract";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { prepareDeepAnalysisInput } from "../deep-analysis/prepareInput";
import {
  isKStartupRecruitmentClosedPayload,
} from "../repositories/activeGrantFilter";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import {
  createDeepRepairExperimentPlan,
  replayDeepRepairExperiment,
  type DeepRepairExperimentPlan,
} from "./deep-repair-experiment";
import {
  validateDeepRepairLiveReceipt,
  type ValidatedDeepRepairLiveReceipt,
} from "./deep-repair-live-receipt";
import {
  planGrantPromotion,
  type GrantPromotionPlan,
  type PromotionSource,
} from "./promote";
import {
  canonicalJson,
  hashFile,
  VERIFIED_DEEP_REPAIR_SOURCE_SCHEMA,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionSourceArtifact,
} from "./promotion-release";
import type { PromotionCandidate } from "./promotion-candidates";
import { analysisLabDir, findMonorepoRoot } from "./run-store";
import { isPublishableLabRun } from "./run-outcome";

export const DEEP_REPAIR_PROMOTION_READINESS_SCHEMA =
  "deep-repair-promotion-readiness-v1" as const;

export type DeepRepairPromotionDisposition =
  | "ready"
  | "conditional"
  | "admin_review"
  | "held";

export interface DeepRepairPromotionReadiness {
  schema: typeof DEEP_REPAIR_PROMOTION_READINESS_SCHEMA;
  disposition: DeepRepairPromotionDisposition;
  reasons: string[];
  unresolvedAxes: Array<{
    dimension: string;
    status: "ambiguous" | "input_missing";
  }>;
  sourceRevisionSha256: string;
  inputSha256: string;
  attachmentManifestSha256: string;
  receiptSha256: string;
}

export interface DeepRepairPromotionCandidate extends PromotionCandidate {
  readiness: DeepRepairPromotionReadiness;
}

export interface DeepRepairPromotionCohort {
  seriesId: string;
  proposalSha256: string;
  planSha256: string;
  manifestSha256: string;
  candidates: DeepRepairPromotionCandidate[];
  adminReview: DeepRepairPromotionReadinessItem[];
  held: DeepRepairPromotionReadinessItem[];
}

export interface DeepRepairPromotionReadinessItem {
  sequence: number;
  grantId: string;
  runId: string;
  readiness: DeepRepairPromotionReadiness;
}

export interface CurrentGrantEvidence {
  sourceRevisionSha256: string;
  inputSha256: string;
  attachmentManifestSha256: string;
  status: string;
  servingState: string;
  applicationOpen: boolean;
  hasDeepAnalysisRun: boolean;
  hasPromotionItem: boolean;
  confirmedDuplicate: boolean;
}

export interface DeepRepairPromotionDependencies {
  now?: Date;
  loadCurrentGrantEvidence?: (run: LabRun) => Promise<CurrentGrantEvidence>;
}

interface SeriesMarker {
  seriesId: string;
  proposalPath: string;
  proposalSha256: string;
  planSha256: string;
  planArtifactSha256: string;
  manifestSha256: string;
}

interface LoadedTarget {
  sequence: number;
  run: LabRun;
  receipt: ValidatedDeepRepairLiveReceipt;
  runArtifactSha256: string;
  evaluatorReceiptSha256: string;
  observationsSha256: string;
}

/**
 * exact grant cohort 하나를 receipt-backed promotion 후보로 변환한다.
 *
 * 외부 interface는 seriesId와 exact grantId 집합뿐이다. plan/receipt/evaluator/run 결속,
 * current source/input/attachment, 공개·접수 상태, 중복 검사는 구현 안에 숨긴다.
 * 통계 실험 verdict는 재현 검증만 하고 출시 disposition에는 사용하지 않는다.
 */
export async function loadDeepRepairPromotionCohort(input: {
  seriesId: string;
  grantIds: readonly string[];
  dependencies?: DeepRepairPromotionDependencies;
}): Promise<DeepRepairPromotionCohort> {
  const seriesId = safeSeriesId(input.seriesId);
  const requestedGrantIds = [...new Set(input.grantIds.map((value) => value.trim()).filter(Boolean))]
    .sort();
  if (requestedGrantIds.length === 0) throw new Error("exact grantIds가 1건 이상 필요합니다.");
  if (requestedGrantIds.length !== input.grantIds.length) {
    throw new Error("exact grantIds에 빈 값 또는 중복이 있습니다.");
  }

  const root = findMonorepoRoot();
  const experimentsDir = join(analysisLabDir(), "experiments");
  const marker = await readSeriesMarker(experimentsDir, seriesId);
  const { plan, proposalSha256 } = await readSealedPlan(root, experimentsDir, marker);
  const targetByGrantId = new Map(plan.sequence.map((target) => [target.grantId, target]));
  const missing = requestedGrantIds.filter((grantId) => !targetByGrantId.has(grantId));
  if (missing.length > 0) throw new Error(`series plan에 없는 grantId: ${missing.join(", ")}`);

  const receipts = selectDeepRepairReceiptChain(
    await readPlanReceipts(experimentsDir, plan.planSha256),
  );
  const receiptBySequence = new Map<number, ValidatedDeepRepairLiveReceipt>();
  for (const receipt of receipts) {
    if (receiptBySequence.has(receipt.target.sequence)) {
      throw new Error(`sequence terminal receipt 중복: ${receipt.target.sequence}`);
    }
    receiptBySequence.set(receipt.target.sequence, receipt);
  }
  assertDeepRepairReceiptChain([...receiptBySequence.values()]);

  const loadCurrent = input.dependencies?.loadCurrentGrantEvidence
    ?? ((run: LabRun) => loadCurrentGrantEvidence(run, input.dependencies?.now ?? new Date()));
  const candidates: DeepRepairPromotionCandidate[] = [];
  const adminReview: DeepRepairPromotionReadinessItem[] = [];
  const held: DeepRepairPromotionReadinessItem[] = [];

  for (const grantId of requestedGrantIds) {
    const target = targetByGrantId.get(grantId)!;
    const receipt = receiptBySequence.get(target.sequence);
    if (!receipt) throw new Error(`terminal receipt가 없는 exact target: ${grantId}`);
    const loaded = await loadAndVerifyTarget({
      root,
      experimentsDir,
      plan,
      receipt,
    });
    const current = await loadCurrent(loaded.run);
    let readiness = classifyDeepRepairPromotionReadiness(loaded.run, current, receipt.receiptSha256);
    let promotionPlan: GrantPromotionPlan | null = null;
    if (readiness.disposition === "ready" || readiness.disposition === "conditional") {
      promotionPlan = planGrantPromotion({
        run: {
          ...loaded.run,
          sourceRevisionSha256: current.sourceRevisionSha256,
        },
        origin: "deep_repair",
        deepRepairReceiptSha256: receipt.receiptSha256,
        sidecar: null,
      });
      readiness = guardDeepRepairPromotionPlan(readiness, promotionPlan);
    }
    const item: DeepRepairPromotionReadinessItem = {
      sequence: loaded.sequence,
      grantId,
      runId: loaded.run.runId,
      readiness,
    };
    if (readiness.disposition === "admin_review") {
      adminReview.push(item);
      continue;
    }
    if (readiness.disposition === "held") {
      held.push(item);
      continue;
    }

    const source: PromotionSource = { run: loaded.run, origin: "deep_repair" };
    if (!promotionPlan) throw new Error(`promotion plan을 구성하지 못했습니다: ${grantId}`);
    const provenance = plan.manifest.provenance;
    if (
      provenance.status !== "complete"
      || !provenance.gitSha
      || !provenance.packageRuntimeSha256
      || !provenance.validatorVersion
    ) {
      throw new Error(`formal execution provenance가 완전하지 않습니다: ${grantId}`);
    }
    const sourceArtifact: PromotionSourceArtifact = {
      grantId,
      runId: loaded.run.runId,
      runSha256: loaded.runArtifactSha256,
      overlaySha256: null,
      confirmationsSha256: null,
      sourceRevisionSha256: current.sourceRevisionSha256,
      localLabEvidence: {
        schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
        transport: "claude-cli",
        model: loaded.run.model,
        promptVersion: loaded.run.promptVersion,
        inputSha256: loaded.run.inputSha256,
        reviewMethod: "deep_repair_receipt",
        deepRepair: {
          schema: VERIFIED_DEEP_REPAIR_SOURCE_SCHEMA,
          seriesId,
          sequence: loaded.sequence,
          proposalSha256,
          planSha256: plan.planSha256,
          planArtifactSha256: marker.planArtifactSha256,
          manifestSha256: plan.manifestSha256,
          receiptSha256: receipt.receiptSha256,
          observationsSha256: loaded.observationsSha256,
          evaluatorReceiptSha256: loaded.evaluatorReceiptSha256,
          attachmentManifestSha256: loaded.run.attachmentManifestSha256!,
          sourceRevisionSha256: current.sourceRevisionSha256,
          executionGitSha: provenance.gitSha,
          packageRuntimeSha256: provenance.packageRuntimeSha256,
          validatorVersion: provenance.validatorVersion,
        },
      },
    };
    candidates.push({ source, plan: promotionPlan, sourceArtifact, readiness });
  }

  return {
    seriesId,
    proposalSha256,
    planSha256: plan.planSha256,
    manifestSha256: plan.manifestSha256,
    candidates: candidates.sort((left, right) => left.plan.grantId.localeCompare(right.plan.grantId)),
    adminReview: adminReview.sort((left, right) => left.sequence - right.sequence),
    held: held.sort((left, right) => left.sequence - right.sequence),
  };
}

export function assertDeepRepairReceiptChain(
  receipts: readonly Pick<
    ValidatedDeepRepairLiveReceipt,
    "target" | "parentReceiptSha256" | "receiptSha256"
  >[],
): void {
  const ordered = [...receipts].sort((left, right) => left.target.sequence - right.target.sequence);
  let parentReceiptSha256: string | null = null;
  ordered.forEach((receipt, index) => {
    if (receipt.target.sequence !== index) {
      throw new Error(`terminal receipt chain sequence가 연속적이지 않습니다: ${receipt.target.sequence}`);
    }
    if (receipt.parentReceiptSha256 !== parentReceiptSha256) {
      throw new Error(`terminal receipt parent가 다릅니다: sequence ${receipt.target.sequence}`);
    }
    parentReceiptSha256 = receipt.receiptSha256;
  });
}

/**
 * 재시도 receipt를 삭제하지 않고, 후속 sequence가 실제 parent로 채택한 유일한 최장 chain만 고른다.
 * 같은 최종 sequence까지 둘 이상의 branch가 이어졌다면 임의 선택하지 않고 fail-closed한다.
 */
export function selectDeepRepairReceiptChain<
  T extends Pick<
    ValidatedDeepRepairLiveReceipt,
    "target" | "parentReceiptSha256" | "receiptSha256"
  >,
>(receipts: readonly T[]): T[] {
  if (receipts.length === 0) return [];
  const bySha = new Map<string, T>();
  for (const receipt of receipts) {
    if (bySha.has(receipt.receiptSha256)) {
      throw new Error(`terminal receipt SHA 중복: ${receipt.receiptSha256}`);
    }
    bySha.set(receipt.receiptSha256, receipt);
  }
  const referencedParents = new Set(receipts.flatMap((receipt) =>
    receipt.parentReceiptSha256 ? [receipt.parentReceiptSha256] : []));
  const leaves = receipts.filter((receipt) => !referencedParents.has(receipt.receiptSha256));
  const chains = leaves.map((leaf) => {
    const reversed: T[] = [];
    const visited = new Set<string>();
    let current: T | undefined = leaf;
    while (current) {
      if (visited.has(current.receiptSha256)) {
        throw new Error(`terminal receipt parent cycle: ${current.receiptSha256}`);
      }
      visited.add(current.receiptSha256);
      reversed.push(current);
      if (current.parentReceiptSha256 === null) break;
      current = bySha.get(current.parentReceiptSha256);
      if (!current) {
        throw new Error(`terminal receipt parent artifact 누락: ${leaf.receiptSha256}`);
      }
    }
    const chain = reversed.reverse();
    assertDeepRepairReceiptChain(chain);
    return chain;
  });
  const maxSequence = Math.max(...chains.map((chain) => chain.at(-1)!.target.sequence));
  const longest = chains.filter((chain) => chain.at(-1)!.target.sequence === maxSequence);
  if (longest.length !== 1) {
    throw new Error(`최종 sequence ${maxSequence}의 terminal receipt chain이 중복입니다.`);
  }
  return longest[0]!;
}

/** release prepare 이후 apply/verify가 같은 source를 다시 검증하는 단일 verifier. */
export async function verifyDeepRepairPromotionSourceArtifact(
  artifact: PromotionSourceArtifact,
  dependencies: DeepRepairPromotionDependencies = {},
): Promise<{ ok: boolean; changed: string[] }> {
  try {
    return await verifyDeepRepairPromotionSourceArtifactDetailed(artifact, dependencies);
  } catch {
    return { ok: false, changed: ["deep_repair_artifact_unavailable"] };
  }
}

/**
 * immutable gate용 verifier. 실제 drift는 결과로 반환하고, 파일/DB 재구성 실패는
 * 호출자에게 throw해 일시적 장애가 drift artifact로 봉인되지 않게 한다.
 */
export async function verifyDeepRepairPromotionSourceArtifactDetailed(
  artifact: PromotionSourceArtifact,
  dependencies: DeepRepairPromotionDependencies = {},
): Promise<{ ok: boolean; changed: string[] }> {
  const deepRepair = artifact.localLabEvidence?.deepRepair;
  if (
    artifact.localLabEvidence?.reviewMethod !== "deep_repair_receipt"
    || !deepRepair
  ) {
    return { ok: false, changed: ["deep_repair_evidence_missing"] };
  }
  const changed: string[] = [];
  const root = findMonorepoRoot();
  const experimentsDir = join(analysisLabDir(), "experiments");
  const marker = await readSeriesMarker(experimentsDir, deepRepair.seriesId);
  const { plan, proposalSha256 } = await readSealedPlan(root, experimentsDir, marker);
  const receiptPath = join(experimentsDir, "receipts", `${deepRepair.receiptSha256}.json`);
  const receipt = validateDeepRepairLiveReceipt(JSON.parse(await readFile(receiptPath, "utf8")));
  const loaded = await loadAndVerifyTarget({ root, experimentsDir, plan, receipt });
  const loadCurrent = dependencies.loadCurrentGrantEvidence
    ?? ((run: LabRun) => loadCurrentGrantEvidence(run, dependencies.now ?? new Date()));
  const current = await loadCurrent(loaded.run);
  const releaseCurrent = {
    ...current,
    // release prepare가 만든 item 자체만 중복으로 오인하지 않는다. 별도 deep run이나
    // confirmed dedup member는 prepare 이후 생겼더라도 drift로 차단해야 한다.
    hasPromotionItem: false,
  };
  let readiness = classifyDeepRepairPromotionReadiness(
    loaded.run,
    releaseCurrent,
    receipt.receiptSha256,
  );
  if (readiness.disposition === "ready" || readiness.disposition === "conditional") {
    readiness = guardDeepRepairPromotionPlan(readiness, planGrantPromotion({
      run: {
        ...loaded.run,
        sourceRevisionSha256: current.sourceRevisionSha256,
      },
      origin: "deep_repair",
      deepRepairReceiptSha256: receipt.receiptSha256,
      sidecar: null,
    }));
  }
  if (readiness.disposition === "admin_review" || readiness.disposition === "held") {
    changed.push(`run_${readiness.disposition}`);
  }
  const expected: Array<[string, unknown, unknown]> = [
    ["grant_id", artifact.grantId, loaded.run.grantId],
    ["run_id", artifact.runId, loaded.run.runId],
    ["run", artifact.runSha256, loaded.runArtifactSha256],
    ["input", artifact.localLabEvidence.inputSha256, current.inputSha256],
    ["attachment", deepRepair.attachmentManifestSha256, current.attachmentManifestSha256],
    ["source_revision", deepRepair.sourceRevisionSha256, current.sourceRevisionSha256],
    ["artifact_source_revision", artifact.sourceRevisionSha256, current.sourceRevisionSha256],
    ["proposal", deepRepair.proposalSha256, proposalSha256],
    ["plan", deepRepair.planSha256, plan.planSha256],
    ["plan_artifact", deepRepair.planArtifactSha256, marker.planArtifactSha256],
    ["manifest", deepRepair.manifestSha256, plan.manifestSha256],
    ["receipt", deepRepair.receiptSha256, receipt.receiptSha256],
    ["observations", deepRepair.observationsSha256, loaded.observationsSha256],
    ["evaluator", deepRepair.evaluatorReceiptSha256, loaded.evaluatorReceiptSha256],
    ["sequence", deepRepair.sequence, loaded.sequence],
    ["execution_git", deepRepair.executionGitSha, plan.manifest.provenance.gitSha],
    ["package_runtime", deepRepair.packageRuntimeSha256, plan.manifest.provenance.packageRuntimeSha256],
    ["validator", deepRepair.validatorVersion, plan.manifest.provenance.validatorVersion],
    ["model", artifact.localLabEvidence.model, loaded.run.model],
    ["prompt_version", artifact.localLabEvidence.promptVersion, loaded.run.promptVersion],
  ];
  for (const [name, expectedValue, actualValue] of expected) {
    if (expectedValue !== actualValue) changed.push(name);
  }
  return { ok: changed.length === 0, changed: [...new Set(changed)] };
}

export function classifyDeepRepairPromotionReadiness(
  run: LabRun,
  current: CurrentGrantEvidence,
  receiptSha256: string,
): DeepRepairPromotionReadiness {
  const reasons: string[] = [];
  let disposition: DeepRepairPromotionDisposition;
  if (!isPublishableLabRun(run) || run.matchingReadiness === "deferred") {
    disposition = "held";
    reasons.push("run_not_publishable");
  } else if ((run.primaryRepairProvenance?.blockingNewIssueAfterRepairCount ?? 0) > 0) {
    disposition = "admin_review";
    reasons.push("blocking_new_issue_after_repair");
  } else if (run.matchingReadiness === "ready") {
    disposition = "ready";
  } else if (run.matchingReadiness === "conditional") {
    disposition = "conditional";
  } else {
    disposition = "held";
    reasons.push("matching_readiness_missing");
  }

  if (run.criteria.length === 0) reasons.push("empty_criteria");
  if (run.inputSha256 !== current.inputSha256) reasons.push("input_drift");
  if (run.attachmentManifestSha256 !== current.attachmentManifestSha256) {
    reasons.push("attachment_drift");
  }
  if (current.status !== "open") reasons.push("grant_not_open");
  if (current.servingState !== "visible") reasons.push("grant_not_visible");
  if (!current.applicationOpen) reasons.push("application_not_open");
  if (current.hasPromotionItem) reasons.push("promotion_duplicate");
  if (current.hasDeepAnalysisRun) reasons.push("deep_analysis_duplicate");
  if (current.confirmedDuplicate) reasons.push("confirmed_dedup_member");
  if (reasons.some((reason) => (
    reason !== "blocking_new_issue_after_repair"
    && reason !== "matching_readiness_missing"
    && reason !== "run_not_publishable"
  ))) {
    disposition = "held";
  }

  const unresolvedAxes = run.axisAssessments.flatMap((axis) => (
    axis.status === "ambiguous" || axis.status === "input_missing"
      ? [{ dimension: axis.dimension, status: axis.status }]
      : []
  ));
  return {
    schema: DEEP_REPAIR_PROMOTION_READINESS_SCHEMA,
    disposition,
    reasons: [...new Set(reasons)].sort(),
    unresolvedAxes,
    sourceRevisionSha256: current.sourceRevisionSha256,
    inputSha256: current.inputSha256,
    attachmentManifestSha256: current.attachmentManifestSha256,
    receiptSha256,
  };
}

/** 원문 상태가 publishable이어도 실제 matcher 입력이 비면 release 후보가 될 수 없다. */
export function guardDeepRepairPromotionPlan(
  readiness: DeepRepairPromotionReadiness,
  plan: Pick<
    GrantPromotionPlan,
    "criteria" | "conversion" | "scopeRejectedCriterionIndexes"
  >,
): DeepRepairPromotionReadiness {
  if (readiness.disposition !== "ready" && readiness.disposition !== "conditional") {
    return readiness;
  }
  const reasons = [...readiness.reasons];
  if (plan.conversion.error) reasons.push("promotion_conversion_error");
  if (plan.conversion.dropped > (plan.scopeRejectedCriterionIndexes?.length ?? 0)) {
    reasons.push("promotion_conversion_drop");
  }
  if (plan.criteria.length === 0) reasons.push("empty_promotion_plan");
  if (reasons.length === readiness.reasons.length) return readiness;
  return {
    ...readiness,
    disposition: "held",
    reasons: [...new Set(reasons)].sort(),
  };
}

async function readSeriesMarker(experimentsDir: string, seriesId: string): Promise<SeriesMarker> {
  const path = join(experimentsDir, "series", `${seriesId}.json`);
  const value = record(JSON.parse(await readFile(path, "utf8")), "series marker");
  if (value.schema !== "deep-repair-series-proposal-v1" || value.seriesId !== seriesId) {
    throw new Error("series marker schema/id가 일치하지 않습니다.");
  }
  return {
    seriesId,
    proposalPath: text(value.proposalPath, "series.proposalPath"),
    proposalSha256: sha(value.proposalSha256, "series.proposalSha256"),
    planSha256: sha(value.planSha256, "series.planSha256"),
    planArtifactSha256: sha(value.planArtifactSha256, "series.planArtifactSha256"),
    manifestSha256: sha(value.manifestSha256, "series.manifestSha256"),
  };
}

async function readSealedPlan(
  root: string,
  experimentsDir: string,
  marker: SeriesMarker,
): Promise<{ plan: DeepRepairExperimentPlan; proposalSha256: string }> {
  const proposalPath = safePathInside(root, resolve(root, marker.proposalPath));
  if (await hashFile(proposalPath) !== marker.proposalSha256) {
    throw new Error("proposal raw SHA가 series marker와 다릅니다.");
  }
  const proposal = record(JSON.parse(await readFile(proposalPath, "utf8")), "proposal");
  const proposalPlan = record(proposal.plan, "proposal.plan");
  if (
    proposal.policy === undefined
    || proposalPlan.planSha256 !== marker.planSha256
    || proposalPlan.rawSha256 !== marker.planArtifactSha256
    || proposalPlan.manifestSha256 !== marker.manifestSha256
  ) {
    throw new Error("proposal/series plan binding이 다릅니다.");
  }
  const planPath = join(experimentsDir, "plans", `${marker.planSha256}.json`);
  if (await hashFile(planPath) !== marker.planArtifactSha256) {
    throw new Error("plan artifact raw SHA가 marker와 다릅니다.");
  }
  const parsed = JSON.parse(await readFile(planPath, "utf8")) as DeepRepairExperimentPlan;
  const plan = createDeepRepairExperimentPlan(parsed.manifest);
  if (
    canonicalJson(plan) !== canonicalJson(parsed)
    || plan.planSha256 !== marker.planSha256
    || plan.manifestSha256 !== marker.manifestSha256
  ) {
    throw new Error("plan canonical/hash binding이 다릅니다.");
  }
  return { plan, proposalSha256: marker.proposalSha256 };
}

async function readPlanReceipts(
  experimentsDir: string,
  planSha256: string,
): Promise<ValidatedDeepRepairLiveReceipt[]> {
  const receiptsDir = join(experimentsDir, "receipts");
  const files = await readdir(receiptsDir);
  const receipts: ValidatedDeepRepairLiveReceipt[] = [];
  for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort()) {
    let receipt: ValidatedDeepRepairLiveReceipt;
    try {
      receipt = validateDeepRepairLiveReceipt(
        JSON.parse(await readFile(join(receiptsDir, file), "utf8")),
      );
    } catch {
      continue;
    }
    if (receipt.planSha256 !== planSha256) continue;
    if (basename(file, ".json") !== receipt.receiptSha256) {
      throw new Error(`receipt content address가 다릅니다: ${file}`);
    }
    receipts.push(receipt);
  }
  return receipts;
}

async function loadAndVerifyTarget(input: {
  root: string;
  experimentsDir: string;
  plan: DeepRepairExperimentPlan;
  receipt: ValidatedDeepRepairLiveReceipt;
}): Promise<LoadedTarget> {
  const target = input.plan.sequence[input.receipt.target.sequence];
  if (
    !target
    || input.receipt.planSha256 !== input.plan.planSha256
    || input.receipt.manifestSha256 !== input.plan.manifestSha256
    || target.grantId !== input.receipt.target.grantId
    || target.waveId !== input.receipt.target.waveId
    || input.receipt.noticeOutcome === "failed"
    || !input.receipt.runArtifactPath
    || !input.receipt.runArtifactSha256
    || !input.receipt.observationsSha256
    || !input.receipt.evaluatorReceiptSha256
  ) {
    throw new Error(`terminal receipt target binding이 불완전합니다: ${input.receipt.target.grantId}`);
  }

  const runPath = safePathInside(input.root, resolve(input.root, input.receipt.runArtifactPath));
  const runBytes = await readFile(runPath);
  if (sha256(runBytes) !== input.receipt.runArtifactSha256) {
    throw new Error(`run artifact SHA 불일치: ${target.grantId}`);
  }
  const run = JSON.parse(runBytes.toString("utf8")) as LabRun;
  if (
    run.grantId !== target.grantId
    || run.inputSha256 !== target.inputSha256
    || run.attachmentManifestSha256 !== target.attachmentManifestSha256
    || run.model !== input.plan.manifest.policy.model
    || run.promptVersion !== input.plan.manifest.policy.promptVersion
    || run.transport !== input.plan.manifest.policy.transport
  ) {
    throw new Error(`run/plan exact binding이 다릅니다: ${target.grantId}`);
  }

  const observationsPath = join(
    input.experimentsDir,
    "observations",
    `${input.receipt.observationsSha256}.json`,
  );
  const observations = JSON.parse(await readFile(observationsPath, "utf8")) as unknown;
  const observationRecord = record(observations, "observations");
  if (!Array.isArray(observationRecord.notices) || observationRecord.notices.length === 0) {
    throw new Error(`observations notices가 없습니다: ${target.grantId}`);
  }
  const lastNotice = record(observationRecord.notices.at(-1), "observations.lastNotice");
  if (
    lastNotice.grantId !== target.grantId
    || lastNotice.runId !== run.runId
    || lastNotice.runArtifactPath !== input.receipt.runArtifactPath
    || lastNotice.runArtifactSha256 !== input.receipt.runArtifactSha256
    || lastNotice.noticeOutcome !== input.receipt.noticeOutcome
  ) {
    throw new Error(`live receipt가 마지막 observation과 다릅니다: ${target.grantId}`);
  }
  const replayed = replayDeepRepairExperiment(input.plan, observations);
  const evaluatorPath = join(
    input.experimentsDir,
    "evaluator-receipts",
    `${input.receipt.evaluatorReceiptSha256}.json`,
  );
  const storedEvaluator = JSON.parse(await readFile(evaluatorPath, "utf8")) as unknown;
  if (
    replayed.observationSha256 !== input.receipt.observationsSha256
    || replayed.receiptSha256 !== input.receipt.evaluatorReceiptSha256
    || replayed.observedCount !== input.receipt.observedCount
    || replayed.verdict !== input.receipt.gateVerdict
    || canonicalJson(replayed) !== canonicalJson(storedEvaluator)
  ) {
    throw new Error(`evaluator deterministic replay가 다릅니다: ${target.grantId}`);
  }
  return {
    sequence: target.sequence,
    run,
    receipt: input.receipt,
    runArtifactSha256: input.receipt.runArtifactSha256,
    evaluatorReceiptSha256: input.receipt.evaluatorReceiptSha256,
    observationsSha256: input.receipt.observationsSha256,
  };
}

export async function loadCurrentGrantEvidence(run: LabRun, now: Date): Promise<CurrentGrantEvidence> {
  const db = getCunoteDb();
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("current source revision 검증에 R2 환경변수가 필요합니다.");
  if (run.source !== "kstartup" && run.source !== "bizinfo" && run.source !== "bizinfo_event") {
    throw new Error(`지원하지 않는 grant source입니다: ${run.source}`);
  }
  const source = run.source;
  const [{ reassembleLabInputForRun }, [grant], [raw], [deepRun], [promotionItem], [duplicate]] =
    await Promise.all([
      import("./ai-review"),
      db.select().from(schema.grants).where(eq(schema.grants.id, run.grantId)).limit(1),
      db.select().from(schema.grantRaw).where(and(
        eq(schema.grantRaw.source, source),
        eq(schema.grantRaw.sourceId, run.sourceId),
      )).limit(1),
      db.select({ id: schema.grantDeepAnalysisRuns.id })
        .from(schema.grantDeepAnalysisRuns)
        .where(eq(schema.grantDeepAnalysisRuns.grantId, run.grantId)).limit(1),
      // prepared item은 아직 승격 결과가 아니라 immutable gate를 평가 중인 revision이다.
      // 승인 이후 상태만 신규 후보와 충돌하며, 실패한 prepared revision의 재시도를 영구
      // 차단하지 않는다. 같은 cohort의 prepared revision 충돌은 release CLI가 별도로 판정한다.
      db.select({ id: schema.analysisLabPromotionItems.id })
        .from(schema.analysisLabPromotionItems)
        .innerJoin(
          schema.analysisLabPromotionReleases,
          eq(schema.analysisLabPromotionItems.releaseDbId, schema.analysisLabPromotionReleases.id),
        )
        .where(and(
          eq(schema.analysisLabPromotionItems.grantId, run.grantId),
          inArray(schema.analysisLabPromotionReleases.status, [
            "approved",
            "canary_running",
            "canary_passed",
            "applying",
            "active",
            "partial_failed",
            "rolling_back",
          ]),
        )).limit(1),
      db.select({ memberGrantId: schema.dedupLinks.memberGrantId })
        .from(schema.dedupLinks)
        .where(and(
          eq(schema.dedupLinks.confirmed, true),
          eq(schema.dedupLinks.memberGrantId, run.grantId),
        )).limit(1),
    ]);
  if (!grant) throw new Error(`current grant가 없습니다: ${run.grantId}`);
  const [assembled, operational] = await Promise.all([
    reassembleLabInputForRun(run),
    prepareDeepAnalysisInput({ db, storage, grantId: run.grantId }),
  ]);
  if (!assembled.attachmentManifestSha256) {
    throw new Error(`current attachment manifest를 재조립할 수 없습니다: ${run.grantId}`);
  }
  const applicationOpen = grant.status === "open"
    && isDateOpen(grant.applyEnd, now)
    && !isKStartupRecruitmentClosedPayload(grant.source, raw?.payload);
  return {
    sourceRevisionSha256: operational.sourceRevisionSha256,
    inputSha256: assembled.inputSha256,
    attachmentManifestSha256: assembled.attachmentManifestSha256,
    status: grant.status,
    servingState: grant.servingState,
    applicationOpen,
    hasDeepAnalysisRun: Boolean(deepRun),
    hasPromotionItem: Boolean(promotionItem),
    confirmedDuplicate: Boolean(duplicate?.memberGrantId),
  };
}

function isDateOpen(applyEnd: Date | null, now: Date): boolean {
  if (!applyEnd) return true;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(applyEnd) >= formatter.format(now);
}

function safeSeriesId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/u.test(normalized)) {
    throw new Error(`허용되지 않는 seriesId: ${value}`);
  }
  return normalized;
}

function safePathInside(root: string, path: string): string {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || resolve(root, rel) !== path) {
    throw new Error(`artifact path가 저장소 밖을 가리킵니다: ${path}`);
  }
  return path;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be text`);
  return value;
}

function sha(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(`${label} must be SHA-256`);
  return normalized;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}
