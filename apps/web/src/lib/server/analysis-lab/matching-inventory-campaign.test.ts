import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildCurrentInventoryLaunchManifest, type CurrentLaunchInventory } from "./current-inventory-launch";
import {
  isCurrentEligibleMatchingTargetClosingToday,
  prepareMatchingCampaignLaunch,
} from "./current-inventory-launch-production";
import {
  createAnalysisLaunchGrant,
  encodeCanonical,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import {
  classifyMatchingCampaignChildReceipt,
  classifyMatchingInventorySnapshot,
  createMatchingCampaignIndex,
  createMatchingCampaignRunNextPlan,
  partitionMatchingCampaignGrantIds,
  readMatchingCampaignIndex,
  selectMatchingCampaignResume,
  storeMatchingCampaignIndex,
  type MatchingInventorySnapshotTarget,
} from "./matching-inventory-campaign";
import {
  activeLaunchGrantShaFromRuntime,
  applyActiveLaunchOwnership,
  classifyCampaignTerminalHistoryOutcome,
  inspectMatchingHistoryReview,
  matchingHistoryReviewDisposition,
  prepareMatchingInventoryCampaign,
  readActiveLaunchManifest,
  readMatchingCampaignResumeStatus,
  readCurrentInventoryHistoryTargetIds,
  resolveActiveLaunchManifest,
  type MatchingCampaignHistoryRecord,
} from "./matching-inventory-campaign-production";
import { parseMatchingCampaignArgs } from "./matching-inventory-campaign-cli";
import { createAnalysisLaunchStatus } from "./launch-status";

const hex = (char: string) => char.repeat(64);
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const digest = (value: unknown) => createHash("sha256").update(encodeCanonical(value)).digest("hex");

function target(
  index: number,
  history: MatchingInventorySnapshotTarget["history"],
  eligibility: MatchingInventorySnapshotTarget["eligibility"] = { eligible: true },
): MatchingInventorySnapshotTarget {
  return {
    grantId: id(index),
    inputSha256: hex("a"),
    attachmentManifestSha256: hex("b"),
    closesToday: index === 0,
    eligibility,
    history,
  };
}

test("snapshot의 고유 ID를 8개 상태로 수량 보존 분류한다", () => {
  const current = { inputSha256: hex("a"), attachmentManifestSha256: hex("b"), contractCompatible: true } as const;
  const classification = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [
      target(0, { kind: "primary", ...current, review: "passed", sourceRunArtifactSha256: hex("c") }),
      target(1, { kind: "primary", ...current, review: "pending", sourceRunArtifactSha256: hex("d") }),
      target(2, { kind: "prepared", ...current, manifestSha256: hex("e"), ownership: "unowned" }),
      target(3, { kind: "none" }),
      target(4, { kind: "terminal", ...current, outcome: "failed", sourceManifestSha256: hex("1"), sourceReceiptSha256: hex("2") }),
      target(5, { kind: "primary", ...current, inputSha256: hex("f"), review: "passed", sourceRunArtifactSha256: hex("3") }),
      target(6, { kind: "terminal", ...current, outcome: "quality_held", sourceManifestSha256: hex("4"), sourceReceiptSha256: hex("5") }),
      target(7, { kind: "none" }, { eligible: false, reason: "duplicate", duplicateOfGrantId: id(0) }),
    ],
  });
  assert.equal(classification.targetCount, 8);
  assert.deepEqual(classification.entries.map((entry) => entry.category), [
    "reusable", "primary_review_required", "prepared_not_started", "new",
    "terminal_recovery", "source_changed", "quality_held", "excluded",
  ]);
  assert.equal(Object.values(classification.counts).reduce((sum, count) => sum + count, 0), 8);
  assert.equal(classification.entries[0]!.closesToday, true);
});

test("101개 exact ID를 기존 상한 100과 1로만 나눈다", () => {
  const partitions = partitionMatchingCampaignGrantIds(Array.from({ length: 101 }, (_, index) => id(index)));
  assert.deepEqual(partitions.map((items) => items.length), [100, 1]);
  assert.throws(() => partitionMatchingCampaignGrantIds([id(0), id(0)]), /중복/);
  assert.throws(() => partitionMatchingCampaignGrantIds([id(0)], 101), /1~100/);
  assert.deepEqual(
    partitionMatchingCampaignGrantIds(Array.from({ length: 52 }, (_, index) => id(index)), 25)
      .map((items) => items.length),
    [25, 25, 2],
  );
});

