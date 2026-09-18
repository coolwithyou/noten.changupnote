import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MonitorInspectionError,
  artifactByteLimit,
  gitHead,
  readGitHeadFromMetadata,
  runPrecheck,
  sanitizeSnapshot,
} from "./analysis-monitor-precheck.mjs";

const MINUTE = 60 * 1_000;
const BASE_TIME = Date.parse("2026-09-15T00:00:00.000Z");

test("100건 receipt만 1MiB까지 읽고 다른 artifact 상한은 유지한다", () => {
  assert.equal(artifactByteLimit("artifacts:receipts"), 1_024 * 1_024);
  assert.equal(artifactByteLimit("artifacts:manifests"), 128 * 1_024);
  assert.equal(artifactByteLimit("launch_status"), 128 * 1_024);
});

function fixture({
  now = BASE_TIME,
  head = "a".repeat(40),
  ownerState = "running",
  updatedAt = BASE_TIME,
  manifestSha = "1".repeat(64),
  grantSha = null,
  includeStatuses = null,
  statusStartedAt = BASE_TIME,
  statusUpdatedAt = updatedAt,
  statusTargets = null,
  statusOverride = {},
  manifestTargets = null,
  receipts = [],
  noise = null,
} = {}) {
  const targets = statusTargets ?? [
    {
      sequence: 0,
      grantId: "grant-0",
      status: "running",
      startedAt: new Date(BASE_TIME).toISOString(),
      finishedAt: null,
    },
  ];
  const summary = {
    pending: targets.filter((target) => target.status === "pending").length,
    running: targets.filter((target) => target.status === "running").length,
    publishable: targets.filter((target) => target.status === "publishable").length,
    held: targets.filter((target) => target.status === "held").length,
    failed: targets.filter((target) => target.status === "failed").length,
    skipped: targets.filter((target) => target.status === "skipped").length,
  };
  const artifacts = {
    manifests: manifestSha
      ? [
          {
            sha: manifestSha,
            path: `spike-out/analysis-lab/launch/manifests/${manifestSha}.json`,
            preparedAt: new Date(BASE_TIME - MINUTE).toISOString(),
            targetBindings: manifestTargets
              ?? targets.map(({ sequence, grantId }) => ({ sequence, grantId })),
          },
        ]
      : [],
    grants: grantSha
      ? [
          {
            sha: grantSha,
            path: `spike-out/analysis-lab/launch/grants/${grantSha}.json`,
            approvedAt: new Date(BASE_TIME).toISOString(),
            manifestSha256: manifestSha,
            targetCount: targets.length,
          },
        ]
      : [],
    receipts,
  };
  if ((includeStatuses ?? grantSha !== null) && grantSha) {
    artifacts.statuses = statusOverride === null
      ? []
      : [
          {
            schema: "analysis-launch-status-v1",
            authority: "derived-monitoring-projection",
            sha: grantSha,
            path: `spike-out/analysis-lab/launch/status/${grantSha}.json`,
            grantSha256: grantSha,
            manifestSha256: manifestSha,
            lifecycle: "running",
            startedAt: new Date(statusStartedAt).toISOString(),
            updatedAt: new Date(statusUpdatedAt).toISOString(),
            finishedAt: null,
            receiptSha256: null,
            summary,
            targets,
            ...statusOverride,
          },
        ];
  }
  return {
    gitHead: head,
    observedAt: new Date(now).toISOString(),
    owner: { paneKey: "tab:leaf", state: ownerState, updatedAt },
    artifacts,
    noise,
  };
}

async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cunote-monitor-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lines = [];
  return {
    stateFile: path.join(directory, "state.json"),
    lines,
    emit: (line) => lines.push(JSON.parse(line)),
  };
}

test("Git CLI failure falls back to loose HEAD metadata", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cunote-git-head-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const head = "b".repeat(40);
  await mkdir(path.join(directory, ".git/refs/heads"), { recursive: true });
  await writeFile(path.join(directory, ".git/HEAD"), "ref: refs/heads/main\n");
  await writeFile(path.join(directory, ".git/refs/heads/main"), `${head}\n`);

  assert.equal(readGitHeadFromMetadata(directory), head);
  assert.equal(
    gitHead(directory, () => ({ status: 69, stdout: "", stderr: "license required" })),
    head,
  );
});

