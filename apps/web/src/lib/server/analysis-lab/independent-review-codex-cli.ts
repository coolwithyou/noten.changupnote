import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL,
  INDEPENDENT_REVIEW_RESULT_SCHEMA,
  INDEPENDENT_REVIEW_MANIFEST_SCHEMA,
  LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA,
  buildIndependentReviewCodexStdin,
  reviewResultRoot,
  validateAndWrapIndependentReviewResult,
  writeIndependentReviewResult,
} from "./independent-review-packet";
import { assertDurableAnalysisArtifactPath, findMonorepoRoot } from "./run-store";

interface ManifestPacket {
  sequence: number;
  path: string;
  sha256: string;
}

interface ReviewManifest {
  schema: typeof INDEPENDENT_REVIEW_MANIFEST_SCHEMA | typeof LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA;
  reviewers: Array<{ reviewer: string; transport: string; model: string }>;
  packets: ManifestPacket[];
}

const MAX_PACKET_ATTEMPTS = 2;
const TERMINATION_GRACE_MS = 5_000;
const DEFAULT_STALL_TIMEOUT_MS = 180_000;

interface PacketOutcome {
  sequence: number;
  status: "completed" | "existing";
  attempts?: number;
}

class UnterminatedProcessTreeError extends Error {}
class PacketBindingError extends Error {}
class AttemptEvidencePersistenceError extends Error {}
class SupervisorInterruptedError extends Error {
  constructor(
    message: string,
    public readonly treeTerminated: boolean,
  ) {
    super(message);
  }
}

interface ActiveOwnedProcess {
  pid: number;
  processGroup: boolean;
  terminationGraceMs: number;
  interruptedSignal: NodeJS.Signals | null;
}

const activeOwnedProcesses = new Map<number, ActiveOwnedProcess>();
let shutdownSignal: NodeJS.Signals | null = null;

