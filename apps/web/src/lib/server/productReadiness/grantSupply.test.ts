import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import { createGrantNextWorkSnapshot } from "./grantNextWorkExecution";
import {
  loadStoredGrantSupplyAssets,
  gateGrantSupplyExecutionPlan,
  buildGrantSupplyDiscoveryTargets,
  assessGrantSupplyDiscoveryTargets,
  isSharedGrantSupplyDiscoveryFailure,
  planGrantSupply,
  type GrantSupplyAsset,
  type GrantSupplyAssetInventory,
} from "./grantSupply";

const grantId = "10000000-0000-4000-8000-000000000091";
const runId = "run-2026-09-24T000000.000Z-aaaaaa";
const otherRunId = "run-2026-09-24T000001.000Z-bbbbbb";
const revision = "a".repeat(64);
const raw = "b".repeat(64);

function snapshot(analysisStatus: "missing" | "present", id = grantId) {
  return createGrantNextWorkSnapshot({
    grantId: id,
    readinessInput: {
      grantId: id,
      source: {
        availability: "available",
        revisionSha256: revision,
        rawSha256: raw,
        attachmentStatus: "not_required",
        attachmentManifestSha256: null,
      },
      analysis: {
        status: analysisStatus,
        sourceRevisionSha256: analysisStatus === "present" ? revision : null,
        sourceRawSha256: analysisStatus === "present" ? raw : null,
        attachmentManifestSha256: null,
        structure: "complete",
        criteriaReview: "reviewed",
        eligibleQuestionCriterionStableKeys: ["criterion:verified"],
      },
      questions: [],
    },
  });
}

function readySnapshot(id: string) {
  const current = snapshot("present", id);
  return createGrantNextWorkSnapshot({
    grantId: id,
    readinessInput: {
      ...current.readinessInput,
      questions: [{
        criterionStableKey: "criterion:verified",
        evaluationContractVersion: "confirmation-evaluation-v2",
        reviewed: true,
        invalidated: false,
        sourceRevisionSha256: revision,
        sourceRawSha256: raw,
      }],
    },
  });
}

function asset(overrides: Partial<GrantSupplyAsset> = {}): GrantSupplyAsset {
  return {
    runId,
    sourceRevisionSha256: revision,
    inputSha256: "c".repeat(64),
    attachmentManifestSha256: "d".repeat(64),
    runSha256: "e".repeat(64),
    currentBinding: "verified",
    reviewStatus: "unreviewed",
    reviewSha256: null,
    questionDemand: "unknown",
    manualStatus: "absent",
    manualSelection: null,
    draftPacketSha256: null,
    ...overrides,
  };
}

function checked(assets: GrantSupplyAsset[] = []): GrantSupplyAssetInventory {
  return { status: "checked", assets };
}

test("새 공고에 현행 분석 자산이 없으면 모델 승인을 기다리고 호출하지 않는다", () => {
  const plan = planGrantSupply({ snapshot: snapshot("missing"), inventory: checked() });
  assert.equal(plan.stage, "await_approved_model_run");
  assert.equal(plan.requiredInput, "approved_launch_manifest");
  assert.equal(plan.modelCalls, 0);
});

test("로컬 조회 불가는 확인된 부재나 모델 실행 대기로 바뀌지 않는다", () => {
  const plan = planGrantSupply({
    snapshot: snapshot("missing"),
    inventory: { status: "unavailable", reason: "local_asset_root_unavailable" },
  });
  assert.equal(plan.stage, "asset_inventory_unavailable");
  assert.equal(plan.owner, "reviewer");
  assert.notEqual(plan.evidenceSha256, snapshot("missing").evidenceSha256);
});