test("linked worktree fallback resolves commondir packed refs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cunote-git-worktree-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = path.join(directory, "checkout");
  const gitDirectory = path.join(directory, "common/worktrees/checkout");
  const head = "c".repeat(40);
  await mkdir(worktree, { recursive: true });
  await mkdir(gitDirectory, { recursive: true });
  await writeFile(path.join(worktree, ".git"), "gitdir: ../common/worktrees/checkout\n");
  await writeFile(path.join(gitDirectory, "HEAD"), "ref: refs/heads/packed\n");
  await writeFile(path.join(gitDirectory, "commondir"), "../..\n");
  await writeFile(
    path.join(directory, "common/packed-refs"),
    `# pack-refs with: peeled fully-peeled sorted\n${head} refs/heads/packed\n`,
  );

  assert.equal(readGitHeadFromMetadata(worktree), head);
});

test("first snapshot retries after 30 minutes, ack then unchanged skips", async (t) => {
  const h = await harness(t);
  let time = BASE_TIME;
  const inspect = async () => fixture({ now: time });

  const first = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(first.exitCode, 0);
  assert.deepEqual(first.event.reasons.map((reason) => reason.code), ["initial_snapshot"]);

  time += 10 * MINUTE;
  const backoff = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(backoff.exitCode, 3);
  assert.equal(backoff.event.status, "pending_backoff");

  time += 20 * MINUTE;
  const retry = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(retry.exitCode, 0);
  assert.equal(retry.event.fingerprint, first.event.fingerprint);

  const acked = await runPrecheck({
    ...h,
    inspect,
    now: () => time,
    ack: first.event.fingerprint,
  });
  assert.equal(acked.exitCode, 3);
  assert.equal(acked.event.status, "acknowledged");

  const unchanged = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(unchanged.exitCode, 3);
  assert.equal(unchanged.event.status, "unchanged");

  const changed = await runPrecheck({
    ...h,
    inspect: async () => fixture({ now: time, head: "b".repeat(40) }),
    now: () => time,
  });
  assert.equal(changed.exitCode, 0);
  assert(changed.event.reasons.some((reason) => reason.code === "source_changed"));
});

test("running launch status owns progress and receipt stays terminal authority", async (t) => {
  const h = await harness(t);
  let time = BASE_TIME;
  const manifestSha = "1".repeat(64);
  const grantSha = "2".repeat(64);
  const initialTargets = [
    {
      sequence: 0,
      grantId: "grant-0",
      status: "running",
      startedAt: new Date(BASE_TIME).toISOString(),
      finishedAt: null,
    },
    { sequence: 1, grantId: "grant-1", status: "pending", startedAt: null, finishedAt: null },
  ];
  let current = fixture({ now: time, manifestSha, grantSha, statusTargets: initialTargets });

  const first = await runPrecheck({ ...h, inspect: async () => current, now: () => time });
  await runPrecheck({
    ...h,
    inspect: async () => current,
    now: () => time,
    ack: first.event.fingerprint,
  });

  time += 10 * MINUTE;
  const progressedTargets = [
    {
      sequence: 0,
      grantId: "grant-0",
      status: "publishable",
      startedAt: new Date(BASE_TIME).toISOString(),
      finishedAt: new Date(time).toISOString(),
    },
    {
      sequence: 1,
      grantId: "grant-1",
      status: "running",
      startedAt: new Date(time).toISOString(),
      finishedAt: null,
    },
  ];
  current = fixture({
    now: time,
    manifestSha,
    grantSha,
    ownerState: "completed",
    statusUpdatedAt: time,
    statusTargets: progressedTargets,
  });
  const healthy = await runPrecheck({ ...h, inspect: async () => current, now: () => time });
  assert.equal(healthy.exitCode, 3);
  assert.equal(healthy.event.status, "healthy_progress");

  time += 10 * MINUTE;
  current = fixture({
    now: time,
    manifestSha,
    grantSha,
    ownerState: "completed",
    statusUpdatedAt: time,
    statusTargets: progressedTargets,
  });
  const heartbeat = await runPrecheck({ ...h, inspect: async () => current, now: () => time });
  assert.equal(heartbeat.exitCode, 3);
  assert.equal(heartbeat.event.status, "unchanged");

  const receiptSha = "3".repeat(64);
  current = fixture({
    now: time,
    manifestSha,
    grantSha,
    ownerState: "completed",
    receipts: [
      {
        sha: receiptSha,
        path: `spike-out/analysis-lab/launch/receipts/${receiptSha}.json`,
        finishedAt: new Date(time).toISOString(),
        manifestSha256: manifestSha,
        grantSha256: grantSha,
        stopReason: "completed",
        outcome: "held",
        summary: { held: 1, failed: 0, publishable: 2, skipped: 0 },
      },
    ],
  });
  const completed = await runPrecheck({ ...h, inspect: async () => current, now: () => time });
  assert.equal(completed.exitCode, 0);
  assert(!completed.event.reasons.some((reason) => reason.code === "owner_completed"));
  assert(
    completed.event.reasons.some(
      (reason) => reason.code === "terminal_receipt" && reason.outcome === "held",
    ),
  );

  const fallback = await harness(t);
  current = fixture({ now: time, manifestSha, grantSha, includeStatuses: false });
  const fallbackFirst = await runPrecheck({
    ...fallback,
    inspect: async () => current,
    now: () => time,
  });
  await runPrecheck({
    ...fallback,
    inspect: async () => current,
    now: () => time,
    ack: fallbackFirst.event.fingerprint,
  });
  current = fixture({
    now: time,
    manifestSha,
    grantSha,
    includeStatuses: false,
    ownerState: "completed",
  });
  const fallbackCompleted = await runPrecheck({
    ...fallback,
    inspect: async () => current,
    now: () => time,
  });
  assert(fallbackCompleted.event.reasons.some((reason) => reason.code === "owner_completed"));
});

