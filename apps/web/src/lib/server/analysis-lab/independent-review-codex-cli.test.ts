import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  acquirePacketExecutionLock,
  resolveCodexReviewModel,
  reusableCompletedResultMatches,
  runCommand,
  runPacket,
} from "./independent-review-codex-cli";
import { buildAiReviewToolSchema } from "./ai-review";
import { DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL } from "./independent-review-packet";
import { findMonorepoRoot } from "./run-store";

const repoRoot = findMonorepoRoot();
const evidenceRoot = join(repoRoot, "spike-out", "improvement-20260914");
await mkdir(evidenceRoot, { recursive: true });
const tempRoot = await mkdtemp(join(evidenceRoot, "independent-review-test-"));
try {
  const progressLines: string[] = [];
  const completed = await runCommand(
    process.execPath,
    ["-e", "console.log(JSON.stringify({type:'turn.started'})); setTimeout(() => { console.log(JSON.stringify({type:'turn.completed'})); }, 20)"],
    tempRoot,
    process.env,
    2_000,
    {
      stallTimeoutMs: 200,
      terminationGraceMs: 50,
      onStdoutLine: (line) => progressLines.push(line),
    },
  );
  assert.equal(completed.code, 0);
  assert.equal(completed.timedOut, false);
  assert.equal(completed.treeTerminated, true);
  assert.deepEqual(progressLines.map((line) => JSON.parse(line).type), ["turn.started", "turn.completed"]);

  let grandchildPid = 0;
  const stalled = await runCommand(
    process.execPath,
    ["-e", [
      "const {spawn}=require('node:child_process')",
      "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'})",
      "process.on('SIGTERM',()=>{})",
      "console.log(JSON.stringify({type:'turn.started',grandchildPid:child.pid}))",
      "setInterval(()=>{},1000)",
    ].join(";")],
    tempRoot,
    process.env,
    5_000,
    {
      stallTimeoutMs: 250,
      terminationGraceMs: 80,
      onStdoutLine: (line) => {
        const parsed = JSON.parse(line) as { grandchildPid?: number };
        grandchildPid = parsed.grandchildPid ?? grandchildPid;
      },
    },
  );
  assert.equal(stalled.timedOut, true);
  assert.equal(stalled.timeoutKind, "stall");
  assert.equal(stalled.forcedKill, true, "SIGTERM을 무시하는 descendant는 grace 뒤 동일 process group에서 SIGKILL");
  assert.equal(stalled.treeTerminated, true, "retry 전에 launcher descendant까지 종료를 확인");
  assert.ok(grandchildPid > 0);
  assert.throws(() => process.kill(grandchildPid, 0), "종료 후 descendant가 살아 있으면 안 됨");

  const lockPath = join(tempRoot, "locks", "sequence-00.lock");
  const release = await acquirePacketExecutionLock({ lockPath, packetSha256: "a".repeat(64) });
  await assert.rejects(
    acquirePacketExecutionLock({ lockPath, packetSha256: "a".repeat(64) }),
    /이미 있습니다.*중복 프로세스를 시작하지 않았습니다/,
    "동일 packet lock은 owner 기록 중이거나 살아 있는 동안 takeover하지 않음",
  );
  await release();
  const releaseAgain = await acquirePacketExecutionLock({ lockPath, packetSha256: "a".repeat(64) });
  await releaseAgain();

  const reusable = {
    schema: "independent-ai-review-result-v1",
    reviewer: "codex",
    reviewerTransport: "codex-cli",
    reviewerModel: "gpt-5.6-sol",
    packetSha256: "b".repeat(64),
    sequence: 2,
    criterionReviews: [],
    axisReviews: [],
  };
  assert.equal(reusableCompletedResultMatches(reusable, {
    packetSha256: "b".repeat(64),
    sequence: 2,
    reviewerModel: "gpt-5.6-sol",
  }), true);
  assert.equal(reusableCompletedResultMatches(reusable, {
    packetSha256: "c".repeat(64),
    sequence: 2,
    reviewerModel: "gpt-5.6-sol",
  }), false, "다른 packet 결과를 existing으로 재사용하지 않음");
  assert.equal(reusableCompletedResultMatches(reusable, {
    packetSha256: "b".repeat(64),
    sequence: 2,
    reviewerModel: DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL,
  }), false, "역사 결과를 새 모델 결과로 재사용하지 않음");
  assert.equal(resolveCodexReviewModel({
    reviewers: [{ reviewer: "codex", transport: "codex-cli", model: DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL }],
  }, null), DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL);
  assert.throws(() => resolveCodexReviewModel({
    reviewers: [{ reviewer: "codex", transport: "codex-cli", model: "gpt-5.6-sol" }],
  }, null), /--model=gpt-5\.6-sol/u, "역사 manifest는 명시적 모델 선택 전 모델을 실행하지 않음");
  assert.equal(resolveCodexReviewModel({
    reviewers: [{ reviewer: "codex", transport: "codex-cli", model: "gpt-5.6-sol" }],
  }, "gpt-5.6-sol"), "gpt-5.6-sol");

  const fakeBin = join(tempRoot, "bin");
  await mkdir(fakeBin, { recursive: true });
  const fakeCodexPath = join(fakeBin, "codex");
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
import fs from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "--version") {
  console.log("codex-cli-test 0.0.0");
  process.exit(0);
}
const statePath = process.env.FAKE_CODEX_STATE_PATH;
const mode = process.env.FAKE_CODEX_MODE || "success";
const count = statePath && fs.existsSync(statePath) ? Number(fs.readFileSync(statePath, "utf8")) + 1 : 1;
if (statePath) fs.writeFileSync(statePath, String(count));
const stdin = fs.readFileSync(0, "utf8");
if (process.env.FAKE_CODEX_STDIN_PATH) fs.writeFileSync(process.env.FAKE_CODEX_STDIN_PATH, stdin);
if (process.env.FAKE_CODEX_ARGS_PATH) fs.writeFileSync(process.env.FAKE_CODEX_ARGS_PATH, JSON.stringify(args));
const rawIndex = args.indexOf("--output-last-message");
const rawPath = rawIndex >= 0 ? args[rawIndex + 1] : null;
console.log(JSON.stringify({ type: "turn.started", count }));
if (mode === "stall_then_success" && count === 1) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "signal_tree") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  fs.writeFileSync(process.env.FAKE_CODEX_PIDS_PATH, JSON.stringify({ parentPid: process.pid, grandchildPid: child.pid }));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (mode === "always_fail") {
  console.error("fake failure " + count);
  process.exit(9);
} else {
  const complete = () => {
    fs.writeFileSync(rawPath, JSON.stringify({ criterion_reviews: [], axis_reviews: [] }));
    console.log(JSON.stringify({ type: "turn.completed", count }));
  };
  if (mode === "delayed_success") setTimeout(complete, 150);
  else complete();
}
`);
  await chmod(fakeCodexPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;

  const retryCase = await preparePacketCase("retry", 10);
  const retryState = join(retryCase.base, "state.txt");
  const retryStdinPath = join(retryCase.base, "stdin.txt");
  const retryArgsPath = join(retryCase.base, "args.json");
  process.env.FAKE_CODEX_MODE = "stall_then_success";
  process.env.FAKE_CODEX_STATE_PATH = retryState;
  process.env.FAKE_CODEX_STDIN_PATH = retryStdinPath;
  process.env.FAKE_CODEX_ARGS_PATH = retryArgsPath;
  const retryPromise = runPacket({
    ...retryCase.options,
    timeoutMs: 2_000,
    stallTimeoutMs: 1_500,
  });
  await waitFor(async () => {
    const logs = await readdir(retryCase.options.logDir).catch(() => []);
    if (logs.length === 0) return false;
    const contents = await Promise.all(
      logs.filter((name) => name.endsWith(".jsonl"))
        .map((name) => readFile(join(retryCase.options.logDir, name), "utf8")),
    );
    return contents.some((content) => content.includes("turn.started"));
  }, 5_000);
  const retryOutcome = await retryPromise;
  assert.equal(retryOutcome.attempts, 2, "첫 stall 뒤 같은 packet을 한 번만 재시도");
  assert.equal(await readFile(retryState, "utf8"), "2");
  assert.equal((await readdir(retryCase.options.logDir)).filter((name) => name.endsWith(".jsonl")).length, 2);
  assert.ok((await readFile(retryCase.options.progressPath, "utf8")).includes('"event":"retrying"'));
  const deliveredStdin = await readFile(retryStdinPath, "utf8");
  assert.match(deliveredStdin, /^\[검수 규칙 — 모든 공고 공통\]\nfixture-system-rule/u);
  assert.match(deliveredStdin, /\[공고별 검수 입력 — 원문 및 추출 조건\]\nfixture-user-evidence/u);
  assert.doesNotMatch(deliveredStdin, /"outputSchema"/u, "CLI flag로 전달하는 출력 schema를 stdin에 중복하지 않음");
  const deliveredArgs = JSON.parse(await readFile(retryArgsPath, "utf8")) as string[];
  assert.equal(deliveredArgs[deliveredArgs.indexOf("--model") + 1], DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL);
  assert.equal(deliveredArgs.includes(retryCase.packetPath), false, "Codex에 packet 파일 read 경로를 지시하지 않음");
  assert.equal(deliveredArgs.at(-1)?.includes("stdin의 [검수 규칙]"), true, "prompt+stdin 계약을 사용");
  delete process.env.FAKE_CODEX_STDIN_PATH;
  delete process.env.FAKE_CODEX_ARGS_PATH;

  const failureCase = await preparePacketCase("failure", 11);
  const failureState = join(failureCase.base, "state.txt");
  process.env.FAKE_CODEX_MODE = "always_fail";
  process.env.FAKE_CODEX_STATE_PATH = failureState;
  await assert.rejects(runPacket({
    ...failureCase.options,
    timeoutMs: 2_000,
    stallTimeoutMs: 200,
  }), /종료 코드 9/);
  assert.equal(await readFile(failureState, "utf8"), "2", "연속 실패도 최대 두 attempt");
  assert.equal((await readdir(failureCase.options.logDir)).filter((name) => name.endsWith(".stderr.log")).length, 2);

  const preflightDriftCase = await preparePacketCase("preflight-drift", 12);
  const preflightDriftState = join(preflightDriftCase.base, "state.txt");
  process.env.FAKE_CODEX_MODE = "success";
  process.env.FAKE_CODEX_STATE_PATH = preflightDriftState;
  await assert.rejects(runPacket({
    ...preflightDriftCase.options,
    packet: { ...preflightDriftCase.options.packet, sha256: "f".repeat(64) },
    timeoutMs: 2_000,
    stallTimeoutMs: 200,
  }), /packet SHA 불일치/);
  await assert.rejects(readFile(preflightDriftState), "packet drift는 모델 신규 호출 0회");

  const postflightDriftCase = await preparePacketCase("postflight-drift", 13);
  const postflightDriftState = join(postflightDriftCase.base, "state.txt");
  process.env.FAKE_CODEX_MODE = "delayed_success";
  process.env.FAKE_CODEX_STATE_PATH = postflightDriftState;
  const postflightRun = runPacket({
    ...postflightDriftCase.options,
    timeoutMs: 2_000,
    stallTimeoutMs: 400,
  });
  await waitFor(async () => readFile(postflightDriftState, "utf8").then(() => true).catch(() => false));
  await writeFile(postflightDriftCase.packetPath, `${postflightDriftCase.packetText} `);
  await assert.rejects(postflightRun, /packet SHA 불일치/);
  assert.equal(await readFile(postflightDriftState, "utf8"), "1", "종료 후 packet drift는 재시도하지 않음");
  await assert.rejects(readFile(postflightDriftCase.resultPath), "drift한 결과를 canonical 완료본으로 저장하지 않음");

  const reuseCase = await preparePacketCase("reuse", 14);
  const reuseState = join(reuseCase.base, "state.txt");
  await writeFile(reuseCase.resultPath, `${JSON.stringify({
    schema: "independent-ai-review-result-v1",
    reviewer: "codex",
    reviewerTransport: "codex-cli",
    reviewerModel: "gpt-5.6-sol",
    packetSha256: reuseCase.options.packet.sha256,
    sequence: reuseCase.options.packet.sequence,
    criterionReviews: [],
    axisReviews: [],
  })}\n`);
  process.env.FAKE_CODEX_MODE = "success";
  process.env.FAKE_CODEX_STATE_PATH = reuseState;
  const reuseOutcome = await runPacket({
    ...reuseCase.options,
    reviewerModel: "gpt-5.6-sol",
    timeoutMs: 2_000,
    stallTimeoutMs: 200,
  });
  assert.equal(reuseOutcome.status, "existing");
  await assert.rejects(readFile(reuseState), "exact 완료 검수는 모델 신규 호출 없이 재사용");

  const legacyCase = await preparePacketCase("legacy-model", 15);
  const legacyManifest = {
    schema: "independent-ai-review-manifest-v2",
    reviewers: [{ reviewer: "codex", transport: "codex-cli", auth: "chatgpt-subscription", model: "gpt-5.6-sol" }],
    packets: [legacyCase.options.packet],
  };
  const legacyManifestBytes = Buffer.from(`${JSON.stringify(legacyManifest)}\n`, "utf8");
  const legacyManifestSha = sha256(legacyManifestBytes);
  const legacyManifestPath = join(legacyCase.base, `${legacyManifestSha}.manifest.json`);
  const legacyState = join(legacyCase.base, "state.txt");
  const legacyArgs = join(legacyCase.base, "args.json");
  await writeFile(legacyManifestPath, legacyManifestBytes);
  const invokeLegacyCli = async (args: string[]) => {
    const cli = spawn(process.execPath, [
      "--import", "tsx",
      join(repoRoot, "apps/web/src/lib/server/analysis-lab/independent-review-codex-cli.ts"),
      `--manifest=${legacyManifestPath}`,
      ...args,
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${originalPath ?? ""}`,
        TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
        FAKE_CODEX_MODE: "success",
        FAKE_CODEX_STATE_PATH: legacyState,
        FAKE_CODEX_ARGS_PATH: legacyArgs,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    cli.stderr.setEncoding("utf8");
    cli.stderr.on("data", (chunk: string) => { stderr += chunk; });
    return new Promise<{ code: number | null; stderr: string }>((resolveExit, rejectExit) => {
      cli.once("error", rejectExit);
      cli.once("close", (code) => resolveExit({ code, stderr }));
    });
  };
  const legacyDefault = await invokeLegacyCli([]);
  assert.notEqual(legacyDefault.code, 0);
  assert.match(legacyDefault.stderr, /--model=gpt-5\.6-sol/u);
  await assert.rejects(readFile(legacyState), "잘못된 모델로는 호출 0회");
  const legacyExplicit = await invokeLegacyCli(["--model=gpt-5.6-sol"]);
  assert.equal(legacyExplicit.code, 0, legacyExplicit.stderr);
  assert.equal(await readFile(legacyState, "utf8"), "1");
  const legacyResultPath = join(legacyCase.base, "review-runs", legacyManifestSha, "codex", "results", "sequence-15.json");
  const legacyResult = JSON.parse(await readFile(legacyResultPath, "utf8")) as { reviewerModel: string };
  assert.equal(legacyResult.reviewerModel, "gpt-5.6-sol", "역사 모델 provenance 유지");
  const legacyDeliveredArgs = JSON.parse(await readFile(legacyArgs, "utf8")) as string[];
  assert.equal(legacyDeliveredArgs[legacyDeliveredArgs.indexOf("--model") + 1], "gpt-5.6-sol");

  for (const [signalName, sequence] of [["SIGTERM", 20], ["SIGINT", 21]] as const) {
    const signalCase = await preparePacketCase(`main-${signalName.toLowerCase()}`, sequence);
    const manifest = {
      schema: "independent-ai-review-manifest-v2",
      reviewers: [{ reviewer: "codex", transport: "codex-cli", auth: "chatgpt-subscription", model: DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL }],
      packets: [signalCase.options.packet],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    const manifestSha256 = sha256(manifestBytes);
    const manifestPath = join(signalCase.base, `${manifestSha256}.manifest.json`);
    await writeFile(manifestPath, manifestBytes);
    const resultRoot = join(signalCase.base, "review-runs", manifestSha256, "codex");
    const signalState = join(signalCase.base, "main-state.txt");
    const pidsPath = join(signalCase.base, "pids.json");
    const cli = spawn(process.execPath, [
      "--import", "tsx",
      join(repoRoot, "apps/web/src/lib/server/analysis-lab/independent-review-codex-cli.ts"),
      `--manifest=${manifestPath}`,
      "--concurrency=1",
      "--timeout-ms=20000",
      "--stall-timeout-ms=20000",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${originalPath ?? ""}`,
        TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
        FAKE_CODEX_MODE: "signal_tree",
        FAKE_CODEX_STATE_PATH: signalState,
        FAKE_CODEX_PIDS_PATH: pidsPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cliStdout = "";
    let cliStderr = "";
    cli.stdout.setEncoding("utf8");
    cli.stderr.setEncoding("utf8");
    cli.stdout.on("data", (chunk: string) => { cliStdout += chunk; });
    cli.stderr.on("data", (chunk: string) => { cliStderr += chunk; });
    const cliExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
      cli.once("error", rejectExit);
      cli.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    await waitFor(async () => readFile(pidsPath, "utf8").then(() => true).catch(() => false), 5_000);
    const lockPathForSignal = join(resultRoot, "locks", `sequence-${String(sequence).padStart(2, "0")}.lock`);
    await waitFor(async () => readFile(lockPathForSignal, "utf8").then(() => true).catch(() => false), 2_000);
    assert.equal(cli.kill(signalName), true, `${signalName}을 실제 CLI supervisor에 전달`);
    const exit = await cliExit;
    assert.notEqual(exit.code, 0, `${signalName} 중단 CLI는 성공으로 종료하지 않음: ${cliStderr}`);
    const pids = JSON.parse(await readFile(pidsPath, "utf8")) as { parentPid: number; grandchildPid: number };
    assertProcessExited(pids.parentPid, `${signalName} 뒤 fake codex child 종료`);
    assertProcessExited(pids.grandchildPid, `${signalName} 뒤 fake codex grandchild 종료`);
    assert.equal(await readFile(signalState, "utf8"), "1", `${signalName} 뒤 추가 attempt 0회`);
    const progress = await readFile(join(resultRoot, "progress.jsonl"), "utf8");
    assert.equal(progress.match(/"event":"attempt_started"/gu)?.length, 1);
    assert.doesNotMatch(progress, /"event":"retrying"/u);
    await assert.rejects(readFile(lockPathForSignal), `${signalName} process tree 종료 확인 뒤 lock 해제`);
    const releaseAfterSignal = await acquirePacketExecutionLock({
      lockPath: lockPathForSignal,
      packetSha256: signalCase.options.packet.sha256,
    });
    await releaseAfterSignal();
    assert.match(cliStdout, /attempt_failed/u, `${signalName} 중단 사실을 progress로 출력`);
    console.log(`✅ 실제 CLI ${signalName} — child/grandchild 종료, 추가 attempt 0, lock 해제`);
  }

  process.env.PATH = originalPath;
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.FAKE_CODEX_STATE_PATH;

  console.log("independent-review codex runner tests: ok");
} finally {
  if (process.env.KEEP_INDEPENDENT_REVIEW_TEST_TMP !== "1") {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function preparePacketCase(name: string, sequence: number) {
  const base = join(tempRoot, name);
  const rawDir = join(base, "raw");
  const resultDir = join(base, "results");
  const schemaDir = join(base, "schemas");
  const logDir = join(base, "logs");
  const lockDir = join(base, "locks");
  await Promise.all([rawDir, resultDir, schemaDir, logDir, lockDir].map((path) => mkdir(path, { recursive: true })));
  const runPath = join(base, "run.json");
  const runBytes = Buffer.from(`${JSON.stringify({ criteria: [] })}\n`, "utf8");
  await writeFile(runPath, runBytes);
  const packetPath = join(base, "packet.json");
  const packet = {
    schema: "independent-ai-review-packet-v2",
    launchReceiptSha256: "a".repeat(64),
    launchManifestSha256: "b".repeat(64),
    sequence,
    grantId: `grant-${sequence}`,
    runId: `run-${sequence}`,
    source: "fixture",
    sourceId: `source-${sequence}`,
    extractorModel: "fixture-model",
    runArtifactPath: relative(repoRoot, runPath),
    runArtifactSha256: sha256(runBytes),
    inputSha256: "c".repeat(64),
    promptVersion: "ai-review-v1",
    reviewPolicyVersion: "codex-only-v8",
    guideSha256: "d".repeat(64),
    systemPrompt: "fixture-system-rule",
    userMessage: "fixture-user-evidence",
    outputSchema: buildAiReviewToolSchema(0, []).input_schema,
  };
  const packetText = `${JSON.stringify(packet)}\n`;
  const packetBytes = Buffer.from(packetText, "utf8");
  await writeFile(packetPath, packetBytes);
  const resultPath = join(resultDir, `sequence-${String(sequence).padStart(2, "0")}.json`);
  return {
    base,
    packetPath,
    packetText,
    resultPath,
    options: {
      root: repoRoot,
      packet: { sequence, path: packetPath, sha256: sha256(packetBytes) },
      rawDir,
      resultDir,
      schemaDir,
      logDir,
      lockDir,
      progressPath: join(base, "progress.jsonl"),
      reviewerModel: DEFAULT_CODEX_INDEPENDENT_REVIEW_MODEL,
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("조건 대기 시간 초과");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertProcessExited(pid: number, message: string): void {
  assert.throws(() => process.kill(pid, 0), message);
}
