import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeepRepairProposalPreparer,
  createDeepRepairProposalFilesystemWriter,
  DEEP_REPAIR_PREPARATION_POLICY,
  type DeepRepairPreparationDependencies,
  type DeepRepairProposalArtifactWrite,
  type DeepRepairProposalTarget,
} from "./deep-repair-preparation";
import {
  DeepRepairPreparationCliAmbiguousError,
  deepRepairPreparationCliErrorExitCode,
  parseDeepRepairPreparationCliArgs,
  resolveDeepRepairPreparationCliCleanupFailure,
} from "./deep-repair-preparation-cli";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { selectDeepRepairPlanningTargets } from "./cohort";
import {
  DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE,
  DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE,
  DEEP_REPAIR_FORMAL_REQUIRED_STRATA,
} from "./deep-repair-formal-policy";

const REQUIRED_STRATA = [
  "bizinfo/thick",
  "bizinfo/medium",
  "bizinfo/thin",
  "kstartup/thick",
  "kstartup/medium",
  "kstartup/thin",
] as const;

assert.equal(
  DEEP_REPAIR_PREPARATION_POLICY.seriesId,
  "deep-v19",
  "변경된 matching-readiness 코드는 새 불변 series에만 봉인해야 한다",
);

function exactSha(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function targets(): DeepRepairProposalTarget[] {
  return Array.from({ length: 30 }, (_, index) => ({
    grantId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    source: index % 2 === 0 ? "bizinfo" : "kstartup",
    title: `공고 ${index + 1}`,
    stratum: REQUIRED_STRATA[index % REQUIRED_STRATA.length]!,
  }));
}

const stableProvenance = {
  gitSha: "a".repeat(40),
  packageRuntimeSha256: exactSha(9001),
  validatorVersion: "deep-analysis-v1",
};

function setup(overrides: Partial<DeepRepairPreparationDependencies> = {}) {
  const writes: DeepRepairProposalArtifactWrite[] = [];
  const prepareCalls: string[] = [];
  const selected = targets();
  const deps: DeepRepairPreparationDependencies = {
    now: () => new Date("2026-08-14T01:02:03.000Z"),
    readExecutionProvenance: async () => stableProvenance,
    listExcludedGrantIds: async () => [],
    selectTargets: async () => ({
      targets: selected,
      quotas: {
        unified: { target: 4, achieved: 3 },
        richCriteria: { target: 6, achieved: 6 },
      },
      warnings: ["쿼터 미충족(soft): 통합공고 3/4건"],
    }),
    prepareTarget: async (grantId) => {
      prepareCalls.push(grantId);
      const index = selected.findIndex((target) => target.grantId === grantId);
      const target = selected[index]!;
      return {
        grantId,
        source: target.source,
        title: target.title,
        inputSha256: exactSha(index + 1),
        attachmentManifestSha256: exactSha(1000 + index + 1),
        inputTotalChars: 10_000 + index,
        inputBlocks: [
          { label: "공고 구조화 필드", chars: 1000 + index, truncated: false },
          { label: `첨부: ${index + 1}.md`, chars: 9000, truncated: index === 29 },
        ],
      };
    },
    writeImmutableArtifact: async (artifact) => {
      writes.push({ path: artifact.path, bytes: Buffer.from(artifact.bytes) });
    },
    ...overrides,
  };
  return { deps, writes, prepareCalls, selected };
}

{
  const { deps, writes, prepareCalls } = setup();
  const result = await createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" });
  assert.equal(result.plan.sequence.length, 30);
  assert.deepEqual(
    [...new Set(result.plan.sequence.slice(0, 15).map((target) => target.stratum))].sort(),
    [...REQUIRED_STRATA].sort(),
    "첫 15건이 여섯 층을 모두 포함해야 한다",
  );
  assert.deepEqual(prepareCalls, targets().map((target) => target.grantId));
  assert.equal(writes.length, 5, "wave cohort 둘, plan, proposal, series marker만 쓴다");
  assert.equal(writes.filter((artifact) => artifact.path.includes("/cohorts/")).length, 2);
  assert.ok(writes.some((artifact) => artifact.path.endsWith(`/plans/${result.plan.planSha256}.json`)));
  assert.ok(writes.some((artifact) => artifact.path.endsWith(`/proposals/${result.proposalSha256}.json`)));
  assert.equal(result.seriesMarkerPath, "spike-out/analysis-lab/experiments/series/deep-v19.json");
  assert.equal(writes.at(-1)?.path, result.seriesMarkerPath, "고정 series marker가 마지막 CAS여야 한다");
  assert.match(result.planArtifactSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(
    result.plan.planSha256,
    result.planArtifactSha256,
    "semantic plan SHA와 raw artifact SHA를 하나로 취급하면 안 된다",
  );

  const proposal = JSON.parse(
    writes.find((artifact) => artifact.path.endsWith(`/proposals/${result.proposalSha256}.json`))!
      .bytes.toString("utf8"),
  ) as Record<string, any>;
  assert.equal(proposal.sequence.length, 30);
  assert.deepEqual(proposal.sequence[0], {
    attachmentManifestSha256: exactSha(1001),
    grantId: "00000000-0000-4000-8000-000000000001",
    inputSha256: exactSha(1),
    inputBlocks: [
      { chars: 1000, label: "공고 구조화 필드", truncated: false },
      { chars: 9000, label: "첨부: 1.md", truncated: false },
    ],
    inputTotalChars: 10_000,
    sequence: 0,
    source: "bizinfo",
    stratum: "bizinfo/thick",
    title: "공고 1",
    waveId: "wave-1",
  });
  assert.equal(proposal.policy.seriesId, "deep-v19");
  assert.equal(proposal.policy.seed, 20260814);
  assert.equal(proposal.policy.model, "claude-opus-5");
  assert.equal(proposal.policy.transport, "claude-cli");
  assert.deepEqual(proposal.selection.strataCounts, {
    "bizinfo/medium": 5,
    "bizinfo/thick": 5,
    "bizinfo/thin": 5,
    "kstartup/medium": 5,
    "kstartup/thick": 5,
    "kstartup/thin": 5,
  });
  assert.deepEqual(proposal.selection.softQuotas, {
    richCriteria: { achieved: 6, target: 6 },
    unified: { achieved: 3, target: 4 },
  });
  assert.deepEqual(proposal.selection.warnings, ["쿼터 미충족(soft): 통합공고 3/4건"]);
  assert.equal(proposal.plan.planSha256, result.plan.planSha256);
  assert.equal(proposal.plan.rawSha256, result.planArtifactSha256);
  assert.equal(proposal.plan.manifestSha256, result.plan.manifestSha256);
  assert.equal(
    proposal.exclusions.grantIdsSha256,
    createHash("sha256").update("[]").digest("hex"),
  );
  assert.equal(proposal.safety.authorityScope, "one-authority-one-target");
  assert.equal(proposal.safety.nextTarget, "new-user-approval-required");
  assert.deepEqual(proposal.safety.excludedLanes, ["kordoc", "review", "promotion"]);
  assert.deepEqual(proposal.safety.stopVerdicts, ["GO", "NO_GO", "INCONCLUSIVE", "INVALID"]);
  assert.equal(proposal.safety.liveExecutionAuthorized, false);
  assert.deepEqual(proposal.unresolvedGateConditions, [
    "current-production-observe-only-evidence",
    "runtime-generation-and-lease",
    "per-target-user-approval-and-authority",
  ]);
}

{
  const root = await mkdtemp(join(tmpdir(), "cunote-deep-repair-history-"));
  try {
    const canonicalGrant = "00000000-0000-4000-8000-000000000001";
    const snapshotGrant = "00000000-0000-4000-8000-000000000002";
    const runGrant = "00000000-0000-4000-8000-000000000003";
    const experimentGrant = "00000000-0000-4000-8000-000000000004";
    const orphanGrant = "00000000-0000-4000-8000-000000000005";
    const formalBaselineGrant = "00000000-0000-4000-8000-000000000006";
    const plannedOnlyGrant = "00000000-0000-4000-8000-000000000007";
    await writeFile(join(root, "cohort.json"), JSON.stringify({
      version: 2,
      entries: [{ grantId: canonicalGrant, stratum: "pilot" }],
    }));
    await writeFile(join(root, "cohort.old.json"), JSON.stringify({
      version: 1,
      grantIds: [snapshotGrant],
    }));
    await writeFile(join(root, "cohort.deep-v17-cp2b-pilot5.json"), JSON.stringify({
      version: 1,
      grantIds: [formalBaselineGrant],
    }));
    await mkdir(join(root, "bizinfo__one"));
    await writeFile(
      join(root, "bizinfo__one", "run-2026-08-14T010203.000Z-a1b2c3.json"),
      JSON.stringify({ grantId: runGrant }),
    );
    await writeFile(
      join(root, "bizinfo__one", "run-2026-08-14T010203.000Z-a1b2c3.audit.model.json"),
      "not a primary run",
    );
    const cohortBody = `${JSON.stringify({
      schema: "deep-repair-cohort-v1",
      orderedTargets: [{ grantId: orphanGrant, stratum: "bizinfo/thick" }],
    })}\n`;
    const cohortSha = createHash("sha256").update(cohortBody).digest("hex");
    await mkdir(join(root, "experiments", "cohorts", "nested"), { recursive: true });
    await writeFile(join(root, "experiments", "cohorts", "nested", `${cohortSha}.json`), cohortBody);

    const proposalBody = `${JSON.stringify({
      schema: "deep-repair-proposal-v1",
      sequence: [{ grantId: experimentGrant }, { grantId: plannedOnlyGrant }],
    })}\n`;
    const proposalSha = createHash("sha256").update(proposalBody).digest("hex");
    await mkdir(join(root, "experiments", "proposals"), { recursive: true });
    await writeFile(join(root, "experiments", "proposals", `${proposalSha}.json`), proposalBody);
    await mkdir(join(root, "experiments", "series"), { recursive: true });
    await writeFile(join(root, "experiments", "series", "deep-v18.json"), JSON.stringify({
      schema: "deep-repair-series-proposal-v1",
      seriesId: "deep-v18",
      proposalPath: `spike-out/analysis-lab/experiments/proposals/${proposalSha}.json`,
      proposalSha256: proposalSha,
      planSha256: exactSha(7001),
      planArtifactSha256: exactSha(7002),
      manifestSha256: exactSha(7003),
    }));
    await mkdir(
      join(root, "experiments", "attempts", exactSha(7001), "00"),
      { recursive: true },
    );
    await writeFile(
      join(root, "experiments", "attempts", exactSha(7001), "00", "claim.json"),
      JSON.stringify({
        schema: "deep-repair-live-start-v1",
        planSha256: exactSha(7001),
        target: { sequence: 0, grantId: experimentGrant },
      }),
    );
    await writeFile(
      join(
        root,
        "experiments",
        "series",
        ".immutable-artifact-00000000-0000-4000-8000-000000000099.tmp",
      ),
      "partial temp bytes",
    );

    assert.deepEqual(await readDeepRepairHistoricalGrantIds({ rootDir: root }), [
      canonicalGrant,
      snapshotGrant,
      runGrant,
      experimentGrant,
      formalBaselineGrant,
      plannedOnlyGrant,
    ], "atomic publisher의 orphan temp는 committed series history가 아니다");
    assert.deepEqual(
      await readDeepRepairHistoricalGrantIds({ rootDir: root, scope: "formal-baseline" }),
      [experimentGrant, formalBaselineGrant],
      "formal 준비는 실제 착수한 target만 제외하고 미실행 계획 target은 재사용해야 한다",
    );

    await writeFile(join(root, "experiments", "series", ".unexpected.tmp"), "unexpected");
    await assert.rejects(
      readDeepRepairHistoricalGrantIds({ rootDir: root }),
      /unexpected experiment series marker: \.unexpected\.tmp/,
      "helper-owned exact temp 형식 이외의 entry는 계속 fail closed 해야 한다",
    );
    await unlink(join(root, "experiments", "series", ".unexpected.tmp"));

    await writeFile(join(root, "cohort.broken.json"), "{broken");
    await assert.rejects(
      readDeepRepairHistoricalGrantIds({ rootDir: root }),
      /cannot read historical cohort cohort\.broken\.json/,
      "관련 snapshot 손상은 fail closed 해야 한다",
    );
    await unlink(join(root, "cohort.broken.json"));
    await writeFile(
      join(root, "experiments", "cohorts", "nested", `${cohortSha}.json`),
      `${cohortBody} `,
    );
    assert.deepEqual(
      await readDeepRepairHistoricalGrantIds({ rootDir: root }),
      [canonicalGrant, snapshotGrant, runGrant, experimentGrant, formalBaselineGrant, plannedOnlyGrant],
      "series marker가 참조하지 않은 orphan cohort는 선정 상태에 영향을 주면 안 된다",
    );
    await writeFile(join(root, "experiments", "cohorts", "nested", `${cohortSha}.json`), cohortBody);
    await writeFile(
      join(root, "experiments", "proposals", `${proposalSha}.json`),
      `${proposalBody} `,
    );
    await assert.rejects(
      readDeepRepairHistoricalGrantIds({ rootDir: root }),
      /proposal content address mismatch/,
      "committed proposal bytes drift는 fail closed 해야 한다",
    );
    await writeFile(join(root, "experiments", "proposals", `${proposalSha}.json`), proposalBody);
    await writeFile(join(root, "cohort.invalid-id.json"), JSON.stringify({
      version: 2,
      entries: [{ grantId: "not-a-uuid", stratum: "pilot" }],
    }));
    await assert.rejects(
      readDeepRepairHistoricalGrantIds({ rootDir: root }),
      /UUID.*not-a-uuid|not-a-uuid.*UUID/i,
      "historical grantId 형식 오류를 조용히 제외하면 안 된다",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

assert.deepEqual(DEEP_REPAIR_PREPARATION_POLICY, {
  seriesId: "deep-v19",
  seed: 20260814,
  targetCount: 30,
  waveSize: 15,
  model: "claude-opus-5",
  transport: "claude-cli",
  gatePolicyVersion: "repair-sprt-v1",
});

{
  const first = setup();
  const second = setup();
  const firstResult = await createDeepRepairProposalPreparer(first.deps).prepare({ seriesId: "deep-v19" });
  const secondResult = await createDeepRepairProposalPreparer(second.deps).prepare({ seriesId: "deep-v19" });
  assert.equal(secondResult.plan.planSha256, firstResult.plan.planSha256);
  assert.equal(secondResult.planArtifactSha256, firstResult.planArtifactSha256);
  assert.equal(secondResult.proposalSha256, firstResult.proposalSha256);
  assert.deepEqual(
    second.writes.map((artifact) => [artifact.path, artifact.bytes.toString("hex")]),
    first.writes.map((artifact) => [artifact.path, artifact.bytes.toString("hex")]),
    "같은 입력과 시각은 byte-identical artifact를 만들어야 한다",
  );
}

{
  const selected = targets();
  const { deps, writes, prepareCalls } = setup({
    listExcludedGrantIds: async () => [selected[0]!.grantId],
    selectTargets: async () => ({
      targets: selected,
      quotas: {
        unified: { target: 4, achieved: 4 },
        richCriteria: { target: 6, achieved: 6 },
      },
      warnings: [],
    }),
  });
  await assert.rejects(
    createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" }),
    /excluded.*000000000001|000000000001.*excluded/i,
  );
  assert.equal(prepareCalls.length, 0);
  assert.equal(writes.length, 0, "겹침 실패는 산출물을 남기면 안 된다");
}

{
  const base = setup();
  const { deps, writes } = setup({
    prepareTarget: async (grantId) => {
      if (grantId === "00000000-0000-4000-8000-000000000030") {
        throw new Error("R2 unavailable");
      }
      return base.deps.prepareTarget(grantId);
    },
  });
  await assert.rejects(
    createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" }),
    /R2 unavailable/,
  );
  assert.equal(writes.length, 0, "30번째 입력 준비 실패도 산출물을 남기면 안 된다");
}

{
  const invalid = targets();
  invalid[0] = { ...invalid[0]!, grantId: "not-a-uuid" };
  const { deps, writes } = setup({
    selectTargets: async () => ({
      targets: invalid,
      quotas: {
        unified: { target: 4, achieved: 4 },
        richCriteria: { target: 6, achieved: 6 },
      },
      warnings: [],
    }),
  });
  await assert.rejects(
    createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" }),
    /grantId.*UUID|UUID.*grantId/i,
  );
  assert.equal(writes.length, 0);
}

{
  const missing = join(tmpdir(), `cunote-deep-repair-missing-${Date.now()}`);
  await assert.rejects(
    readDeepRepairHistoricalGrantIds({ rootDir: missing }),
    /history root.*not found|not found.*history root/i,
  );
}

{
  let provenanceReads = 0;
  const { deps, writes } = setup({
    readExecutionProvenance: async () => ({
      ...stableProvenance,
      gitSha: provenanceReads++ === 0 ? stableProvenance.gitSha : "b".repeat(40),
    }),
  });
  await assert.rejects(
    createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" }),
    /provenance.*drift/i,
  );
  assert.equal(writes.length, 0, "provenance drift는 산출물을 남기면 안 된다");
}

{
  let exclusionReads = 0;
  const { deps, writes } = setup({
    listExcludedGrantIds: async () => (
      exclusionReads++ === 0 ? [] : ["00000000-0000-4000-8000-000000000099"]
    ),
  });
  await assert.rejects(
    createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" }),
    /historical exclusion set drift/i,
  );
  assert.equal(writes.length, 0, "과거 표본 집합 drift도 산출물을 남기면 안 된다");
}

{
  let selectionReads = 0;
  const { deps, writes } = setup({
    selectTargets: async () => {
      const selected = targets();
      if (selectionReads++ > 0) {
        selected[0] = { ...selected[0]!, stratum: "bizinfo/medium" };
      }
      return {
        targets: selected,
        quotas: {
          unified: { target: 4, achieved: 3 },
          richCriteria: { target: 6, achieved: 6 },
        },
        warnings: ["쿼터 미충족(soft): 통합공고 3/4건"],
      };
    },
  });
  await assert.rejects(
    createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" }),
    /selection.*drift|stratum.*drift/i,
  );
  assert.equal(writes.length, 0, "후보/stratum snapshot drift는 산출물을 남기면 안 된다");
}

{
  const { deps, writes } = setup({
    selectTargets: async () => ({
      targets: targets().map((target, index) => (
        index < 15 ? { ...target, stratum: "bizinfo/thick" } : target
      )),
      quotas: {
        unified: { target: 4, achieved: 4 },
        richCriteria: { target: 6, achieved: 6 },
      },
      warnings: [],
    }),
  });
  await assert.rejects(
    createDeepRepairProposalPreparer(deps).prepare({ seriesId: "deep-v19" }),
    /first 15.*strata/i,
  );
  assert.equal(writes.length, 0);
}

await assert.rejects(
  createDeepRepairProposalPreparer(setup().deps).prepare({ seriesId: "deep-v18" }),
  /deep-v19/,
);

await assert.rejects(
  selectDeepRepairPlanningTargets({ excludeGrantIds: ["not-a-uuid"] }),
  /UUID.*not-a-uuid|not-a-uuid.*UUID/i,
  "selector도 invalid exclusion을 DB 조회 전에 거부해야 한다",
);

assert.deepEqual(parseDeepRepairPreparationCliArgs(["--series=deep-v19"]), {
  kind: "prepare",
  seriesId: "deep-v19",
});
assert.deepEqual(parseDeepRepairPreparationCliArgs(["--", "--series=deep-v19"]), {
  kind: "prepare",
  seriesId: "deep-v19",
});
assert.deepEqual(parseDeepRepairPreparationCliArgs(["--help"]), { kind: "help" });
for (const argv of [
  [],
  ["--"],
  ["--series", "deep-v19"],
  ["--series=deep-v18"],
  ["--series=deep-v19", "--help"],
  ["--model=claude-opus-5"],
  ["--seed=20260814"],
  ["--count=30"],
  ["--authority=abc"],
  ["--execute"],
  ["deep-v19"],
]) {
  assert.throws(() => parseDeepRepairPreparationCliArgs(argv), /--series=deep-v19|--help/);
}
assert.equal(deepRepairPreparationCliErrorExitCode(new Error("prepare failed")), 1);
{
  const ambiguous = resolveDeepRepairPreparationCliCleanupFailure({
    primaryError: null,
    proposalPath: "spike-out/analysis-lab/experiments/proposals/exact.json",
    cleanupError: new Error("close timed out"),
  });
  assert.ok(ambiguous instanceof DeepRepairPreparationCliAmbiguousError);
  assert.equal(deepRepairPreparationCliErrorExitCode(ambiguous), 2);
  assert.match(ambiguous.message, /proposal may exist/i);
}
{
  const primary = new Error("prepare failed");
  assert.equal(resolveDeepRepairPreparationCliCleanupFailure({
    primaryError: primary,
    proposalPath: null,
    cleanupError: new Error("close timed out"),
  }), null);
  assert.ok(primary.cause instanceof Error);
}

{
  const root = await mkdtemp(join(tmpdir(), "cunote-deep-repair-preparation-"));
  try {
    const write = createDeepRepairProposalFilesystemWriter({ rootDir: root });
    const stableBytes = Buffer.from("{\"stable\":true}\n", "utf8");
    const stableSha = createHash("sha256").update(stableBytes).digest("hex");
    const artifact = {
      path: `spike-out/analysis-lab/experiments/cohorts/${stableSha}.json`,
      bytes: stableBytes,
    };
    await write(artifact);
    await write(artifact);
    assert.deepEqual(
      await readFile(join(root, "cohorts", `${stableSha}.json`)),
      artifact.bytes,
    );
    await writeFile(join(root, "cohorts", `${stableSha}.json`), "corrupt after write");
    await assert.rejects(
      write(artifact),
      /immutable artifact conflict/,
    );
    await assert.rejects(
      write({ ...artifact, path: `spike-out/analysis-lab/experiments/cohorts/${"c".repeat(64)}.json` }),
      /content address mismatch/,
    );

    const planSetup = setup();
    const planResult = await createDeepRepairProposalPreparer(planSetup.deps).prepare({
      seriesId: "deep-v19",
    });
    const planArtifact = planSetup.writes.find((item) => item.path.includes("/plans/"))!;
    await write(planArtifact);
    assert.deepEqual(
      await readFile(join(root, "plans", `${planResult.plan.planSha256}.json`)),
      planArtifact.bytes,
    );
    await assert.rejects(
      write({ ...planArtifact, path: `spike-out/analysis-lab/experiments/plans/${"c".repeat(64)}.json` }),
      /plan filename.*canonical planSha|canonical planSha.*plan filename/i,
    );
    await assert.rejects(
      write({ ...artifact, path: "spike-out/analysis-lab/experiments/authorities/" + "c".repeat(64) + ".json" }),
      /unsupported preparation artifact path/,
    );

    const marker = planSetup.writes.at(-1)!;
    assert.equal(marker.path, "spike-out/analysis-lab/experiments/series/deep-v19.json");
    await write(marker);
    await write(marker);
    await assert.rejects(
      write({
        path: marker.path,
        bytes: Buffer.from(
          marker.bytes.toString("utf8").replaceAll(planResult.proposalSha256, "d".repeat(64)),
        ),
      }),
      /immutable artifact conflict/,
      "동시 preparation은 fixed series CAS에서 하나만 commit되어야 한다",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const preparationSource = readFileSync(new URL("./deep-repair-preparation.ts", import.meta.url), "utf8");
const productionSource = readFileSync(
  new URL("./deep-repair-preparation-production.ts", import.meta.url),
  "utf8",
);
const historySource = readFileSync(
  new URL("./deep-repair-preparation-history.ts", import.meta.url),
  "utf8",
);
const cliSource = readFileSync(new URL("./deep-repair-preparation-cli.ts", import.meta.url), "utf8");
const cohortSource = readFileSync(new URL("./cohort.ts", import.meta.url), "utf8");
const combinedProductionSource = `${preparationSource}\n${productionSource}\n${historySource}\n${cliSource}`;
assert.doesNotMatch(combinedProductionSource, /from\s+["'].+deep-repair-live/);
assert.doesNotMatch(
  combinedProductionSource,
  /executePreparedLabAnalysis|runLabAnalysis|runApprovedCanary|createDeepRepairLive|buildClaudeCliFetch|gcloud|child_process/,
);
assert.doesNotMatch(combinedProductionSource, /experiments\/(?:authorities|receipts|observations|evaluator-receipts)/);
assert.doesNotMatch(
  combinedProductionSource,
  /readAuthority|writeAuthority|readOperationalEvidence|runtimeAuthority|acquireLease|promotionEligibility/,
);
assert.match(
  cliSource,
  /import\s*\{\s*loadAnalysisLabEnv\s*\}\s*from\s*["']\.\.\/loadMonorepoEnv["']/,
  "proposal CLI는 저장소의 analysis-lab env 로더를 명시적으로 사용해야 한다",
);
assert.ok(
  cliSource.indexOf("loadAnalysisLabEnv();")
    < cliSource.indexOf("prepareCurrentDeepRepairProposal({"),
  "proposal CLI는 DB/R2 준비를 시작하기 전에 env를 로드해야 한다",
);
assert.match(
  preparationSource,
  /for \(const target of selected\) \{[\s\S]*await dependencies\.prepareTarget\(target\.grantId\)/,
  "30건 입력 준비는 scheduler 없이 순차 read-only여야 한다",
);
assert.doesNotMatch(preparationSource, /Promise\.all\(selected/);
assert.match(productionSource, /readDeepRepairHistoricalGrantIds/);
assert.match(historySource, /LEGACY_COHORT_SNAPSHOT_FILE/);
assert.match(historySource, /PRIMARY_RUN_FILE/);
assert.match(historySource, /SERIES_MARKER_FILE/);
assert.match(historySource, /experiment proposal content address mismatch/);
assert.match(historySource, /readRequiredHistoryRoot/);
assert.match(productionSource, /prepareLabAnalysis\(/);
assert.match(productionSource, /readCurrentDeepRepairExecutionProvenance/);
const planningSelectorStart = cohortSource.indexOf(
  "export async function selectDeepRepairPlanningTargets(",
);
const nextCohortSection = cohortSource.indexOf("// ── 비층화 선정 로직", planningSelectorStart);
assert.ok(planningSelectorStart >= 0 && nextCohortSection > planningSelectorStart);
const planningSelectorSource = cohortSource.slice(planningSelectorStart, nextCohortSection);
assert.doesNotMatch(
  planningSelectorSource,
  /writeCohort|writeFile|saveLabRun|assertAnalysisLabCohortMutationAdmitted/,
  "proposal selector는 DB read-only이고 기존 cohort를 바꾸면 안 된다",
);

console.log("deep-repair-preparation tests: ok");

assert.equal(DEEP_REPAIR_FORMAL_MIN_SAMPLE_SIZE, 15);
assert.equal(DEEP_REPAIR_FORMAL_MAX_SAMPLE_SIZE, 30);
assert.deepEqual(DEEP_REPAIR_FORMAL_REQUIRED_STRATA, REQUIRED_STRATA);