test("same-grant newer retry status supersedes history until a new receipt seals it", async (t) => {
  const h = await harness(t);
  const manifestSha = "1".repeat(64);
  const grantSha = "2".repeat(64);
  const previousReceiptSha = "3".repeat(64);
  const nextReceiptSha = "4".repeat(64);
  const previousFinishedAt = BASE_TIME + 10 * MINUTE;
  const completedTarget = {
    sequence: 0,
    grantId: "grant-0",
    status: "publishable",
    startedAt: new Date(BASE_TIME).toISOString(),
    finishedAt: new Date(previousFinishedAt).toISOString(),
  };
  const previousReceipt = {
    sha: previousReceiptSha,
    path: `spike-out/analysis-lab/launch/receipts/${previousReceiptSha}.json`,
    startedAt: new Date(BASE_TIME).toISOString(),
    finishedAt: new Date(previousFinishedAt).toISOString(),
    manifestSha256: manifestSha,
    grantSha256: grantSha,
    stopReason: "completed",
    outcome: "completed",
    summary: { held: 0, failed: 0, publishable: 1, skipped: 0 },
  };
  let time = previousFinishedAt;
  let current = fixture({
    now: time,
    manifestSha,
    grantSha,
    statusUpdatedAt: previousFinishedAt,
    statusTargets: [completedTarget],
    statusOverride: {
      lifecycle: "finished",
      finishedAt: new Date(previousFinishedAt).toISOString(),
      receiptSha256: previousReceiptSha,
    },
    receipts: [previousReceipt],
  });
  assert.equal(sanitizeSnapshot(current).launch.phase, "completed");
  const malformedCompleted = structuredClone(current);
  malformedCompleted.artifacts.statuses[0].summary.publishable = 0;
  assert.throws(
    () => sanitizeSnapshot(malformedCompleted),
    (error) => error instanceof MonitorInspectionError && error.component === "launch_status",
  );
  const first = await runPrecheck({ ...h, inspect: async () => current, now: () => time });
  await runPrecheck({ ...h, inspect: async () => current, now: () => time, ack: first.event.fingerprint });

  const retryStartedAt = previousFinishedAt + MINUTE;
  time = retryStartedAt;
  const retryTarget = {
    sequence: 0,
    grantId: "grant-0",
    status: "running",
    startedAt: new Date(retryStartedAt).toISOString(),
    finishedAt: null,
  };
  current = fixture({
    now: time,
    manifestSha,
    grantSha,
    ownerState: "completed",
    updatedAt: time,
    statusStartedAt: retryStartedAt,
    statusUpdatedAt: retryStartedAt,
    statusTargets: [retryTarget],
    receipts: [previousReceipt],
  });
  const retrySnapshot = sanitizeSnapshot(current);
  assert.equal(retrySnapshot.launch.phase, "granted");
  assert.equal(retrySnapshot.launch.status?.lifecycle, "running");
  assert.equal(retrySnapshot.launch.receipt, null);
  assert.equal(retrySnapshot.artifacts.receipts[0]?.sha, previousReceiptSha, "history is preserved");
  const ongoing = await runPrecheck({ ...h, inspect: async () => current, now: () => time });
  assert.equal(ongoing.exitCode, 3);
  assert.equal(ongoing.event.status, "healthy_progress");

  time += 2 * MINUTE;
  const nextReceipt = {
    ...previousReceipt,
    sha: nextReceiptSha,
    path: `spike-out/analysis-lab/launch/receipts/${nextReceiptSha}.json`,
    startedAt: new Date(retryStartedAt).toISOString(),
    finishedAt: new Date(time).toISOString(),
  };
  current = fixture({
    now: time,
    manifestSha,
    grantSha,
    ownerState: "completed",
    updatedAt: time,
    statusStartedAt: retryStartedAt,
    statusUpdatedAt: retryStartedAt,
    statusTargets: [retryTarget],
    receipts: [previousReceipt, nextReceipt],
  });
  const sealedSnapshot = sanitizeSnapshot(current);
  assert.equal(sealedSnapshot.launch.phase, "completed");
  assert.equal(sealedSnapshot.launch.receipt?.sha, nextReceiptSha);
  assert.equal(sealedSnapshot.launch.status, null);
  const sealed = await runPrecheck({ ...h, inspect: async () => current, now: () => time });
  assert.equal(sealed.exitCode, 0);
  assert(sealed.event.reasons.some((reason) => (
    reason.code === "terminal_receipt" && reason.path.endsWith(`${nextReceiptSha}.json`)
  )));
});