test("현행 미발행 자산은 검수, 질문 수요, exact manual 선택에 따라 재사용한다", () => {
  const current = snapshot("missing");
  assert.equal(planGrantSupply({ snapshot: current, inventory: checked([asset({ sourceRevisionSha256: "f".repeat(64) })]) }).stage,
    "await_approved_model_run", "오래된 source의 run은 재사용하지 않는다");
  assert.equal(planGrantSupply({ snapshot: current, inventory: checked([asset()]) }).stage, "review_existing_analysis");
  assert.equal(planGrantSupply({ snapshot: current, inventory: checked([asset({
    currentBinding: "stale",
  })]) }).reason, "analysis_input_or_attachment_drift");
  assert.equal(planGrantSupply({ snapshot: current, inventory: checked([asset({
    reviewStatus: "held",
  })]) }).stage, "review_existing_analysis");
  assert.equal(planGrantSupply({ snapshot: current, inventory: checked([asset({
    reviewStatus: "reviewed", questionDemand: "present",
  })]) }).stage,
    "prepare_question_draft");
  assert.equal(planGrantSupply({ snapshot: current, inventory: checked([asset({
    reviewStatus: "reviewed", questionDemand: "present", draftPacketSha256: "f".repeat(64),
    manualStatus: "selection_required",
  })]) }).requiredInput, "manual_revision_and_artifact_sha256");
  assert.equal(planGrantSupply({ snapshot: current, inventory: checked([asset({
    reviewStatus: "reviewed", questionDemand: "present",
    manualStatus: "withdrawn",
  })]) }).reason, "withdrawn_manual_questions_require_review");
  const release = planGrantSupply({ snapshot: current, inventory: checked([asset({
    reviewStatus: "reviewed", questionDemand: "present", manualStatus: "active",
    manualSelection: { revision: 2, artifactSha256: "f".repeat(64) },
  })]) });
  assert.equal(release.stage, "prepare_promotion_release");
  assert.equal(release.reusedRunId, runId);
  assert.notEqual(release.evidenceSha256, current.evidenceSha256);
  assert.equal(release.assetBinding?.manualSelection?.revision, 2);
  assert.equal(
    gateGrantSupplyExecutionPlan(release, release.evidenceSha256)?.reason,
    "bound_asset_review_or_release_execution_not_connected",
  );
  assert.throws(
    () => gateGrantSupplyExecutionPlan(release, current.evidenceSha256),
    /grant_supply_plan_drift/,
  );
  const formal = planGrantSupply({ snapshot: current, inventory: checked([asset({
    reviewStatus: "unreviewed", questionDemand: "unknown",
    manualStatus: "active", manualSelection: { revision: 2, artifactSha256: "f".repeat(64) },
  })]) });
  assert.equal(formal.stage, "review_existing_analysis");
  assert.equal(gateGrantSupplyExecutionPlan(formal, formal.evidenceSha256)?.status, "blocked");
});

test("질문 수요 0은 초안 생성 없이 분석 승격으로 보내고 선택 충돌을 차단한다", () => {
  const current = snapshot("missing");
  const noDemand = planGrantSupply({ snapshot: current, inventory: checked([asset({
    reviewStatus: "reviewed", questionDemand: "none",
  })]) });
  assert.equal(noDemand.stage, "prepare_promotion_release");
  const inventory = checked([
    asset(), asset({ runId: otherRunId, runSha256: "f".repeat(64) }),
  ]);
  const conflict = planGrantSupply({ snapshot: current, inventory });
  assert.equal(conflict.stage, "asset_selection_conflict");
  assert.equal(conflict.requiredInput, "exact_run_id_and_sha256");
  assert.deepEqual(conflict.candidateRuns.map((candidate) => [candidate.runId, candidate.runSha256]), [
    [runId, "e".repeat(64)], [otherRunId, "f".repeat(64)],
  ]);
  const selected = planGrantSupply({
    snapshot: current, inventory,
    runSelection: { grantId, runId: otherRunId, runSha256: "f".repeat(64) },
  });
  assert.equal(selected.stage, "review_existing_analysis");
  assert.equal(selected.reusedRunId, otherRunId);
  assert.notEqual(selected.evidenceSha256, conflict.evidenceSha256);
  assert.equal(planGrantSupply({
    snapshot: current, inventory,
    runSelection: { grantId, runId: otherRunId, runSha256: "0".repeat(64) },
  }).stage, "asset_selection_conflict");
  assert.equal(planGrantSupply({
    snapshot: current, inventory,
    runSelection: { grantId, runId: "run-2026-09-24T000002.000Z-cccccc", runSha256: "f".repeat(64) },
  }).stage, "asset_selection_conflict");
  const crowded = planGrantSupply({
    snapshot: current,
    inventory: checked(Array.from({ length: 51 }, (_, index) => asset({
      runId: `run-2026-09-24T000000.000Z-${index.toString(16).padStart(6, "0")}`,
    }))),
  });
  assert.equal(crowded.candidateRuns.length, 50);
  assert.equal(crowded.candidateRunCount, 51);
  assert.equal(crowded.candidatesTruncated, true);
});

