#!/usr/bin/env node

/**
 * Model-free precheck for the Cunote launch monitor.
 *
 * Usage:
 *   node tools/analysis-monitor-precheck.mjs
 *   node tools/analysis-monitor-precheck.mjs --ack <fingerprint>
 *   node tools/analysis-monitor-precheck.mjs --owner-pane <tab-id>:<leaf-id>
 *
 * Exit 0 means a coordinator decision is needed. Exit 3 means the snapshot is
 * healthy/unchanged (or an event was acknowledged), so the automation skips an
 * LLM call. An unacknowledged event is retried at most once per 30 minutes.
 * While an exact launch status is running, target transitions own progress and
 * updatedAt alone is only a heartbeat. A receipt from the same-or-newer attempt
 * wins while older receipts remain history; status-less inspectors retain the
 * exact-pane owner fallback.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OWNER_PANE =
  "15511f7b-72a9-48fd-af4c-07142e575b69:59090f15-583b-4861-85e1-3e678f66a6ce";
const DEFAULT_WORKTREE =
  "id:c07cab20-417f-44e0-a67b-c66d2c04cb42::/Users/ffgg/noten.works/cunote";
const STATE_SCHEMA = "analysis-monitor-precheck-state-v1";
const EVENT_SCHEMA = "analysis-monitor-precheck-event-v1";
const SKIP_EXIT = 3;
const RETRY_MS = 30 * 60 * 1_000;
const STALE_MS = 45 * 60 * 1_000;
const MAX_ARTIFACT_BYTES = 128 * 1_024;
const MAX_RECEIPT_ARTIFACT_BYTES = 1 * 1_024 * 1_024;
const KEEP_LATEST_ARTIFACTS = 64;
const SHA256 = /^[a-f0-9]{64}$/;
const LAUNCH_TARGET_STATES = new Set([
  "pending",
  "running",
  "publishable",
  "held",
  "failed",
  "skipped",
]);

export class MonitorInspectionError extends Error {
  constructor(component, code) {
    super(`${component}:${code}`);
    this.name = "MonitorInspectionError";
    this.component = component;
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function finiteNumber(value, fallback = null) {
  return Number.isFinite(value) ? value : fallback;
}

function compactReceipt(receipt) {
  return {
    sha: String(receipt.sha),
    path: String(receipt.path),
    startedAt: receipt.startedAt ?? null,
    finishedAt: receipt.finishedAt ?? null,
    manifestSha256: receipt.manifestSha256 ?? null,
    grantSha256: receipt.grantSha256 ?? null,
    stopReason: receipt.stopReason ?? null,
    outcome: receipt.outcome ?? "completed",
    summary: {
      held: finiteNumber(receipt.summary?.held, 0),
      failed: finiteNumber(receipt.summary?.failed, 0),
      publishable: finiteNumber(receipt.summary?.publishable, 0),
      skipped: finiteNumber(receipt.summary?.skipped, 0),
    },
  };
}

function exactTimestamp(value, component) {
  const timestamp = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) throw new MonitorInspectionError(component, "malformed");
  return timestamp;
}

function compactLaunchStatus(status, manifest, grant) {
  if (
    status.schema !== "analysis-launch-status-v1"
    || status.authority !== "derived-monitoring-projection"
    || !["running", "finished"].includes(status.lifecycle)
    || !SHA256.test(String(status.sha))
    || status.sha !== String(grant?.sha)
    || status.grantSha256 !== String(grant?.sha)
    || status.manifestSha256 !== String(manifest?.sha)
    || !Array.isArray(status.targets)
    || !status.summary
    || typeof status.summary !== "object"
  ) {
    throw new MonitorInspectionError("launch_status", "malformed_or_drifted");
  }
  const seenSequences = new Set();
  const targets = status.targets.map((target) => {
    const sequence = target?.sequence;
    const targetStatus = target?.status;
    if (
      !Number.isSafeInteger(sequence)
      || sequence < 0
      || seenSequences.has(sequence)
      || typeof target?.grantId !== "string"
      || !LAUNCH_TARGET_STATES.has(targetStatus)
    ) {
      throw new MonitorInspectionError("launch_status", "malformed_or_drifted");
    }
    seenSequences.add(sequence);
    const startedAt = target.startedAt === null ? null : exactTimestamp(target.startedAt, "launch_status");
    const finishedAt = target.finishedAt === null ? null : exactTimestamp(target.finishedAt, "launch_status");
    if (
      (targetStatus === "pending" && (startedAt !== null || finishedAt !== null))
      || (targetStatus === "running" && (startedAt === null || finishedAt !== null))
      || (["publishable", "held", "failed", "skipped"].includes(targetStatus)
        && finishedAt === null)
    ) {
      throw new MonitorInspectionError("launch_status", "malformed_or_drifted");
    }
    return { sequence, grantId: target.grantId, status: targetStatus, startedAt, finishedAt };
  });
  const manifestTargets = Array.isArray(manifest?.targetBindings) ? manifest.targetBindings : null;
  if (
    (Number.isSafeInteger(grant?.targetCount) && grant.targetCount !== targets.length)
    || (manifestTargets && (
      manifestTargets.length !== targets.length
      || targets.some((target, index) => (
        manifestTargets[index]?.sequence !== target.sequence
        || manifestTargets[index]?.grantId !== target.grantId
      ))
    ))
  ) {
    throw new MonitorInspectionError("launch_status", "malformed_or_drifted");
  }
  const summary = {};
  for (const targetStatus of LAUNCH_TARGET_STATES) {
    const count = status.summary[targetStatus];
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || count !== targets.filter((target) => target.status === targetStatus).length
    ) {
      throw new MonitorInspectionError("launch_status", "malformed_or_drifted");
    }
    summary[targetStatus] = count;
  }
  const startedAt = exactTimestamp(status.startedAt, "launch_status");
  const updatedAt = exactTimestamp(status.updatedAt, "launch_status");
  const finishedAt = status.finishedAt === null
    ? null
    : exactTimestamp(status.finishedAt, "launch_status");
  const receiptSha256 = status.receiptSha256 === null ? null : String(status.receiptSha256);
  if (
    (status.lifecycle === "running" && (finishedAt !== null || receiptSha256 !== null))
    || (status.lifecycle === "finished" && (
      finishedAt === null
      || !SHA256.test(receiptSha256 ?? "")
      || targets.some((target) => ["pending", "running"].includes(target.status))
    ))
  ) {
    throw new MonitorInspectionError("launch_status", "malformed_or_drifted");
  }
  const progressAt = Math.max(
    startedAt,
    ...targets.flatMap((target) => [target.startedAt ?? 0, target.finishedAt ?? 0]),
  );
  const progressKey = sha256(stableJson({
    summary,
    targets: targets.map(({ sequence, status: targetStatus, startedAt: targetStartedAt, finishedAt }) => ({
      sequence,
      status: targetStatus,
      startedAt: targetStartedAt,
      finishedAt,
    })),
  }));
  return {
    path: String(status.path),
    lifecycle: status.lifecycle,
    startedAt,
    updatedAt,
    finishedAt,
    receiptSha256,
    progressAt,
    progressKey,
    summary,
    runningSequences: targets
      .filter((target) => target.status === "running")
      .map((target) => target.sequence),
  };
}

export function sanitizeSnapshot(snapshot) {
  const rawManifests = snapshot.artifacts?.manifests ?? [];
  const rawGrants = snapshot.artifacts?.grants ?? [];
  const manifests = rawManifests.map((item) => ({
    sha: String(item.sha),
    path: String(item.path),
    preparedAt: item.preparedAt ?? null,
  }));
  const grants = rawGrants.map((item) => ({
    sha: String(item.sha),
    path: String(item.path),
    approvedAt: item.approvedAt ?? null,
    manifestSha256: item.manifestSha256 ?? null,
  }));
  const receipts = (snapshot.artifacts?.receipts ?? []).map(compactReceipt);
  const rawStatuses = Array.isArray(snapshot.artifacts?.statuses)
    ? snapshot.artifacts.statuses
    : [];
  const matchingReceiptsFor = (manifestSha, grantSha = null) => receipts
    .filter((item) => (
      item.manifestSha256 === manifestSha
      && (!grantSha || item.grantSha256 === grantSha)
    ))
    .sort((left, right) => (
      exactTimestamp(right.finishedAt, "artifacts:receipts")
      - exactTimestamp(left.finishedAt, "artifacts:receipts")
    ));

  // 새 manifest/grant가 준비되어도 이미 실행 중인 exact launch의 관측을 빼앗지 않는다.
  // status가 receipt보다 오래된 동일-grant retry history면 active로 취급하지 않는다.
  const runningLaunches = rawStatuses.flatMap((rawStatus) => {
    if (rawStatus?.lifecycle !== "running") return [];
    const rawGrant = rawGrants.find((item) => String(item.sha) === String(rawStatus.sha));
    const rawManifest = rawManifests.find(
      (item) => String(item.sha) === String(rawGrant?.manifestSha256),
    );
    const observedStatus = compactLaunchStatus(rawStatus, rawManifest, rawGrant);
    const latestReceipt = matchingReceiptsFor(
      String(rawManifest?.sha),
      String(rawGrant?.sha),
    )[0] ?? null;
    const previousFinishedAt = latestReceipt
      ? exactTimestamp(latestReceipt.finishedAt, "artifacts:receipts")
      : null;
    if (previousFinishedAt !== null && observedStatus.startedAt <= previousFinishedAt) return [];
    return [{ rawManifest, rawGrant, observedStatus }];
  }).sort((left, right) => right.observedStatus.startedAt - left.observedStatus.startedAt);

  const running = runningLaunches[0] ?? null;
  const manifest = running
    ? manifests.find((item) => item.sha === String(running.rawManifest?.sha)) ?? null
    : manifests[0] ?? null;
  const grant = running
    ? grants.find((item) => item.sha === String(running.rawGrant?.sha)) ?? null
    : manifest
      ? grants.find((item) => item.manifestSha256 === manifest.sha) ?? null
      : null;
  const matchingReceipts = manifest
    ? matchingReceiptsFor(manifest.sha, grant?.sha ?? null)
    : [];
  let receipt = running ? null : matchingReceipts[0] ?? null;
  let status = null;
  if (running) {
    status = running.observedStatus;
  } else if (grant && rawStatuses.length > 0) {
    const rawStatus = rawStatuses.find((item) => String(item.sha) === grant.sha);
    // 승인 기록과 status 사이에는 정상적인 미착수 구간이 있다. status와 receipt가 둘 다
    // 없으면 granted/unstarted로 보존하고 owner/staleness 규칙이 후속을 판단한다.
    if (rawStatus) {
      const observedStatus = compactLaunchStatus(
        rawStatus,
        rawManifests.find((item) => String(item.sha) === manifest?.sha),
        rawGrants.find((item) => String(item.sha) === grant.sha),
      );
      if (observedStatus.lifecycle === "finished") {
        const sealedReceipt = matchingReceipts.find(
          (item) => item.sha === observedStatus.receiptSha256,
        );
        if (!sealedReceipt) {
          throw new MonitorInspectionError("launch_status", "terminal_receipt_missing");
        }
        receipt = sealedReceipt;
      } else {
        const previousFinishedAt = receipt
          ? exactTimestamp(receipt.finishedAt, "artifacts:receipts")
          : null;
        if (previousFinishedAt === null || observedStatus.startedAt > previousFinishedAt) {
          status = observedStatus;
          receipt = null;
        }
      }
    }
  }

  return {
    gitHead: String(snapshot.gitHead),
    observedAt: String(snapshot.observedAt),
    owner: {
      paneKey: String(snapshot.owner?.paneKey ?? ""),
      state: snapshot.owner?.state ?? "missing",
      updatedAt: finiteNumber(snapshot.owner?.updatedAt),
    },
    launch: {
      phase: receipt ? "completed" : grant ? "granted" : manifest ? "prepared" : "none",
      manifest,
      grant,
      receipt,
      status,
    },
    artifacts: { manifests, grants, receipts },
  };
}

function eventSnapshot(snapshot) {
  return {
    gitHead: snapshot.gitHead,
    launch: {
      phase: snapshot.launch.phase,
      manifest: snapshot.launch.manifest,
      grant: snapshot.launch.grant,
      receipt: snapshot.launch.receipt,
      status: snapshot.launch.status,
    },
    owner: snapshot.owner,
  };
}

function isOwnerIdle(snapshot, nowMs) {
  if (snapshot.launch.status?.lifecycle === "running") return false;
  if (snapshot.owner.state !== "running") return true;
  if (snapshot.launch.phase !== "granted") return true;
  const updatedAt = snapshot.owner.updatedAt;
  return updatedAt === null || nowMs - updatedAt >= STALE_MS;
}

function terminalReceiptReason(receipt) {
  return {
    code: "terminal_receipt",
    outcome: receipt.outcome,
    path: receipt.path,
    summary: receipt.summary,
  };
}

function mergeReasons(existing, additions) {
  const result = [...existing];
  for (const addition of additions) {
    const key = stableJson(addition);
    if (!result.some((item) => stableJson(item) === key)) result.push(addition);
  }
  return result;
}

function buildEvent({ reasons, snapshot, nowIso, priorPending = null }) {
  const mergedReasons = mergeReasons(priorPending?.event.reasons ?? [], reasons);
  const relevantPaths = [
    ...(priorPending?.event.relevantPaths ?? []),
    snapshot.launch.manifest?.path,
    snapshot.launch.grant?.path,
    snapshot.launch.receipt?.path,
    snapshot.launch.status?.path,
    ...mergedReasons.map((reason) => reason.path),
  ].filter(Boolean);
  const event = {
    schema: EVENT_SCHEMA,
    decisionRequired: true,
    observedAt: nowIso,
    reasons: mergedReasons,
    snapshot: eventSnapshot(snapshot),
    relevantPaths: [...new Set(relevantPaths)],
  };
  const fingerprint = sha256(stableJson(event));
  return { ...event, fingerprint };
}

function blankState() {
  return {
    schema: STATE_SCHEMA,
    observed: null,
    notifiedHead: null,
    notifiedManifest: null,
    seenReceipts: [],
    stale: null,
    inspectionError: null,
    pending: null,
    acknowledged: [],
  };
}

async function loadState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    if (parsed.schema !== STATE_SCHEMA) throw new Error("schema");
    return { ...blankState(), ...parsed };
  } catch (error) {
    if (error?.code === "ENOENT") return blankState();
    throw new MonitorInspectionError("state", "invalid");
  }
}

async function saveState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await rename(temporary, stateFile);
}

function inspectionKey(error) {
  const component = error instanceof MonitorInspectionError ? error.component : "unknown";
  const code = error instanceof MonitorInspectionError ? error.code : "failed";
  return { component, code, key: sha256(`${component}:${code}`) };
}

function updatePending(state, event, nowMs) {
  state.pending = {
    fingerprint: event.fingerprint,
    event,
    firstEmittedAt: state.pending?.firstEmittedAt ?? nowMs,
    lastEmittedAt: nowMs,
    attempts: (state.pending?.attempts ?? 0) + 1,
  };
}

function emitResult(emit, value) {
  emit(JSON.stringify(value));
}

export async function runPrecheck({
  inspect,
  stateFile,
  now = () => Date.now(),
  emit = (line) => process.stdout.write(`${line}\n`),
  ack = null,
}) {
  let state;
  try {
    state = await loadState(stateFile);
  } catch (error) {
    state = blankState();
    const failure = inspectionKey(error);
    state.inspectionError = failure;
    const snapshot = sanitizeSnapshot({
      gitHead: "unavailable",
      observedAt: new Date(now()).toISOString(),
      owner: { state: "missing" },
      artifacts: {},
    });
    const event = buildEvent({
      reasons: [{ code: "inspection_failure", component: failure.component, error: failure.code }],
      snapshot,
      nowIso: snapshot.observedAt,
    });
    updatePending(state, event, now());
    await saveState(stateFile, state);
    emitResult(emit, event);
    return { exitCode: 0, event };
  }

  if (ack) {
    const matched = state.pending?.fingerprint === ack;
    const already = state.acknowledged.includes(ack);
    if (matched) {
      state.pending = null;
      state.acknowledged = [...state.acknowledged, ack].slice(-32);
      await saveState(stateFile, state);
    }
    const result = {
      schema: EVENT_SCHEMA,
      decisionRequired: false,
      status: matched ? "acknowledged" : already ? "already_acknowledged" : "ack_not_found",
      fingerprint: ack,
    };
    emitResult(emit, result);
    return { exitCode: SKIP_EXIT, event: result };
  }

  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();
  let snapshot;
  let reasons = [];

  try {
    snapshot = sanitizeSnapshot(await inspect(nowMs));
    state.inspectionError = null;
  } catch (error) {
    const failure = inspectionKey(error);
    if (state.inspectionError?.key !== failure.key) {
      state.inspectionError = failure;
      const fallback =
        state.observed ??
        sanitizeSnapshot({
          gitHead: "unavailable",
          observedAt: nowIso,
          owner: { state: "missing" },
          artifacts: {},
        });
      const event = buildEvent({
        reasons: [{ code: "inspection_failure", component: failure.component, error: failure.code }],
        snapshot: fallback,
        nowIso,
        priorPending: state.pending,
      });
      updatePending(state, event, nowMs);
      await saveState(stateFile, state);
      emitResult(emit, event);
      return { exitCode: 0, event };
    }
    return finishWithoutNewEvent({ state, stateFile, nowMs, emit, status: "inspection_unchanged" });
  }

  if (!state.observed) {
    reasons.push({ code: "initial_snapshot" });
    state.notifiedHead = snapshot.gitHead;
    state.notifiedManifest = snapshot.launch.manifest?.sha ?? null;
    state.seenReceipts = snapshot.artifacts.receipts.map((item) => item.sha);
  } else {
    const previousOwner = state.observed.owner.state;
    if (
      snapshot.launch.status?.lifecycle !== "running" &&
      previousOwner === "running" &&
      ["completed", "error", "missing"].includes(snapshot.owner.state)
    ) {
      reasons.push({
        code:
          snapshot.owner.state === "error"
            ? "owner_error"
            : snapshot.owner.state === "completed"
              ? "owner_completed"
              : "owner_disappeared",
      });
    }

    const seen = new Set(state.seenReceipts);
    const newReceipts = snapshot.artifacts.receipts.filter((item) => !seen.has(item.sha));
    reasons.push(...newReceipts.map(terminalReceiptReason));
    state.seenReceipts = [
      ...new Set([...snapshot.artifacts.receipts.map((item) => item.sha), ...state.seenReceipts]),
    ].slice(0, KEEP_LATEST_ARTIFACTS);

    if (isOwnerIdle(snapshot, nowMs)) {
      const manifestSha = snapshot.launch.manifest?.sha ?? null;
      if (manifestSha !== state.notifiedManifest) {
        reasons.push({ code: "prepared_manifest_changed", path: snapshot.launch.manifest?.path ?? null });
        state.notifiedManifest = manifestSha;
      }
      if (snapshot.gitHead !== state.notifiedHead) {
        reasons.push({ code: "source_changed", gitHead: snapshot.gitHead });
        state.notifiedHead = snapshot.gitHead;
      }
    }
  }

  const launchKey =
    snapshot.launch.phase === "granted"
      ? `${snapshot.launch.manifest?.sha}:${snapshot.launch.grant?.sha}`
      : null;
  if (launchKey && snapshot.launch.status?.lifecycle === "running") {
    const progressAt = Math.max(
      snapshot.launch.status.progressAt ?? 0,
      Date.parse(snapshot.launch.grant?.approvedAt ?? "") || 0,
    );
    if (state.stale?.launchKey !== launchKey) {
      state.stale = {
        launchKey,
        progressKey: snapshot.launch.status.progressKey,
        lastProgressAt: progressAt,
        alerted: false,
      };
    } else if (state.stale.progressKey !== snapshot.launch.status.progressKey) {
      state.stale = {
        launchKey,
        progressKey: snapshot.launch.status.progressKey,
        lastProgressAt: progressAt,
        alerted: false,
      };
    }
    if (!state.stale.alerted && nowMs - state.stale.lastProgressAt >= STALE_MS) {
      reasons.push({ code: "launch_no_progress", outcome: "inspection_needed", minutes: 45 });
      state.stale.alerted = true;
    }
  } else if (launchKey && snapshot.owner.state === "running") {
    const progressAt = Math.max(
      snapshot.owner.updatedAt ?? 0,
      Date.parse(snapshot.launch.grant?.approvedAt ?? "") || 0,
    );
    if (state.stale?.launchKey !== launchKey) {
      state.stale = { launchKey, lastProgressAt: progressAt, alerted: false };
    } else if (progressAt > state.stale.lastProgressAt) {
      state.stale = { launchKey, lastProgressAt: progressAt, alerted: false };
    }
    if (!state.stale.alerted && nowMs - state.stale.lastProgressAt >= STALE_MS) {
      reasons.push({ code: "owner_no_progress", outcome: "inspection_needed", minutes: 45 });
      state.stale.alerted = true;
    }
  } else {
    state.stale = null;
  }

  const healthyProgress =
    snapshot.launch.phase === "granted" && (
      snapshot.launch.status?.lifecycle === "running"
        ? snapshot.launch.status.progressKey !== state.observed?.launch?.status?.progressKey
        : snapshot.owner.state === "running"
          && snapshot.owner.updatedAt !== state.observed?.owner.updatedAt
    );
  state.observed = snapshot;
  if (reasons.length > 0) {
    const event = buildEvent({ reasons, snapshot, nowIso, priorPending: state.pending });
    updatePending(state, event, nowMs);
    await saveState(stateFile, state);
    emitResult(emit, event);
    return { exitCode: 0, event };
  }

  return finishWithoutNewEvent({
    state,
    stateFile,
    nowMs,
    emit,
    status: healthyProgress ? "healthy_progress" : "unchanged",
  });
}

async function finishWithoutNewEvent({ state, stateFile, nowMs, emit, status }) {
  if (state.pending && nowMs - state.pending.lastEmittedAt >= RETRY_MS) {
    state.pending.lastEmittedAt = nowMs;
    state.pending.attempts += 1;
    state.pending.event.observedAt = new Date(nowMs).toISOString();
    await saveState(stateFile, state);
    emitResult(emit, state.pending.event);
    return { exitCode: 0, event: state.pending.event };
  }
  await saveState(stateFile, state);
  const result = {
    schema: EVENT_SCHEMA,
    decisionRequired: false,
    status: state.pending ? "pending_backoff" : status,
    pendingFingerprint: state.pending?.fingerprint ?? null,
  };
  emitResult(emit, result);
  return { exitCode: SKIP_EXIT, event: result };
}

function runJson(command, args, component, acceptedError = null) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 512 * 1_024 });
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new MonitorInspectionError(component, result.error?.code ?? "invalid_json");
  }
  if (!parsed.ok && !acceptedError?.(parsed.error)) {
    throw new MonitorInspectionError(component, parsed.error?.code ?? "failed");
  }
  return parsed;
}

function gitDirectory(cwd) {
  const dotGit = path.join(cwd, ".git");
  const details = statSync(dotGit);
  if (details.isDirectory()) return dotGit;
  if (!details.isFile()) throw new Error("unsupported .git entry");
  const match = /^gitdir:\s*(.+)$/iu.exec(readFileSync(dotGit, "utf8").trim());
  if (!match) throw new Error("malformed .git file");
  return path.resolve(cwd, match[1]);
}

function validGitRef(ref) {
  return (
    ref.startsWith("refs/")
    && !ref.includes("\\")
    && !ref.includes("\0")
    && ref.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  );
}

function packedRef(commonDirectory, ref) {
  const packedRefs = path.join(commonDirectory, "packed-refs");
  if (!existsSync(packedRefs)) return null;
  for (const line of readFileSync(packedRefs, "utf8").split(/\r?\n/u)) {
    if (line.startsWith("#") || line.startsWith("^") || !line.endsWith(` ${ref}`)) continue;
    const objectId = line.slice(0, line.indexOf(" "));
    if (/^[a-f0-9]{40}$/u.test(objectId)) return objectId;
  }
  return null;
}

export function readGitHeadFromMetadata(cwd) {
  const directory = gitDirectory(cwd);
  const commonDirectoryFile = path.join(directory, "commondir");
  const commonDirectory = existsSync(commonDirectoryFile)
    ? path.resolve(directory, readFileSync(commonDirectoryFile, "utf8").trim())
    : directory;
  let value = readFileSync(path.join(directory, "HEAD"), "utf8").trim();
  const seen = new Set();

  for (let depth = 0; depth < 8; depth += 1) {
    if (/^[a-f0-9]{40}$/u.test(value)) return value;
    const match = /^ref:\s*(.+)$/u.exec(value);
    const ref = match?.[1];
    if (!ref || !validGitRef(ref) || seen.has(ref)) break;
    seen.add(ref);
    const localRef = path.join(directory, ref);
    const commonRef = path.join(commonDirectory, ref);
    if (existsSync(localRef)) value = readFileSync(localRef, "utf8").trim();
    else if (existsSync(commonRef)) value = readFileSync(commonRef, "utf8").trim();
    else {
      const packed = packedRef(commonDirectory, ref);
      if (packed) return packed;
      break;
    }
  }
  throw new Error("HEAD metadata unavailable");
}

export function gitHead(cwd, run = spawnSync) {
  const result = run("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const head = String(result.stdout ?? "").trim();
  if (result.status === 0 && /^[a-f0-9]{40}$/u.test(head)) return head;
  try {
    return readGitHeadFromMetadata(cwd);
  } catch {
    throw new MonitorInspectionError("git", "head_unavailable");
  }
}

async function readBoundedJson(file, component) {
  const details = await stat(file);
  if (details.size > artifactByteLimit(component)) {
    throw new MonitorInspectionError(component, "artifact_too_large");
  }
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new MonitorInspectionError(component, "invalid_json");
  }
}

export function artifactByteLimit(component) {
  return component === "artifacts:receipts"
    ? MAX_RECEIPT_ARTIFACT_BYTES
    : MAX_ARTIFACT_BYTES;
}

async function latestArtifacts(cwd, kind) {
  const directory = path.join(cwd, "spike-out/analysis-lab/launch", kind);
  try {
    await access(directory, fsConstants.R_OK);
  } catch {
    return [];
  }
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const files = await Promise.all(
    names.map(async (name) => {
      const absolute = path.join(directory, name);
      const details = await stat(absolute);
      return { absolute, name, mtimeMs: details.mtimeMs };
    }),
  );
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const latest = files.slice(0, KEEP_LATEST_ARTIFACTS);
  return Promise.all(
    latest.map(async (file) => {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) {
        throw new MonitorInspectionError(`artifacts:${kind}`, "unexpected_filename");
      }
      const json = await readBoundedJson(file.absolute, `artifacts:${kind}`);
      return {
        json,
        sha: file.name.slice(0, -5),
        path: path.relative(cwd, file.absolute),
        mtimeMs: file.mtimeMs,
      };
    }),
  );
}

function receiptOutcome(json) {
  const summary = json.summary ?? {};
  const targetValues = (json.targets ?? []).flatMap((target) => [
    target.status,
    target.targetDisposition,
    target.cohortVerdict,
  ]);
  const values = [json.cohortVerdict, json.stopReason, ...targetValues]
    .filter(Boolean)
    .map((value) => String(value).toUpperCase());
  if (json.systemicFailure || values.some((value) => value === "STOP" || value.includes("ERROR"))) {
    return "stop";
  }
  if (Number(summary.failed ?? 0) > 0 || values.includes("FAILED")) return "failed";
  if (Number(summary.held ?? 0) > 0 || values.includes("HELD")) return "held";
  return "completed";
}

async function inspectArtifacts(cwd) {
  const [manifestFiles, grantFiles, receiptFiles] = await Promise.all([
    latestArtifacts(cwd, "manifests"),
    latestArtifacts(cwd, "grants"),
    latestArtifacts(cwd, "receipts"),
  ]);
  const statuses = (await Promise.all(grantFiles.map(async (grantFile) => {
    const absolute = path.join(
      cwd,
      "spike-out/analysis-lab/launch/status",
      `${grantFile.sha}.json`,
    );
    try {
      const json = await readBoundedJson(absolute, "launch_status");
      return {
        ...json,
        sha: grantFile.sha,
        path: path.relative(cwd, absolute),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return null;
    }
  }))).filter(Boolean);
  return {
    manifests: manifestFiles.map(({ json, sha, path: relativePath }) => ({
      sha,
      path: relativePath,
      preparedAt: json.preparedAt ?? null,
      targetBindings: Array.isArray(json.targets)
        ? json.targets.map((target) => ({ sequence: target.sequence, grantId: target.grantId }))
        : null,
    })),
    grants: grantFiles.map(({ json, sha, path: relativePath }) => ({
      sha,
      path: relativePath,
      approvedAt: json.approvedAt ?? null,
      manifestSha256: json.manifestSha256 ?? null,
      targetCount: json.targetCount,
    })),
    receipts: receiptFiles.map(({ json, sha, path: relativePath }) => ({
      sha,
      path: relativePath,
      finishedAt: json.finishedAt ?? null,
      startedAt: json.startedAt ?? null,
      manifestSha256: json.manifestSha256 ?? null,
      grantSha256: json.grantSha256 ?? null,
      stopReason: json.stopReason ?? null,
      outcome: receiptOutcome(json),
      summary: json.summary ?? {},
    })),
    statuses,
  };
}

function resolveOrcaCommand(env) {
  if (env.ORCA_CLI_COMMAND) return env.ORCA_CLI_COMMAND;
  if (env.ORCA_DEV_REPO_ROOT) return "orca-dev";
  return process.platform === "linux" ? "orca-ide" : "orca";
}

function parsePaneKey(paneKey) {
  const match = /^([^:]+):([^:]+)$/.exec(paneKey);
  if (!match) throw new MonitorInspectionError("owner", "invalid_pane_key");
  return { tabId: match[1], leafId: match[2] };
}

function inspectOwner({ command, worktree, paneKey }) {
  parsePaneKey(paneKey);
  const listed = runJson(
    command,
    ["worktree", "ps", "--json"],
    "owner_ps",
  );
  const worktreeId = worktree.replace(/^id:/, "");
  const exactWorktree = (listed.result?.worktrees ?? []).find(
    (item) => item.worktreeId === worktreeId,
  );
  if (!exactWorktree) {
    if (listed.result?.truncated) throw new MonitorInspectionError("owner_ps", "truncated");
    return { paneKey, state: "missing", updatedAt: null };
  }
  const agent = (exactWorktree.agents ?? []).find(
    (item) => item.paneKey === paneKey,
  );
  if (!agent) return { paneKey, state: "missing", updatedAt: null };
  const rawState = String(agent.state ?? "unknown").toLowerCase();
  const state =
    rawState === "working"
      ? "running"
      : rawState === "done"
        ? "completed"
        : agent.interrupted || ["error", "failed", "crashed"].includes(rawState)
          ? "error"
          : "waiting";
  return {
    paneKey,
    state,
    updatedAt: finiteNumber(agent.updatedAt ?? agent.stateStartedAt),
  };
}

export function createLiveInspector({ cwd, ownerPane, worktree, env = process.env }) {
  const orcaCommand = resolveOrcaCommand(env);
  return async (nowMs) => ({
    gitHead: gitHead(cwd),
    observedAt: new Date(nowMs).toISOString(),
    owner: inspectOwner({ command: orcaCommand, worktree, paneKey: ownerPane }),
    artifacts: await inspectArtifacts(cwd),
  });
}

function parseArgs(argv) {
  const options = { ack: null, ownerPane: null, worktree: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") options.help = true;
    else if (argument === "--ack") options.ack = argv[++index];
    else if (argument === "--owner-pane") options.ownerPane = argv[++index];
    else if (argument === "--worktree") options.worktree = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.ack && !/^[a-f0-9]{64}$/.test(options.ack)) throw new Error("invalid --ack");
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 64;
  }
  if (options.help) {
    process.stdout.write(
      "node tools/analysis-monitor-precheck.mjs [--owner-pane <tab-id>:<leaf-id>] [--worktree <selector>] [--ack <fingerprint>]\n",
    );
    return SKIP_EXIT;
  }
  const cwd = process.cwd();
  const ownerPane =
    options.ownerPane ?? process.env.ANALYSIS_MONITOR_OWNER_PANE ?? DEFAULT_OWNER_PANE;
  const worktree =
    options.worktree ?? process.env.ANALYSIS_MONITOR_WORKTREE ?? DEFAULT_WORKTREE;
  const stateFile = path.join(cwd, "spike-out/analysis-monitor/precheck-state-v1.json");
  const result = await runPrecheck({
    inspect: createLiveInspector({ cwd, ownerPane, worktree }),
    stateFile,
    ack: options.ack,
  });
  return result.exitCode;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