test("semantic launch status stalls once, ignores heartbeats, and recovers", async (t) => {
  const h = await harness(t);
  const manifestSha = "1".repeat(64);
  const grantSha = "2".repeat(64);
  let time = BASE_TIME;
  let targets = [
    {
      sequence: 0,
      grantId: "grant-0",
      status: "running",
      startedAt: new Date(BASE_TIME).toISOString(),
      finishedAt: null,
    },
    { sequence: 1, grantId: "grant-1", status: "pending", startedAt: null, finishedAt: null },
  ];
  const inspect = async () => fixture({
    now: time,
    manifestSha,
    grantSha,
    ownerState: "completed",
    statusUpdatedAt: time,
    statusTargets: targets,
  });

  const first = await runPrecheck({ ...h, inspect, now: () => time });
  await runPrecheck({ ...h, inspect, now: () => time, ack: first.event.fingerprint });

  time += 46 * MINUTE;
  const stale = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(stale.exitCode, 0);
  assert(
    stale.event.reasons.some(
      (reason) => reason.code === "launch_no_progress" && reason.outcome === "inspection_needed",
    ),
  );
  await runPrecheck({ ...h, inspect, now: () => time, ack: stale.event.fingerprint });

  time += 10 * MINUTE;
  const once = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(once.exitCode, 3);

  targets = [
    {
      sequence: 0,
      grantId: "grant-0",
      status: "publishable",
      startedAt: new Date(BASE_TIME).toISOString(),
      finishedAt: new Date(time).toISOString(),
    },
    {
      sequence: 1,
      grantId: "grant-1",
      status: "running",
      startedAt: new Date(time).toISOString(),
      finishedAt: null,
    },
  ];
  const recovery = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(recovery.exitCode, 3);
  assert.equal(recovery.event.status, "healthy_progress");

  time += 46 * MINUTE;
  const staleAgain = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(staleAgain.exitCode, 0);
  assert(staleAgain.event.reasons.some((reason) => reason.code === "launch_no_progress"));

  const fallback = await harness(t);
  time = BASE_TIME;
  const fallbackInspect = async () => fixture({
    now: time,
    manifestSha,
    grantSha,
    includeStatuses: false,
    updatedAt: BASE_TIME,
  });
  const fallbackFirst = await runPrecheck({
    ...fallback,
    inspect: fallbackInspect,
    now: () => time,
  });
  await runPrecheck({
    ...fallback,
    inspect: fallbackInspect,
    now: () => time,
    ack: fallbackFirst.event.fingerprint,
  });
  time += 46 * MINUTE;
  const fallbackStale = await runPrecheck({
    ...fallback,
    inspect: fallbackInspect,
    now: () => time,
  });
  assert(fallbackStale.event.reasons.some((reason) => reason.code === "owner_no_progress"));
});