test("active owner는 drift보다 먼저 보류하고 KST 저장 달력일로 당일 마감을 표시한다", () => {
  const classified = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [target(0, {
      kind: "prepared",
      inputSha256: hex("f"),
      attachmentManifestSha256: hex("e"),
      contractCompatible: false,
      manifestSha256: hex("d"),
      ownership: "active_elsewhere",
    })],
  });
  assert.equal(classified.entries[0]!.category, "prepared_not_started");
  assert.equal(classified.entries[0]!.campaignEligible, false);
  assert.equal(classified.entries[0]!.reason, "active_owner_preserved");
  assert.equal(isCurrentEligibleMatchingTargetClosingToday(
    new Date("2026-09-18T00:00:00.000Z"),
    new Date("2026-09-18T14:59:59.000Z"),
  ), true);
  assert.equal(isCurrentEligibleMatchingTargetClosingToday(
    new Date("2026-09-18T00:00:00.000Z"),
    new Date("2026-09-18T15:00:00.000Z"),
  ), false);
});

test("다른 target만 검수된 receipt는 현재 target을 pending으로 격리한다", async () => {
  const receiptSha256 = hex("a");
  const input = {
    launchReceiptSha256: receiptSha256,
    grantId: id(1),
    repositoryRoot: "/mock",
  };
  const missingExactTarget = async () => {
    throw new Error(`exact 대상을 검수한 independent review manifest가 없습니다: ${receiptSha256}`);
  };
  assert.equal(await inspectMatchingHistoryReview(input, missingExactTarget), null);
  assert.equal(matchingHistoryReviewDisposition(null), "pending");
  assert.equal(await inspectMatchingHistoryReview(input, async () => {
    throw new Error(`launch matching projection exact binding이 다릅니다: ${input.grantId}`);
  }), "blocked");
  assert.equal(await inspectMatchingHistoryReview(input, async () => {
    throw new Error(`launch matching projection 한쪽 결속이 없습니다: ${input.grantId}`);
  }), "blocked");
  assert.equal(await inspectMatchingHistoryReview(input, async () => {
    throw new Error(`검수 범위를 벗어난 matching projection 변경입니다: ${input.grantId}:4`);
  }), "blocked");
  await assert.rejects(
    () => inspectMatchingHistoryReview(input, async () => { throw new Error("run artifact SHA가 다릅니다"); }),
    /run artifact SHA/,
  );
});

test("campaign index는 child를 content-address하고 live authority 없이 순차 범위만 봉인한다", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => id(index));
  const classification = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: ids.map((_, index) => target(index, { kind: "none" })),
  });
  const manifests = partitionMatchingCampaignGrantIds(ids).map((grantIds, index) => manifest(grantIds, index));
  const campaign = createMatchingCampaignIndex({
    classification,
    children: manifests.map((value) => ({ manifest: value, manifestSha256: digest(value) })),
    allowedStage: "prepare",
    now: new Date("2026-09-18T01:00:00.000Z"),
  });
  assert.deepEqual(campaign.children.map((child) => child.targetGrantIds.length), [100, 1]);
  assert.equal(campaign.execution.childSize, 100);
  assert.deepEqual(campaign.children.map((child) => child.targetCount), [100, 1]);
  assert.equal(campaign.execution.liveAuthority, "none");
  assert.equal(campaign.userScope.grantsStillRequired, true);

  const root = await mkdtemp(join(tmpdir(), "matching-campaign-"));
  try {
    const stored = await storeMatchingCampaignIndex(root, campaign);
    assert.deepEqual(await readMatchingCampaignIndex(root, stored.sha256), campaign);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("선택한 child-size와 각 target count를 campaign index에 exact 봉인한다", () => {
  const ids = Array.from({ length: 26 }, (_, index) => id(index));
  const classification = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: ids.map((_, index) => target(index, { kind: "none" })),
  });
  const manifests = partitionMatchingCampaignGrantIds(ids, 25)
    .map((grantIds, index) => manifest(grantIds, index));
  const campaign = createMatchingCampaignIndex({
    classification,
    children: manifests.map((value) => ({ manifest: value, manifestSha256: digest(value) })),
    allowedStage: "launch",
    childSize: 25,
    now: new Date("2026-09-18T01:00:00.000Z"),
  });
  assert.equal(campaign.execution.childSize, 25);
  assert.deepEqual(campaign.children.map((child) => child.targetCount), [25, 1]);
  assert.throws(() => createMatchingCampaignIndex({
    classification,
    children: [{ manifest: manifest(ids, 9), manifestSha256: digest(manifest(ids, 9)) }],
    allowedStage: "launch",
    childSize: 25,
    now: new Date("2026-09-18T01:00:00.000Z"),
  }), /child-size/);
});