export interface SupervisedCommandResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutKind: "hard" | "stall" | null;
  forcedKill: boolean;
  descendantCleanupRequired: boolean;
  treeTerminated: boolean;
  interruptedSignal: NodeJS.Signals | null;
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const removeShutdownHandlers = installShutdownHandlers();
  try {
  const root = findMonorepoRoot();
  const manifestArg = option("manifest");
  if (!manifestArg) throw new Error("--manifest=<absolute-or-repo-relative-path>가 필요합니다.");
  const manifestPath = resolve(root, manifestArg);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReviewManifest;
  if (
    manifest.schema !== INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    && manifest.schema !== LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA
  ) throw new Error("독립 검수 manifest 형식이 아닙니다.");
  const addressedSha = basename(manifestPath).replace(/\.manifest\.json$/, "");
  if (sha256(manifestBytes) !== addressedSha) throw new Error("manifest content address가 일치하지 않습니다.");
  const reviewerModel = resolveCodexReviewModel(manifest, option("model"));
  const outputDir = reviewResultRoot(manifestPath, addressedSha, manifest.schema);
  assertDurableAnalysisArtifactPath(outputDir);

  const authStatus = await runCommand("codex", ["login", "status"], root);
  if (authStatus.code !== 0 || !`${authStatus.stdout}\n${authStatus.stderr}`.includes("Logged in using ChatGPT")) {
    throw new Error("Codex가 ChatGPT 구독 인증 상태가 아닙니다.");
  }
  const version = await runCommand("codex", ["--version"], root);
  if (version.code !== 0) throw new Error("Codex 버전을 확인하지 못했습니다.");
  const rawDir = join(outputDir, "codex", "raw");
  const resultDir = join(outputDir, "codex", "results");
  const schemaDir = join(outputDir, "codex", "schemas");
  const logDir = join(outputDir, "codex", "logs");
  const lockDir = join(outputDir, "codex", "locks");
  const progressPath = join(outputDir, "codex", "progress.jsonl");
  await Promise.all([rawDir, resultDir, schemaDir, logDir, lockDir].map((path) => mkdir(path, { recursive: true })));

  const concurrency = parsePositiveInteger(option("concurrency")) ?? 2;
  const timeoutMs = parsePositiveInteger(option("timeout-ms")) ?? 1_200_000;
  const stallTimeoutMs = parsePositiveInteger(option("stall-timeout-ms")) ?? DEFAULT_STALL_TIMEOUT_MS;
  const requestedSequences = parseSequenceSet(option("sequences"));
  const pending = [...manifest.packets]
    .filter((packet) => requestedSequences === null || requestedSequences.has(packet.sequence))
    .sort((a, b) => a.sequence - b.sequence);
  if (pending.length === 0) throw new Error("실행할 packet이 없습니다.");
  const outcomes: Array<{ sequence: number; status: "completed" | "existing" | "failed"; error?: string }> = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length && shutdownSignal === null) {
      const packet = pending[cursor++]!;
      try {
        outcomes.push(await runPacket({
          root,
          packet,
          rawDir,
          resultDir,
          schemaDir,
          logDir,
          lockDir,
          progressPath,
          reviewerModel,
          timeoutMs,
          stallTimeoutMs,
        }));
      } catch (error) {
        outcomes.push({
          sequence: packet.sequence,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  outcomes.sort((a, b) => a.sequence - b.sequence);
  console.log(JSON.stringify({
    manifestSha256: addressedSha,
    codexVersion: version.stdout.trim(),
    reviewerModel,
    timeoutMs,
    stallTimeoutMs,
    maxPacketAttempts: MAX_PACKET_ATTEMPTS,
    completed: outcomes.filter((item) => item.status === "completed").length,
    existing: outcomes.filter((item) => item.status === "existing").length,
    failed: outcomes.filter((item) => item.status === "failed"),
  }, null, 2));
  if (outcomes.some((item) => item.status === "failed")) process.exitCode = 1;
  } finally {
    removeShutdownHandlers();
  }
}

export function resolveCodexReviewModel(
  manifest: Pick<ReviewManifest, "reviewers">,
  requestedModel: string | null,
): string {
  const codexReviewers = manifest.reviewers?.filter((item) => item.reviewer === "codex") ?? [];
  if (
    codexReviewers.length !== 1
    || codexReviewers[0]?.transport !== "codex-cli"
    || !codexReviewers[0]?.model?.trim()
  ) {
    throw new Error("manifest의 Codex reviewer 모델 결속이 유효하지 않습니다.");
  }
  const model = requestedModel ?? DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL;
  if (!model.trim() || model !== codexReviewers[0].model) {
    throw new Error(`Codex 검수 모델은 manifest의 ${codexReviewers[0].model}과 같아야 합니다. 역사 manifest 재개 시 --model=${codexReviewers[0].model}을 지정하세요.`);
  }
  return model;
}

export async function runPacket(options: {
  root: string;
  packet: ManifestPacket;
  rawDir: string;
  resultDir: string;
  schemaDir: string;
  logDir: string;
  lockDir: string;
  progressPath: string;
  reviewerModel: string;
  timeoutMs: number;
  stallTimeoutMs: number;
}): Promise<PacketOutcome> {
  const label = `sequence-${String(options.packet.sequence).padStart(2, "0")}`;
  const packetPath = resolve(options.root, options.packet.path);
  const packetBytes = await readAndVerifyPacket(packetPath, options.packet.sha256, label);
  const packet = JSON.parse(packetBytes.toString("utf8")) as {
    outputSchema: Record<string, unknown>;
    systemPrompt: string;
    userMessage: string;
  };
  const canonicalRawPath = join(options.rawDir, `${label}.json`);
  const resultPath = join(options.resultDir, `${label}.json`);
  const schemaPath = join(options.schemaDir, `${label}.codex.schema.json`);
  if (existsSync(resultPath)) {
    await assertReusableCompletedResult(resultPath, {
      packetSha256: options.packet.sha256,
      sequence: options.packet.sequence,
      reviewerModel: options.reviewerModel,
    });
    await writeProgress(options.progressPath, {
      event: "target_reused",
      sequence: options.packet.sequence,
      packetSha256: options.packet.sha256,
    });
    return { sequence: options.packet.sequence, status: "existing" };
  }
  const releaseLock = await acquirePacketExecutionLock({
    lockPath: join(options.lockDir, `${label}.lock`),
    packetSha256: options.packet.sha256,
  });
  let preserveLock = false;
  try {
    // 다른 invocation이 lock 대기 전 완료했을 수 있다. 결속이 맞는 완료본이면 모델을 다시 부르지 않는다.
    if (existsSync(resultPath)) {
      await assertReusableCompletedResult(resultPath, {
        packetSha256: options.packet.sha256,
        sequence: options.packet.sequence,
        reviewerModel: options.reviewerModel,
      });
      await writeProgress(options.progressPath, {
        event: "target_reused",
        sequence: options.packet.sequence,
        packetSha256: options.packet.sha256,
      });
      return { sequence: options.packet.sequence, status: "existing" };
    }
    return await executePacketAttempts({
      ...options,
      label,
      packetPath,
      parsedPacket: packet,
      canonicalRawPath,
      resultPath,
      schemaPath,
    });
  } catch (error) {
    preserveLock = error instanceof UnterminatedProcessTreeError
      || (error instanceof SupervisorInterruptedError && !error.treeTerminated);
    throw error;
  } finally {
    if (!preserveLock) await releaseLock();
  }
}

async function executePacketAttempts(options: {
  root: string;
  packet: ManifestPacket;
  rawDir: string;
  resultDir: string;
  schemaDir: string;
  logDir: string;
  lockDir: string;
  progressPath: string;
  reviewerModel: string;
  timeoutMs: number;
  stallTimeoutMs: number;
  label: string;
  packetPath: string;
  parsedPacket: {
    outputSchema: Record<string, unknown>;
    systemPrompt: string;
    userMessage: string;
  };
  canonicalRawPath: string;
  resultPath: string;
  schemaPath: string;
}): Promise<PacketOutcome> {
  const codexOutputSchema = requireEveryObjectProperty(options.parsedPacket.outputSchema);
  await writeFile(options.schemaPath, `${JSON.stringify(codexOutputSchema)}\n`, { flag: "wx" }).catch(async (error: unknown) => {
    const current = await readFile(options.schemaPath).catch(() => null);
    const expected = Buffer.from(`${JSON.stringify(codexOutputSchema)}\n`, "utf8");
    if (!current || !current.equals(expected)) throw error;
  });

  const instruction = [
    "이 작업은 코드 리뷰가 아니라 정부지원사업 분석 결과의 블라인드 데이터 품질 검수다.",
    "stdin의 [검수 규칙]을 먼저 적용하고 [공고별 검수 입력]의 원문과 추출 조건만 대조하라.",
    "stdin 밖의 파일이나 다른 리뷰 결과, Codex/Grok 산출물, 사람 판정은 읽지 마라.",
    "지정된 출력 schema를 만족하는 JSON 객체 하나만 최종 응답으로 반환하라.",
    "note가 필요 없는 correct 또는 confirmed_absent 항목도 JSON schema 충족을 위해 note를 빈 문자열로 넣어라.",
    "파일을 수정하거나 DB·배포·네트워크 작업을 하지 마라.",
  ].join("\n");
  const stdin = buildIndependentReviewCodexStdin(options.parsedPacket);
  const childEnv = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) {
    delete childEnv[key];
  }
  await writeProgress(options.progressPath, {
    event: "target_started",
    sequence: options.packet.sequence,
    packetSha256: options.packet.sha256,
    maxAttempts: MAX_PACKET_ATTEMPTS,
  });
  let finalResult: Awaited<ReturnType<typeof validateAndWrapIndependentReviewResult>> | null = null;
  let finalRawPath: string | null = null;
  let finalError: unknown = null;
  let completedAttempt = 0;
  for (let attempt = 1; attempt <= MAX_PACKET_ATTEMPTS; attempt += 1) {
    // packet bytes가 준비 이후 바뀌면 재시도를 포함해 어떤 모델 호출도 시작하지 않는다.
    await readAndVerifyPacket(options.packetPath, options.packet.sha256, options.label);
    const attemptId = `${String(attempt).padStart(2, "0")}-${Date.now()}`;
    const attemptRawPath = join(options.rawDir, `${options.label}-attempt-${attemptId}.json`);
    const attemptLogPath = join(options.logDir, `${options.label}-attempt-${attemptId}.jsonl`);
    const attemptStderrPath = join(options.logDir, `${options.label}-attempt-${attemptId}.stderr.log`);
    await Promise.all([
      writeFile(attemptLogPath, "", { flag: "wx" }),
      writeFile(attemptStderrPath, "", { flag: "wx" }),
    ]);
    await writeProgress(options.progressPath, {
      event: "attempt_started",
      sequence: options.packet.sequence,
      packetSha256: options.packet.sha256,
      attempt,
    });
    try {
      let modelEventCount = 0;
      const progressWrites: Array<Promise<void>> = [];
      let stdoutWrites = Promise.resolve();
      let stderrWrites = Promise.resolve();
      const command = await runCommand("codex", [
        "exec",
        "--ignore-user-config",
        "--ephemeral",
        "--sandbox", "read-only",
        "--model", options.reviewerModel,
        "--output-schema", options.schemaPath,
        "--output-last-message", attemptRawPath,
        "--json",
        "--cd", options.root,
        instruction,
      ], options.root, childEnv, options.timeoutMs, {
        stdin,
        stallTimeoutMs: options.stallTimeoutMs,
        onStdoutChunk: (chunk) => {
          stdoutWrites = stdoutWrites.then(() => appendFile(attemptLogPath, chunk, { encoding: "utf8" }));
        },
        onStderrChunk: (chunk) => {
          stderrWrites = stderrWrites.then(() => appendFile(attemptStderrPath, chunk, { encoding: "utf8" }));
        },
        onStdoutLine: (line) => {
          modelEventCount += 1;
          if (modelEventCount !== 1 && modelEventCount % 10 !== 0) return;
          progressWrites.push(writeProgress(options.progressPath, {
            event: "model_progress",
            sequence: options.packet.sequence,
            packetSha256: options.packet.sha256,
            attempt,
            modelEventCount,
            modelEventType: readModelEventType(line),
          }));
        },
      });
      const evidenceWrites = await Promise.allSettled([stdoutWrites, stderrWrites, ...progressWrites]);
      if (!command.treeTerminated) {
        throw new UnterminatedProcessTreeError(`${options.label} Codex process group 종료를 확인하지 못했습니다.`);
      }
      const failedEvidenceWrite = evidenceWrites.find((item) => item.status === "rejected");
      if (failedEvidenceWrite?.status === "rejected") {
        throw new AttemptEvidencePersistenceError(
          `${options.label} attempt 로그 저장 실패: ${String(failedEvidenceWrite.reason)}`,
        );
      }
      if (command.interruptedSignal) {
        throw new SupervisorInterruptedError(
          `${options.label} Codex 검수가 ${command.interruptedSignal} 중단 요청으로 종료됐습니다.`,
          command.treeTerminated,
        );
      }
      if (command.timedOut) {
        throw new Error(
          `${options.label} Codex ${command.timeoutKind === "stall" ? "진행 정체" : "hard"} 타임아웃(`
          + `${command.timeoutKind === "stall" ? options.stallTimeoutMs : options.timeoutMs}ms, `
          + `${command.forcedKill ? "SIGTERM→SIGKILL" : "SIGTERM"} 후 child 종료 확인)`,
        );
      }
      if (command.code !== 0) {
        throw new Error(`${options.label} Codex 종료 코드 ${command.code}: ${command.stderr.slice(-600)}`);
      }
      await readAndVerifyPacket(options.packetPath, options.packet.sha256, options.label);
      finalResult = await validateAndWrapIndependentReviewResult({
        packetPath: options.packetPath,
        rawResultPath: attemptRawPath,
        reviewer: "codex",
        reviewerModel: options.reviewerModel,
        reviewerTransport: "codex-cli",
      });
      await readAndVerifyPacket(options.packetPath, options.packet.sha256, options.label);
      if (!reusableCompletedResultMatches(finalResult, {
        packetSha256: options.packet.sha256,
        sequence: options.packet.sequence,
        reviewerModel: options.reviewerModel,
      })) {
        throw new PacketBindingError(`${options.label} 검수 결과의 packet/model/sequence 결속이 다릅니다.`);
      }
      finalRawPath = attemptRawPath;
      completedAttempt = attempt;
      await writeProgress(options.progressPath, {
        event: "attempt_completed",
        sequence: options.packet.sequence,
        packetSha256: options.packet.sha256,
        attempt,
        modelEventCount,
      });
      break;
    } catch (error) {
      finalError = error;
      await writeProgress(options.progressPath, {
        event: "attempt_failed",
        sequence: options.packet.sequence,
        packetSha256: options.packet.sha256,
        attempt,
        retrying: attempt < MAX_PACKET_ATTEMPTS && isRetryableAttemptError(error),
        error: error instanceof Error ? error.message : String(error),
      });
      if (!isRetryableAttemptError(error)) break;
      if (attempt < MAX_PACKET_ATTEMPTS) {
        await writeProgress(options.progressPath, {
          event: "retrying",
          sequence: options.packet.sequence,
          packetSha256: options.packet.sha256,
          completedAttempt: attempt,
          nextAttempt: attempt + 1,
        });
      }
    }
  }
  if (!finalResult || !finalRawPath) {
    throw finalError instanceof Error ? finalError : new Error(`${options.label} 독립 검수 실패`);
  }
  await writeExactFileFromSource(options.canonicalRawPath, finalRawPath);
  await writeIndependentReviewResult(options.resultPath, finalResult);
  await writeProgress(options.progressPath, {
    event: "target_completed",
    sequence: options.packet.sequence,
    packetSha256: options.packet.sha256,
  });
  console.log(`[codex-review] ${options.label} 완료`);
  return { sequence: options.packet.sequence, status: "completed", attempts: completedAttempt };
}

export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
  observation: {
    stdin?: string | Buffer;
    onStdoutLine?: (line: string) => void;
    onStdoutChunk?: (chunk: string) => void;
    onStderrChunk?: (chunk: string) => void;
    stallTimeoutMs?: number;
    terminationGraceMs?: number;
  } = {},
): Promise<SupervisedCommandResult> {
  return new Promise((resolvePromise, reject) => {
    if (shutdownSignal !== null) {
      reject(new SupervisorInterruptedError(`새 child 시작 전 ${shutdownSignal} 중단 요청을 확인했습니다.`, true));
      return;
    }
    const useProcessGroup = process.platform !== "win32";
    const hasStdin = observation.stdin !== undefined;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: useProcessGroup,
    });
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr) {
      reject(new Error("child stdout/stderr pipe를 만들지 못했습니다."));
      return;
    }
    let stdout = "";
    let stderr = "";
    let stdoutLineBuffer = "";
    let timedOut = false;
    let timeoutKind: SupervisedCommandResult["timeoutKind"] = null;
    let forcedKill = false;
    let stdinError: Error | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let stallTimer: NodeJS.Timeout | null = null;
    const terminationGraceMs = observation.terminationGraceMs ?? TERMINATION_GRACE_MS;
    const active = child.pid
      ? {
          pid: child.pid,
          processGroup: useProcessGroup,
          terminationGraceMs,
          interruptedSignal: null,
        } satisfies ActiveOwnedProcess
      : null;
    if (active) activeOwnedProcesses.set(active.pid, active);
    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    if (hasStdin && child.stdin) {
      child.stdin.once("error", (error) => { stdinError = error; });
      child.stdin.end(observation.stdin);
    }
    childStdout.on("data", (chunk: string) => {
      stdout += chunk;
      observation.onStdoutChunk?.(chunk);
      stdoutLineBuffer += chunk;
      const lines = stdoutLineBuffer.split("\n");
      stdoutLineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        observation.onStdoutLine?.(line);
        resetStallTimer();
      }
    });
    childStderr.on("data", (chunk: string) => {
      stderr += chunk;
      observation.onStderrChunk?.(chunk);
    });
    const beginTimeout = (kind: "hard" | "stall") => {
      if (timedOut) return;
      timedOut = true;
      timeoutKind = kind;
      signalOwnedProcess(child.pid, "SIGTERM", useProcessGroup);
      killTimer = setTimeout(() => {
        if (!ownedProcessAlive(child.pid, useProcessGroup)) return;
        forcedKill = signalOwnedProcess(child.pid, "SIGKILL", useProcessGroup);
      }, terminationGraceMs);
    };
    const resetStallTimer = () => {
      if (!observation.stallTimeoutMs || timedOut) return;
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => beginTimeout("stall"), observation.stallTimeoutMs);
    };
    const timer = setTimeout(() => beginTimeout("hard"), timeoutMs);
    resetStallTimer();
    child.once("error", (error) => {
      clearTimeout(timer);
      if (stallTimer) clearTimeout(stallTimer);
      if (killTimer) clearTimeout(killTimer);
      if (active) activeOwnedProcesses.delete(active.pid);
      reject(error);
    });
    child.once("close", (code, signal) => {
      void (async () => {
        clearTimeout(timer);
        if (stallTimer) clearTimeout(stallTimer);
        if (stdoutLineBuffer.trim()) observation.onStdoutLine?.(stdoutLineBuffer);
        let descendantCleanupRequired = false;
        if (useProcessGroup && ownedProcessAlive(child.pid, true)) {
          descendantCleanupRequired = true;
          signalOwnedProcess(child.pid, "SIGTERM", true);
          await waitForOwnedProcessExit(child.pid, true, terminationGraceMs);
          if (ownedProcessAlive(child.pid, true)) {
            forcedKill = signalOwnedProcess(child.pid, "SIGKILL", true) || forcedKill;
          }
        }
        if (killTimer) clearTimeout(killTimer);
        await waitForOwnedProcessExit(child.pid, useProcessGroup, 1_000);
        const treeTerminated = !ownedProcessAlive(child.pid, useProcessGroup);
        const interruptedSignal = active?.interruptedSignal ?? null;
        if (active) activeOwnedProcesses.delete(active.pid);
        if (stdinError) {
          reject(stdinError);
          return;
        }
        resolvePromise({
          code: code ?? 1,
          signal,
          stdout,
          stderr,
          timedOut,
          timeoutKind,
          forcedKill,
          descendantCleanupRequired,
          treeTerminated,
          interruptedSignal,
        });
      })().catch(reject);
    });
  });
}