test("DB의 질문 수요는 기존 승인 release에서만 발행 대기로 넘긴다", () => {
  const current = snapshot("present");
  assert.equal(current.nextWork.action, "question_preparation");
  const plan = planGrantSupply({ snapshot: current, inventory: checked() });
  assert.equal(plan.stage, "await_approved_release");
  assert.equal(plan.requiredInput, "release_id_and_manifest_sha256");
  assert.equal(plan.evidenceSha256, current.evidenceSha256);
  assert.equal(gateGrantSupplyExecutionPlan(plan, current.evidenceSha256), null);
});

test("파일 조회 성공·부재와 조회 불가를 구분하고 현행 input·첨부를 검사한다", async () => {
  const originalCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "grant-supply-"));
  const labDir = join(root, "spike-out", "analysis-lab");
  try {
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    process.chdir(root);
    const input = {
      grantId,
      source: "bizinfo",
      sourceId: "source-1",
      sourceRevisionSha256: revision,
      loadCurrentEvidence: async () => ({
        sourceRevisionSha256: revision,
        inputSha256: "c".repeat(64),
        attachmentManifestSha256: "d".repeat(64),
        status: "open",
        servingState: "visible",
        applicationOpen: true,
        hasDeepAnalysisRun: false,
        hasPromotionItem: false,
        confirmedDuplicate: false,
      }),
    };
    assert.equal((await loadStoredGrantSupplyAssets(input)).status, "unavailable");
    await mkdir(labDir, { recursive: true });
    assert.deepEqual(await loadStoredGrantSupplyAssets(input), { status: "checked", assets: [] });
    const runDir = join(labDir, "bizinfo__source-1");
    await mkdir(runDir);
    await writeFile(join(runDir, `${runId}.json`), JSON.stringify({
      runId, grantId, source: "bizinfo", sourceId: "source-1",
      sourceRevisionSha256: revision, inputSha256: "c".repeat(64),
      attachmentManifestSha256: "d".repeat(64),
      startedAt: "2026-09-24T00:00:00.000Z", model: "fixture",
      promptVersion: "fixture", durationMs: 0, costUsd: null,
      criteria: [], axisAssessments: [], error: null,
    }));
    const found = await loadStoredGrantSupplyAssets(input);
    assert.equal(found.status, "checked");
    if (found.status !== "checked") throw new Error("expected checked inventory");
    assert.equal(found.assets[0]?.currentBinding, "verified");
    assert.equal(found.assets[0]?.runSha256,
      createHash("sha256").update(await readFile(join(runDir, `${runId}.json`))).digest("hex"));
    const selectedFromFile = planGrantSupply({
      snapshot: snapshot("missing"), inventory: found,
      runSelection: { grantId, runId, runSha256: found.assets[0]!.runSha256 },
    });
    assert.equal(selectedFromFile.reusedRunId, runId);
    assert.equal(selectedFromFile.candidateRuns[0]?.runSha256, found.assets[0]?.runSha256);
    const drifted = await loadStoredGrantSupplyAssets({
      ...input,
      loadCurrentEvidence: async () => ({
        ...await input.loadCurrentEvidence(),
        attachmentManifestSha256: "f".repeat(64),
      }),
    });
    assert.equal(drifted.status, "checked");
    if (drifted.status !== "checked") throw new Error("expected checked inventory");
    assert.equal(drifted.assets[0]?.currentBinding, "stale");
    await writeFile(join(runDir, `${runId}.confirmation-evaluations.json`), "{}");
    const needsSelection = await loadStoredGrantSupplyAssets(input);
    assert.equal(needsSelection.status, "checked");
    if (needsSelection.status !== "checked") throw new Error("expected checked inventory");
    assert.equal(needsSelection.assets[0]?.manualStatus, "selection_required");
    const invalidSelection = await loadStoredGrantSupplyAssets({
      ...input,
      manualSelection: { grantId, runId, revision: 1, artifactSha256: "f".repeat(64) },
    });
    assert.equal(invalidSelection.status, "unavailable");
    await writeFile(join(runDir, `${runId}.review.json`), JSON.stringify({
      grantId, runId, reviewerEmail: "reviewer@example.com",
    }));
    assert.equal((await loadStoredGrantSupplyAssets(input)).status, "unavailable",
      "손상된 검수 파일은 검수 없음으로 취급하지 않는다");
    await rm(join(runDir, `${runId}.confirmation-evaluations.json`));
    await writeFile(join(runDir, `${runId}.review.json`), JSON.stringify({
      grantId, runId, reviewerEmail: "reviewer@example.com",
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
      criterionReviews: [],
      axisReviews: CRITERION_DIMENSIONS.map((dimension) => ({
        dimension, verdict: "confirmed_absent", note: null,
      })),
      overallNote: null,
    }));
    const noQuestion = await loadStoredGrantSupplyAssets(input);
    assert.equal(noQuestion.status, "checked");
    if (noQuestion.status !== "checked") throw new Error("expected checked inventory");
    assert.equal(noQuestion.assets[0]?.questionDemand, "none");
    assert.equal(planGrantSupply({
      snapshot: snapshot("missing"), inventory: noQuestion,
    }).stage, "prepare_promotion_release");
    await writeFile(join(runDir, `${runId}.json`), "{");
    assert.equal((await loadStoredGrantSupplyAssets(input)).status, "unavailable",
      "손상된 run 파일은 자산 없음으로 취급하지 않는다");
  } finally {
    process.chdir(originalCwd);
    await rm(root, { recursive: true, force: true });
  }
});