test("campaign status는 다음 child와 그 manifest에 결속된 기존 grant만 읽는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "matching-campaign-status-"));
  try {
    const classification = classifyMatchingInventorySnapshot({
      observedAt: "2026-09-18T00:00:00.000Z",
      targets: [target(0, { kind: "none" })],
    });
    const child = manifest([id(0)], 0);
    const storedManifest = await writeAnalysisLaunchArtifact("manifests", child, root);
    const campaign = createMatchingCampaignIndex({
      classification,
      children: [{ manifest: child, manifestSha256: storedManifest.sha256 }],
      allowedStage: "launch",
      childSize: 25,
      now: new Date("2026-09-18T01:00:00.000Z"),
    });
    const storedCampaign = await storeMatchingCampaignIndex(root, campaign);
    const storedGrant = await writeAnalysisLaunchArtifact("grants", createAnalysisLaunchGrant({
      manifestSha256: storedManifest.sha256,
      targetCount: 1,
      approvedBy: "operator-a",
      now: new Date("2026-09-18T01:01:00.000Z"),
    }), root);
    const status = await readMatchingCampaignResumeStatus({
      campaignSha256: storedCampaign.sha256,
      root,
    });
    assert.equal(status.selection.status, "resume_child");
    if (status.selection.status !== "resume_child") throw new Error("resume child status가 아닙니다.");
    assert.equal(status.selection.childManifestSha256, storedManifest.sha256);
    assert.deepEqual(status.grantSha256s, [storedGrant.sha256]);
    await writeAnalysisLaunchArtifact("grants", createAnalysisLaunchGrant({
      manifestSha256: storedManifest.sha256,
      targetCount: 2,
      approvedBy: "operator-b",
      now: new Date("2026-09-18T01:02:00.000Z"),
    }), root);
    await assert.rejects(() => readMatchingCampaignResumeStatus({
      campaignSha256: storedCampaign.sha256,
      root,
    }), /grant targetCount/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume은 완료 대상을 제외하고 개별 결과는 진행, 공유 오류는 같은 child에서 중단한다", () => {
  const ids = [id(0), id(1), id(2)];
  const classification = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: ids.map((_, index) => target(index, { kind: "none" })),
  });
  const manifests = [manifest(ids.slice(0, 2), 0), manifest(ids.slice(2), 1)];
  const campaign = createMatchingCampaignIndex({
    classification,
    children: manifests.map((value) => ({ manifest: value, manifestSha256: digest(value) })),
    allowedStage: "launch",
    now: new Date("2026-09-18T01:00:00.000Z"),
  });
  const individual = receipt(manifests[0]!, ["publishable", "failed"], "completed", null);
  assert.equal(classifyMatchingCampaignChildReceipt(individual), "individual_terminal");
  assert.deepEqual(selectMatchingCampaignResume({
    campaign,
    receipts: [{ sha256: digest(individual), receipt: individual }],
  }), {
    status: "resume_child",
    childSequence: 1,
    childManifestSha256: digest(manifests[1]),
    resumeGrantIds: [id(2)],
    completedGrantIds: [id(0)],
    reason: "not_started",
  });

  const shared = receipt(manifests[0]!, ["publishable", "skipped"], "systemic-failure", "auth unavailable");
  assert.equal(classifyMatchingCampaignChildReceipt(shared), "shared_stop");
  assert.deepEqual(selectMatchingCampaignResume({
    campaign,
    receipts: [{ sha256: digest(shared), receipt: shared }],
  }), {
    status: "resume_child",
    childSequence: 0,
    childManifestSha256: digest(manifests[0]),
    resumeGrantIds: [id(1)],
    completedGrantIds: [id(0)],
    reason: "shared_stop",
  });
  const sharedAfterIndividualFailure = receipt(
    manifests[0]!, ["failed", "skipped"], "systemic-failure", "window unavailable",
  );
  assert.deepEqual(selectMatchingCampaignResume({
    campaign,
    receipts: [{ sha256: digest(sharedAfterIndividualFailure), receipt: sharedAfterIndividualFailure }],
  }), {
    status: "resume_child",
    childSequence: 0,
    childManifestSha256: digest(manifests[0]),
    resumeGrantIds: [id(1)],
    completedGrantIds: [],
    reason: "shared_stop",
  });
});