test("running launch wins over a newer approved but unstarted grant", () => {
  const runningManifestSha = "1".repeat(64);
  const runningGrantSha = "2".repeat(64);
  const queuedManifestSha = "3".repeat(64);
  const queuedGrantSha = "4".repeat(64);
  const running = fixture({
    manifestSha: runningManifestSha,
    grantSha: runningGrantSha,
  });
  const queued = fixture({
    now: BASE_TIME + MINUTE,
    manifestSha: queuedManifestSha,
    grantSha: queuedGrantSha,
    statusOverride: null,
  });
  const mixed = {
    ...queued,
    artifacts: {
      manifests: [...queued.artifacts.manifests, ...running.artifacts.manifests],
      grants: [...queued.artifacts.grants, ...running.artifacts.grants],
      receipts: [],
      statuses: running.artifacts.statuses,
    },
  };

  const selected = sanitizeSnapshot(mixed);
  assert.equal(selected.launch.manifest?.sha, runningManifestSha);
  assert.equal(selected.launch.grant?.sha, runningGrantSha);
  assert.equal(selected.launch.status?.lifecycle, "running");
});

test("approved but unstarted grant is represented without a missing-status failure", async (t) => {
  const h = await harness(t);
  const snapshot = fixture({
    grantSha: "2".repeat(64),
    statusOverride: null,
  });
  const sanitized = sanitizeSnapshot(snapshot);
  assert.equal(sanitized.launch.phase, "granted");
  assert.equal(sanitized.launch.status, null);
  assert.equal(sanitized.launch.receipt, null);

  const result = await runPrecheck({ ...h, inspect: async () => snapshot, now: () => BASE_TIME });
  assert.equal(result.exitCode, 0);
  assert(result.event.reasons.some((reason) => reason.code === "initial_snapshot"));
  assert(!result.event.reasons.some((reason) => reason.code === "inspection_failure"));
});

test("malformed and drifted exact status fail closed", async (t) => {
  const cases = [
    {
      name: "malformed",
      statusOverride: { summary: { pending: 9 } },
      error: "malformed_or_drifted",
    },
    {
      name: "drifted",
      statusOverride: { manifestSha256: "9".repeat(64) },
      error: "malformed_or_drifted",
    },
  ];
  for (const item of cases) {
    const h = await harness(t);
    const snapshot = fixture({
      grantSha: "2".repeat(64),
      statusOverride: item.statusOverride,
    });
    const result = await runPrecheck({ ...h, inspect: async () => snapshot, now: () => BASE_TIME });
    assert.equal(result.exitCode, 0, item.name);
    assert(result.event.reasons.some((reason) => (
      reason.code === "inspection_failure"
      && reason.component === "launch_status"
      && reason.error === item.error
    )), item.name);
  }
});

test("monitor noise is ignored and inspection errors are deduplicated until recovery", async (t) => {
  const h = await harness(t);
  let time = BASE_TIME;
  let current = fixture({ now: time, noise: { monitorWrite: 1 } });
  let inspect = async () => current;

  const first = await runPrecheck({ ...h, inspect, now: () => time });
  await runPrecheck({ ...h, inspect, now: () => time, ack: first.event.fingerprint });

  current = fixture({ now: time, noise: { monitorWrite: 2 } });
  const noise = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(noise.exitCode, 3);

  inspect = async () => {
    throw new MonitorInspectionError("owner_list", "runtime_unavailable");
  };
  const failure = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(failure.exitCode, 0);
  assert(failure.event.reasons.some((reason) => reason.code === "inspection_failure"));
  await runPrecheck({ ...h, inspect, now: () => time, ack: failure.event.fingerprint });

  const duplicate = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(duplicate.exitCode, 3);
  assert.equal(duplicate.event.status, "inspection_unchanged");

  inspect = async () => current;
  const recovered = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(recovered.exitCode, 3);

  inspect = async () => {
    throw new MonitorInspectionError("owner_list", "runtime_unavailable");
  };
  const newEpisode = await runPrecheck({ ...h, inspect, now: () => time });
  assert.equal(newEpisode.exitCode, 0);
});