function signalOwnedProcess(pid: number | undefined, signal: NodeJS.Signals, processGroup: boolean): boolean {
  if (!pid) return false;
  try {
    process.kill(processGroup ? -pid : pid, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcessError(error)) return false;
    return false;
  }
}

function ownedProcessAlive(pid: number | undefined, processGroup: boolean): boolean {
  if (!pid) return false;
  try {
    process.kill(processGroup ? -pid : pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isRetryableAttemptError(error: unknown): boolean {
  return !(error instanceof UnterminatedProcessTreeError)
    && !(error instanceof PacketBindingError)
    && !(error instanceof AttemptEvidencePersistenceError)
    && !(error instanceof SupervisorInterruptedError);
}

function installShutdownHandlers(): () => void {
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const handler = () => {
      if (shutdownSignal !== null) return;
      shutdownSignal = signal;
      process.exitCode = signal === "SIGINT" ? 130 : 143;
      void terminateActiveOwnedProcesses(signal);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

async function terminateActiveOwnedProcesses(signal: NodeJS.Signals): Promise<void> {
  const active = [...activeOwnedProcesses.values()];
  for (const item of active) {
    item.interruptedSignal = signal;
    signalOwnedProcess(item.pid, "SIGTERM", item.processGroup);
  }
  await Promise.all(active.map((item) => waitForOwnedProcessExit(
    item.pid,
    item.processGroup,
    item.terminationGraceMs,
  )));
  for (const item of active) {
    if (ownedProcessAlive(item.pid, item.processGroup)) {
      signalOwnedProcess(item.pid, "SIGKILL", item.processGroup);
    }
  }
  await Promise.all(active.map((item) => waitForOwnedProcessExit(
    item.pid,
    item.processGroup,
    1_000,
  )));
}

async function waitForOwnedProcessExit(
  pid: number | undefined,
  processGroup: boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (ownedProcessAlive(pid, processGroup) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

export function reusableCompletedResultMatches(
  value: unknown,
  binding: { packetSha256: string; sequence: number; reviewerModel: string },
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.schema === INDEPENDENT_REVIEW_RESULT_SCHEMA
    && result.reviewer === "codex"
    && result.reviewerTransport === "codex-cli"
    && result.reviewerModel === binding.reviewerModel
    && result.packetSha256 === binding.packetSha256
    && result.sequence === binding.sequence
    && Array.isArray(result.criterionReviews)
    && Array.isArray(result.axisReviews);
}

async function assertReusableCompletedResult(
  resultPath: string,
  binding: { packetSha256: string; sequence: number; reviewerModel: string },
): Promise<void> {
  const result = JSON.parse(await readFile(resultPath, "utf8")) as unknown;
  if (!reusableCompletedResultMatches(result, binding)) {
    throw new Error(`기존 독립 검수 결과의 packet/model/sequence 결속이 다릅니다: ${resultPath}`);
  }
}

export async function acquirePacketExecutionLock(input: {
  lockPath: string;
  packetSha256: string;
}): Promise<() => Promise<void>> {
  await mkdir(dirname(input.lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(input.lockPath, "wx");
  } catch (error) {
    const owner: { pid?: unknown; packetSha256?: unknown; startedAt?: unknown } = await readFile(input.lockPath, "utf8")
      .then((value) => JSON.parse(value) as { pid?: unknown })
      .catch(() => ({}));
    const pid = typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) ? owner.pid : null;
    const state = pid !== null && processIsAlive(pid) ? `실행 중 pid=${pid}` : "소유 프로세스 상태 미확인";
    throw new Error(
      `같은 packet의 독립 검수 lock이 이미 있습니다(${state}). `
      + `중복 프로세스를 시작하지 않았습니다: ${input.lockPath}`,
      { cause: error },
    );
  }
  await handle.writeFile(`${JSON.stringify({ pid: process.pid, packetSha256: input.packetSha256, startedAt: new Date().toISOString() })}\n`);
  await handle.close();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await unlink(input.lockPath).catch(() => undefined);
  };
}

async function readAndVerifyPacket(path: string, expectedSha256: string, label: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (sha256(bytes) !== expectedSha256) throw new PacketBindingError(`${label} packet SHA 불일치`);
  return bytes;
}

async function writeExactFileFromSource(targetPath: string, sourcePath: string): Promise<void> {
  const expected = await readFile(sourcePath);
  await writeFile(targetPath, expected, { flag: "wx" }).catch(async (error: unknown) => {
    const current = await readFile(targetPath).catch(() => null);
    if (!current || !current.equals(expected)) throw error;
  });
}

async function writeProgress(path: string, event: Record<string, unknown>): Promise<void> {
  const record = { recordedAt: new Date().toISOString(), ...event };
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  const sequence = typeof event.sequence === "number" ? ` sequence-${String(event.sequence).padStart(2, "0")}` : "";
  console.log(`[codex-review]${sequence} ${String(event.event ?? "progress")}`);
}

function readModelEventType(line: string): string {
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return typeof parsed.type === "string" ? parsed.type.slice(0, 80) : "json";
  } catch {
    return "text";
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function parsePositiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSequenceSet(value: string | null): Set<number> | null {
  if (!value) return null;
  const parsed = value.split(",").map((item) => Number.parseInt(item.trim(), 10));
  if (parsed.some((item) => !Number.isInteger(item) || item < 0)) {
    throw new Error("--sequences는 0 이상의 정수를 쉼표로 구분해야 합니다.");
  }
  return new Set(parsed);
}

function requireEveryObjectProperty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(requireEveryObjectProperty);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const mapped = Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, requireEveryObjectProperty(item)]),
  ) as Record<string, unknown>;
  if (mapped.type === "object" && mapped.properties && typeof mapped.properties === "object") {
    mapped.required = Object.keys(mapped.properties as Record<string, unknown>);
  }
  return mapped;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