test("run-next는 paused runtime에서 기존 grant/launch 명령만 계획하고 자동 실행하지 않는다", () => {
  const ids = [id(0)];
  const classification = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [target(0, { kind: "none" })],
  });
  const child = manifest(ids, 0);
  const campaign = createMatchingCampaignIndex({
    classification,
    children: [{ manifest: child, manifestSha256: digest(child) }],
    allowedStage: "launch",
    childSize: 25,
    now: new Date("2026-09-18T01:00:00.000Z"),
  });
  const campaignSha256 = digest(campaign);
  const selection = selectMatchingCampaignResume({ campaign, receipts: [] });
  const runtime = pausedRuntime();
  const grantPlan = createMatchingCampaignRunNextPlan({
    campaignSha256,
    expectedChildManifestSha256: digest(child),
    approvedBy: "operator-a",
    campaign,
    selection,
    existingGrantSha256s: [],
    runtime,
  });
  assert.equal(grantPlan.status, "command_plan");
  if (grantPlan.status !== "command_plan") throw new Error("grant command-plan이 아닙니다.");
  assert.equal(grantPlan.commandKind, "grant");
  assert.match(grantPlan.command, new RegExp(`--manifest=${digest(child)}`));
  assert.equal(grantPlan.automaticExecution, false);
  assert.equal(grantPlan.userApprovalVerified, false);

  const launchPlan = createMatchingCampaignRunNextPlan({
    campaignSha256,
    expectedChildManifestSha256: digest(child),
    approvedBy: "operator-a",
    campaign,
    selection,
    existingGrantSha256s: [hex("e")],
    runtime,
  });
  assert.equal(launchPlan.status, "command_plan");
  if (launchPlan.status !== "command_plan") throw new Error("launch command-plan이 아닙니다.");
  assert.equal(launchPlan.commandKind, "launch");
  assert.equal(launchPlan.command, `pnpm lab:launch -- --grant=${hex("e")}`);

  const ambiguous = createMatchingCampaignRunNextPlan({
    campaignSha256,
    expectedChildManifestSha256: digest(child),
    approvedBy: "operator-a",
    campaign,
    selection,
    existingGrantSha256s: [hex("d"), hex("e")],
    runtime,
  });
  assert.equal(ambiguous.status, "blocked");
  if (ambiguous.status !== "blocked") throw new Error("multiple grant block이 아닙니다.");
  assert.equal(ambiguous.reason, "multiple_grants");
  assert.throws(() => createMatchingCampaignRunNextPlan({
    campaignSha256,
    expectedChildManifestSha256: digest(child),
    approvedBy: "operator-a",
    campaign,
    selection,
    existingGrantSha256s: [],
    runtime: { ...runtime, activeDeepLeases: 1 },
  }), /paused\/owner 없음\/active lease 0/);
  assert.throws(() => createMatchingCampaignRunNextPlan({
    campaignSha256,
    expectedChildManifestSha256: hex("f"),
    approvedBy: "operator-a",
    campaign,
    selection,
    existingGrantSha256s: [],
    runtime,
  }), /expected child SHA/);
});

test("run-next는 shared stop과 complete에서 다음 launch를 만들지 않는다", () => {
  const classification = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [target(0, { kind: "none" })],
  });
  const child = manifest([id(0)], 0);
  const campaign = createMatchingCampaignIndex({
    classification,
    children: [{ manifest: child, manifestSha256: digest(child) }],
    allowedStage: "launch",
    now: new Date("2026-09-18T01:00:00.000Z"),
  });
  const campaignSha256 = digest(campaign);
  const sharedReceipt = receipt(child, ["skipped"], "systemic-failure", "window unavailable");
  const shared = createMatchingCampaignRunNextPlan({
    campaignSha256,
    expectedChildManifestSha256: digest(child),
    approvedBy: "operator-a",
    campaign,
    selection: selectMatchingCampaignResume({
      campaign,
      receipts: [{ sha256: digest(sharedReceipt), receipt: sharedReceipt }],
    }),
    existingGrantSha256s: [hex("e")],
    runtime: pausedRuntime(),
  });
  assert.equal(shared.status, "blocked");
  if (shared.status !== "blocked") throw new Error("shared stop block이 아닙니다.");
  assert.equal(shared.reason, "shared_stop");

  const completeReceipt = receipt(child, ["publishable"], "completed", null);
  const complete = createMatchingCampaignRunNextPlan({
    campaignSha256,
    expectedChildManifestSha256: digest(child),
    approvedBy: "operator-a",
    campaign,
    selection: selectMatchingCampaignResume({
      campaign,
      receipts: [{ sha256: digest(completeReceipt), receipt: completeReceipt }],
    }),
    existingGrantSha256s: [],
    runtime: pausedRuntime(),
  });
  assert.equal(complete.status, "complete");
});

test("campaign child는 classification material과 terminal ancestry를 exact 대조한다", () => {
  const changedMaterial = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [{ ...target(0, { kind: "none" }), inputSha256: hex("f") }],
  });
  const ordinary = manifest([id(0)], 0);
  assert.throws(() => createMatchingCampaignIndex({
    classification: changedMaterial,
    children: [{ manifest: ordinary, manifestSha256: digest(ordinary) }],
    allowedStage: "prepare",
    now: new Date("2026-09-18T01:00:00.000Z"),
  }), /material/);

  const terminal = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [target(0, {
      kind: "terminal", inputSha256: hex("a"), attachmentManifestSha256: hex("b"),
      contractCompatible: true, outcome: "failed",
      sourceManifestSha256: hex("1"), sourceReceiptSha256: hex("2"),
    })],
  });
  assert.throws(() => createMatchingCampaignIndex({
    classification: terminal,
    children: [{ manifest: ordinary, manifestSha256: digest(ordinary) }],
    allowedStage: "prepare",
    now: new Date("2026-09-18T01:00:00.000Z"),
  }), /terminal recovery child ancestry/);
});