test("이벤트 중복·현재 상태 갱신을 합치고 대상별 실패와 완료 단계를 보존한다", async () => {
  const ids = {
    event: "10000000-0000-4000-8000-000000000092",
    failed: "10000000-0000-4000-8000-000000000093",
    complete: "10000000-0000-4000-8000-000000000094",
  };
  const targets = buildGrantSupplyDiscoveryTargets({
    source: "bizinfo",
    sourceIds: null,
    events: [
      { sourceId: "event", rawHash: "a".repeat(64), collectedAt: new Date("2026-09-23T00:00:00Z") },
      { sourceId: "event", rawHash: "b".repeat(64), collectedAt: new Date("2026-09-24T00:00:00Z") },
      { sourceId: "missing", rawHash: "c".repeat(64), collectedAt: new Date("2026-09-24T00:00:00Z") },
    ],
    current: [
      { id: ids.event, sourceId: "event" },
      { id: ids.failed, sourceId: "failed" },
      { id: ids.complete, sourceId: "complete" },
    ],
  });
  assert.deepEqual(targets.map((target) => target.sourceId), ["complete", "event", "failed", "missing"]);
  assert.equal(targets.find((target) => target.sourceId === "event")?.eventRawSha256, "b".repeat(64));
  assert.equal(targets.find((target) => target.sourceId === "failed")?.discoveredBy, "current_state");
  const assess = async (id: string) => {
    if (id === ids.failed) throw new Error("one_target_broken");
    return planGrantSupply({
      snapshot: id === ids.complete ? readySnapshot(id) : snapshot("missing", id),
      inventory: checked(),
    });
  };
  const first = await assessGrantSupplyDiscoveryTargets({ targets, assess });
  const resumed = await assessGrantSupplyDiscoveryTargets({ targets, assess });
  assert.deepEqual(resumed, first, "재시작 재판정은 같은 현재 상태에서 중복 작업을 만들지 않는다");
  assert.deepEqual(first.map((item) => item.status), ["complete", "pending", "failed", "failed"]);
  assert.equal(first[1]?.assessment?.schema, "grant-supply-plan-v1");
  assert.equal(first[1]?.requiredInput, "approved_launch_manifest");
  assert.equal(first[2]?.reason, "one_target_broken");
  assert.equal(first[3]?.reason, "collection_event_grant_missing");
});