test("production entrypoint는 분류된 신규만 current child로 준비하고 index를 저장한다", async () => {
  const prepared: string[][] = [];
  let stored = false;
  const result = await prepareMatchingInventoryCampaign({
    asOf: new Date("2026-09-18T00:00:00.000Z"),
    allowedStage: "prepare",
    dependencies: {
      root: "/mock",
      readCurrentTargets: async () => [
        { grantId: id(0), inputSha256: hex("a"), attachmentManifestSha256: hex("b"), closesToday: true },
        { grantId: id(1), inputSha256: hex("a"), attachmentManifestSha256: hex("b"), closesToday: false },
        { grantId: id(2), inputSha256: hex("a"), attachmentManifestSha256: hex("b"), closesToday: false },
      ],
      readHistory: async () => new Map([
        [id(0), { grantId: id(0), history: {
          kind: "primary" as const, inputSha256: hex("a"), attachmentManifestSha256: hex("b"),
          contractCompatible: true, review: "passed" as const, sourceRunArtifactSha256: hex("c"),
        }, manifest: null, manifestSha256: null, grantSha256: null }],
        [id(1), { grantId: id(1), history: {
          kind: "prepared" as const, inputSha256: hex("f"), attachmentManifestSha256: hex("e"),
          contractCompatible: false, manifestSha256: hex("d"), ownership: "active_elsewhere" as const,
        }, manifest: null, manifestSha256: hex("d"), grantSha256: null }],
      ]),
      prepareCurrent: async (grantIds) => {
        prepared.push([...grantIds]);
        const value = manifest(grantIds, 9);
        return { manifest: value, manifestSha256: digest(value) };
      },
      prepareTerminal: async () => { throw new Error("unexpected terminal prepare"); },
      storeClassification: async (value) => ({ sha256: digest(value), path: "/mock/classification.json" }),
      storeIndex: async (value) => {
        stored = true;
        return { sha256: digest(value), path: "/mock/campaign.json" };
      },
    },
  });
  assert.deepEqual(prepared, [[id(2)]]);
  assert.equal(stored, true);
  assert.equal(result.classification.counts.reusable, 1);
  assert.equal(result.classification.counts.prepared_not_started, 1);
  assert.equal(result.classification.counts.new, 1);
  assert.equal(result.liveExecutionAuthorized, false);
});

test("production prepare는 child-size를 실제 current child 분할에 적용한다", async () => {
  const prepared: string[][] = [];
  const result = await prepareMatchingInventoryCampaign({
    asOf: new Date("2026-09-18T00:00:00.000Z"),
    allowedStage: "launch",
    childSize: 25,
    dependencies: {
      root: "/mock",
      readCurrentTargets: async () => Array.from({ length: 52 }, (_, index) => ({
        grantId: id(index), inputSha256: hex("a"), attachmentManifestSha256: hex("b"), closesToday: false,
      })),
      readHistory: async () => new Map(),
      prepareCurrent: async (grantIds) => {
        prepared.push([...grantIds]);
        const value = manifest(grantIds, prepared.length);
        return { manifest: value, manifestSha256: digest(value) };
      },
      prepareTerminal: async () => { throw new Error("unexpected terminal prepare"); },
      storeClassification: async (value) => ({ sha256: digest(value), path: "/mock/classification.json" }),
      storeIndex: async (value) => ({ sha256: digest(value), path: "/mock/campaign.json" }),
    },
  });
  assert.deepEqual(prepared.map((items) => items.length), [25, 25, 2]);
  assert.equal(result.index.execution.childSize, 25);
  assert.deepEqual(result.index.children.map((child) => child.targetCount), [25, 25, 2]);
});

test("부분 prepared manifest는 sibling을 재실행하지 않고 exact subset으로 재봉인한다", async () => {
  const source = manifest([id(0), id(1)], 7);
  const prepared: string[][] = [];
  await prepareMatchingInventoryCampaign({
    asOf: new Date("2026-09-18T00:00:00.000Z"),
    allowedStage: "prepare",
    dependencies: {
      root: "/mock",
      readCurrentTargets: async () => [
        { grantId: id(0), inputSha256: hex("a"), attachmentManifestSha256: hex("b"), closesToday: false },
        { grantId: id(1), inputSha256: hex("a"), attachmentManifestSha256: hex("b"), closesToday: false },
      ],
      readHistory: async () => new Map([
        [id(0), { grantId: id(0), history: {
          kind: "prepared" as const, inputSha256: hex("a"), attachmentManifestSha256: hex("b"),
          contractCompatible: true, manifestSha256: digest(source), ownership: "unowned" as const,
        }, manifest: source, manifestSha256: digest(source), grantSha256: null }],
        [id(1), { grantId: id(1), history: {
          kind: "primary" as const, inputSha256: hex("a"), attachmentManifestSha256: hex("b"),
          contractCompatible: true, review: "passed" as const, sourceRunArtifactSha256: hex("c"),
        }, manifest: source, manifestSha256: digest(source), grantSha256: hex("d") }],
      ]),
      prepareCurrent: async (grantIds) => {
        prepared.push([...grantIds]);
        const value = manifest(grantIds, 8);
        return { manifest: value, manifestSha256: digest(value) };
      },
      prepareTerminal: async () => { throw new Error("unexpected terminal prepare"); },
      storeClassification: async (value) => ({ sha256: digest(value), path: "/mock/classification.json" }),
      storeIndex: async (value) => ({ sha256: digest(value), path: "/mock/campaign.json" }),
    },
  });
  assert.deepEqual(prepared, [[id(0)]]);
});

test("primary_and_application prepared manifest는 campaign child로 재사용하지 않는다", async () => {
  const source = manifest([id(0)], 6, "primary_and_application");
  const prepared: string[][] = [];
  await prepareMatchingInventoryCampaign({
    asOf: new Date("2026-09-18T00:00:00.000Z"),
    allowedStage: "prepare",
    dependencies: {
      root: "/mock",
      readCurrentTargets: async () => [
        { grantId: id(0), inputSha256: hex("a"), attachmentManifestSha256: hex("b"), closesToday: false },
      ],
      readHistory: async () => new Map([[id(0), { grantId: id(0), history: {
        kind: "prepared" as const, inputSha256: hex("a"), attachmentManifestSha256: hex("b"),
        contractCompatible: true, manifestSha256: digest(source), ownership: "unowned" as const,
      }, manifest: source, manifestSha256: digest(source), grantSha256: null }]]),
      prepareCurrent: async (grantIds) => {
        prepared.push([...grantIds]);
        const value = manifest(grantIds, 7);
        return { manifest: value, manifestSha256: digest(value) };
      },
      prepareTerminal: async () => { throw new Error("unexpected terminal prepare"); },
      storeClassification: async (value) => ({ sha256: digest(value), path: "/mock/classification.json" }),
      storeIndex: async (value) => ({ sha256: digest(value), path: "/mock/campaign.json" }),
    },
  });
  assert.deepEqual(prepared, [[id(0)]]);
});

test("held가 섞인 source의 failed는 현행 terminal reader로 자동 복구하지 않는다", () => {
  assert.equal(classifyCampaignTerminalHistoryOutcome("failed", true), "quality_held");
  assert.equal(classifyCampaignTerminalHistoryOutcome("failed", false), "failed");
  assert.equal(classifyCampaignTerminalHistoryOutcome("held", false), "quality_held");
});

test("history prefilter는 current inventory target만 안전하게 추출한다", () => {
  assert.deepEqual(readCurrentInventoryHistoryTargetIds({
    schema: "analysis-launch-manifest-v1",
    source: { kind: "current_inventory" },
    targets: [{ grantId: id(0) }, { grantId: id(1) }],
  }), [id(0), id(1)]);
  assert.equal(readCurrentInventoryHistoryTargetIds({
    schema: "analysis-launch-manifest-v1",
    source: { kind: "formal_plan" },
    targets: [{ grantId: id(0) }],
  }), null);
  assert.throws(() => readCurrentInventoryHistoryTargetIds({
    schema: "analysis-launch-manifest-v1",
    source: { kind: "current_inventory" },
    targets: [{ grantId: id(0) }, { grantId: id(0) }],
  }), /grantId/);
});

test("정상 blocked 독립검수는 오류가 아니라 quality held 분류로 이어진다", () => {
  assert.equal(matchingHistoryReviewDisposition("blocked"), "held");
  const classified = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [target(0, {
      kind: "primary", inputSha256: hex("a"), attachmentManifestSha256: hex("b"),
      contractCompatible: true, review: matchingHistoryReviewDisposition("blocked"),
      sourceRunArtifactSha256: hex("c"),
    })],
  });
  assert.equal(classified.entries[0]!.category, "quality_held");
  assert.equal(classified.entries[0]!.campaignEligible, false);
});