test("공통 DB 장애는 대상별 실패로 숨기지 않고 기간 조회를 중단한다", async () => {
  const targets = buildGrantSupplyDiscoveryTargets({
    source: "bizinfo", sourceIds: ["broken", "later"], events: [],
    current: [
      { id: grantId, sourceId: "broken" },
      { id: "10000000-0000-4000-8000-000000000095", sourceId: "later" },
    ],
  });
  const missingColumn = Object.assign(new Error("column missing"), { code: "42703" });
  assert.equal(isSharedGrantSupplyDiscoveryFailure(missingColumn), true);
  assert.equal(isSharedGrantSupplyDiscoveryFailure(Object.assign(new Error("one source"), { code: "22001" })), false);
  await assert.rejects(
    assessGrantSupplyDiscoveryTargets({ targets, assess: async () => { throw missingColumn; } }),
    (error) => error === missingColumn,
  );
});

test("공급 발견은 8건씩 배치하고 한 건의 자료 오류만 단건 재조회로 격리한다", async () => {
  const ids = Array.from({ length: 9 }, (_, index) =>
    `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`);
  const targets = buildGrantSupplyDiscoveryTargets({
    source: "bizinfo", sourceIds: null, events: [],
    current: ids.map((id, index) => ({ id, sourceId: `source-${index}` })),
  });
  const calls: string[][] = [];
  const assess = async (id: string) => planGrantSupply({
    snapshot: snapshot("missing", id), inventory: checked(),
  });
  const batched = await assessGrantSupplyDiscoveryTargets({
    targets,
    assess: async () => { throw new Error("unexpected_single_read"); },
    assessBatch: async (grantIds) => {
      calls.push([...grantIds]);
      return Promise.all(grantIds.map(assess));
    },
  });
  assert.deepEqual(calls.map((call) => call.length), [8, 1]);
  assert.equal(batched.length, 9);
  assert.ok(batched.every((item) => item.status === "pending"));

  const failedId = ids[3]!;
  let singleReads = 0;
  const isolated = await assessGrantSupplyDiscoveryTargets({
    targets: targets.slice(0, 8),
    assessBatch: async () => { throw new Error("one_target_broken"); },
    assess: async (id) => {
      singleReads += 1;
      if (id === failedId) throw new Error("one_target_broken");
      return assess(id);
    },
  });
  assert.equal(singleReads, 8);
  assert.deepEqual(isolated.map((item) => item.status),
    ["pending", "pending", "pending", "failed", "pending", "pending", "pending", "pending"]);

  const sharedError = Object.assign(new Error("connection failed"), { code: "08006" });
  await assert.rejects(assessGrantSupplyDiscoveryTargets({
    targets,
    assessBatch: async () => { throw sharedError; },
    assess: async () => { throw new Error("unexpected_single_read"); },
  }), (error) => error === sharedError);
});