test("active ownership은 current runtime lease와 같은 running status가 함께 있어야 한다", () => {
  const source = manifest([id(0)], 10);
  const grantSha256 = hex("e");
  const status = createAnalysisLaunchStatus({
    grantSha256,
    manifestSha256: digest(source),
    manifest: source,
    now: new Date("2026-09-18T00:00:00.000Z"),
  });
  const grant = createAnalysisLaunchGrant({
    manifestSha256: digest(source), targetCount: 1, approvedBy: "reviewer", now: new Date("2026-09-17T23:59:00.000Z"),
  });
  const runtime = {
    controlKey: "global" as const,
    mode: "local_subscription" as const,
    generation: 3,
    changedBy: "lab:launch",
    changeReason: `승인된 launch cohort lease: ${grantSha256}`,
    localOwnerId: "owner-a",
    localLeaseExpiresAt: "2026-09-18T00:02:00.000Z",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    databaseObservedAt: "2026-09-18T00:01:00.000Z",
    activeDeepLeases: 0,
    activeApplicationLeases: 0,
  };
  assert.equal(activeLaunchGrantShaFromRuntime(runtime), grantSha256);
  assert.equal(resolveActiveLaunchManifest({ runtime, status, grant }), digest(source));
  assert.throws(() => resolveActiveLaunchManifest({ runtime, status: null, grant }), /결속되지 않았습니다/);

  const paused = {
    ...runtime,
    mode: "paused" as const,
    changeReason: null,
    localOwnerId: null,
    localLeaseExpiresAt: null,
  };
  assert.equal(resolveActiveLaunchManifest({ runtime: paused, status, grant }), null);
  const expired = { ...runtime, localLeaseExpiresAt: "2026-09-18T00:00:59.000Z" };
  assert.equal(resolveActiveLaunchManifest({ runtime: expired, status, grant }), null);
  assert.throws(() => activeLaunchGrantShaFromRuntime({ ...runtime, changeReason: "다른 local 작업" }), /결속할 수 없습니다/);
  assert.throws(() => activeLaunchGrantShaFromRuntime({ ...paused, activeDeepLeases: 1 }), /active queue lease/);
  assert.throws(() => resolveActiveLaunchManifest({
    runtime, status, grant: { ...grant, manifestSha256: hex("f") },
  }), /결속되지 않았습니다/);
});

test("active retry target은 이전 terminal history의 최종 overwrite에도 active가 우선한다", () => {
  const source = manifest([id(0)], 11);
  const manifestSha256 = digest(source);
  const status = createAnalysisLaunchStatus({
    grantSha256: hex("e"), manifestSha256, manifest: source,
    now: new Date("2026-09-18T00:00:00.000Z"),
  });
  const terminalRecord: MatchingCampaignHistoryRecord = {
    grantId: id(0),
    history: {
      kind: "terminal", inputSha256: hex("a"), attachmentManifestSha256: hex("b"),
      contractCompatible: true, outcome: "failed",
      sourceManifestSha256: manifestSha256, sourceReceiptSha256: hex("d"),
    },
    manifest: source,
    manifestSha256,
    grantSha256: hex("e"),
  };
  const result = new Map<string, MatchingCampaignHistoryRecord>([[id(0), terminalRecord]]);
  const failedReceipt = receipt(source, ["failed"], "completed", null);
  applyActiveLaunchOwnership({
    result,
    currentGrantIds: new Set([id(0)]),
    manifestSha256,
    manifest: source,
    status,
    latestReceipt: { sha256: digest(failedReceipt), receipt: failedReceipt },
  });
  assert.deepEqual(result.get(id(0))?.history, {
    kind: "prepared",
    inputSha256: hex("a"),
    attachmentManifestSha256: hex("b"),
    contractCompatible: true,
    manifestSha256,
    ownership: "active_elsewhere",
  });

  const completed = new Map<string, MatchingCampaignHistoryRecord>([[id(0), terminalRecord]]);
  const publishableReceipt = receipt(source, ["publishable"], "completed", null);
  applyActiveLaunchOwnership({
    result: completed,
    currentGrantIds: new Set([id(0)]),
    manifestSha256,
    manifest: source,
    status,
    latestReceipt: { sha256: digest(publishableReceipt), receipt: publishableReceipt },
  });
  assert.equal(completed.get(id(0))?.history.kind, "terminal");
});

test("formal active manifest도 current history 필터와 무관하게 target ownership을 보호한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "matching-active-formal-"));
  try {
    const current = manifest([id(0)], 12, "primary_and_application");
    const formal: AnalysisLaunchManifest = {
      ...current,
      source: { ...current.source, kind: "formal_plan" },
    };
    const stored = await writeAnalysisLaunchArtifact("manifests", formal, root);
    const loaded = await readActiveLaunchManifest(root, stored.sha256);
    const status = createAnalysisLaunchStatus({
      grantSha256: hex("e"), manifestSha256: stored.sha256, manifest: loaded,
      now: new Date("2026-09-18T00:00:00.000Z"),
    });
    const result = new Map<string, MatchingCampaignHistoryRecord>();
    applyActiveLaunchOwnership({
      result,
      currentGrantIds: new Set([id(0)]),
      manifestSha256: stored.sha256,
      manifest: loaded,
      status,
      latestReceipt: null,
    });
    const history = result.get(id(0))?.history;
    assert.equal(history?.kind, "prepared");
    if (history?.kind !== "prepared") throw new Error("active history가 prepared가 아닙니다.");
    assert.equal(history.ownership, "active_elsewhere");
    assert.equal(history.contractCompatible, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classification SHA 없이는 campaign history bypass prepare에 진입하지 못한다", async () => {
  const classification = classifyMatchingInventorySnapshot({
    observedAt: "2026-09-18T00:00:00.000Z",
    targets: [target(0, { kind: "none" })],
  });
  await assert.rejects(() => prepareMatchingCampaignLaunch({
    grantIds: [id(0)], concurrency: 2, classification, classificationSha256: hex("f"),
  }), /classification SHA/);
});

test("campaign CLI는 child-size 기본값/옵션과 status/run-next를 엄격히 파싱한다", () => {
  assert.deepEqual(parseMatchingCampaignArgs([
    "--prepare", "--as-of=2026-09-18T00:00:00.000Z", "--allowed-stage=prepare",
  ]), {
    kind: "prepare", asOf: new Date("2026-09-18T00:00:00.000Z"),
    allowedStage: "prepare", childSize: 100,
  });
  assert.deepEqual(parseMatchingCampaignArgs([
    "--prepare", "--as-of=2026-09-18T00:00:00.000Z", "--allowed-stage=launch", "--child-size=25",
  ]), {
    kind: "prepare", asOf: new Date("2026-09-18T00:00:00.000Z"),
    allowedStage: "launch", childSize: 25,
  });
  assert.deepEqual(parseMatchingCampaignArgs(["--status", `--campaign=${hex("a")}`]), {
    kind: "status", campaignSha256: hex("a"),
  });
  assert.deepEqual(parseMatchingCampaignArgs([
    "--run-next", `--campaign=${hex("a")}`, `--child=${hex("b")}`, "--approved-by=operator-a",
  ]), {
    kind: "run-next", campaignSha256: hex("a"), expectedChildManifestSha256: hex("b"),
    approvedBy: "operator-a",
  });
  assert.throws(() => parseMatchingCampaignArgs([
    "--prepare", "--as-of=2026-09-18T00:00:00.000Z", "--allowed-stage=launch", "--child-size=0",
  ]));
  assert.throws(() => parseMatchingCampaignArgs([
    "--prepare", "--as-of=2026-09-18T00:00:00.000Z", "--allowed-stage=launch", `--campaign=${hex("a")}`,
  ]));
  assert.throws(() => parseMatchingCampaignArgs(["--prepare", "--status"]));
});

function pausedRuntime() {
  return {
    mode: "paused",
    generation: 11,
    localOwnerId: null,
    localLeaseExpiresAt: null,
    databaseObservedAt: "2026-09-18T00:01:00.000Z",
    activeDeepLeases: 0,
    activeApplicationLeases: 0,
  };
}

function manifest(
  grantIds: readonly string[],
  child: number,
  analysisMode: "matching_only" | "primary_and_application" = "matching_only",
): AnalysisLaunchManifest {
  const inventory: CurrentLaunchInventory = {
    schema: "analysis-current-inventory-v1",
    seriesId: `current-campaign-${child}`,
    observedAt: "2026-09-18T00:00:00.000Z",
    model: "test-model",
    policy: "open-visible-current-period-unseen-v1",
    historicalGrantIdsSha256: hex("9"),
    targets: grantIds.map((grantId, sequence) => ({
      sequence,
      grantId,
      stratum: "bizinfo/thin",
      inputSha256: hex("a"),
      attachmentManifestSha256: hex("b"),
      sourceRevisionSha256: hex("c"),
    })),
  };
  return buildCurrentInventoryLaunchManifest({
    inventory,
    inventorySha256: digest(inventory),
    provenance: { gitSha: "a".repeat(40), packageRuntimeSha256: hex("d"), validatorVersion: "validator-test" },
    concurrency: 2,
    now: new Date("2026-09-18T00:30:00.000Z"),
    analysisMode,
  });
}

function receipt(
  source: AnalysisLaunchManifest,
  statuses: readonly AnalysisLaunchReceipt["targets"][number]["status"][],
  stopReason: AnalysisLaunchReceipt["stopReason"],
  systemicFailure: string | null,
): AnalysisLaunchReceipt {
  const summary = { publishable: 0, held: 0, failed: 0, skipped: 0 };
  for (const status of statuses) summary[status] += 1;
  return {
    schema: "analysis-launch-receipt-v1",
    grantSha256: hex("e"),
    manifestSha256: digest(source),
    startedAt: "2026-09-18T02:00:00.000Z",
    finishedAt: "2026-09-18T02:01:00.000Z",
    lifecycle: "finished",
    stopReason,
    systemicFailure,
    summary,
    targets: source.targets.map((item, index) => ({
      sequence: index,
      grantId: item.grantId,
      status: statuses[index]!,
      runArtifactPath: statuses[index] === "publishable" ? `spike-out/run-${index}.json` : null,
      runArtifactSha256: statuses[index] === "publishable" ? hex("f") : null,
      applicationRoundtripStatus: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      error: statuses[index] === "failed" ? "individual failure" : null,
    })),
  };
}
