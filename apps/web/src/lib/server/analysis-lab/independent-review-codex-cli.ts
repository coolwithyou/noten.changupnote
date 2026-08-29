import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  validateAndWrapIndependentReviewResult,
  writeIndependentReviewResult,
} from "./independent-review-packet";
import { findMonorepoRoot } from "./run-store";

interface ManifestPacket {
  sequence: number;
  path: string;
  sha256: string;
}

interface ReviewManifest {
  schema: "independent-ai-review-manifest-v1";
  packets: ManifestPacket[];
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

async function main() {
  const root = findMonorepoRoot();
  const manifestArg = option("manifest");
  if (!manifestArg) throw new Error("--manifest=<absolute-or-repo-relative-path>가 필요합니다.");
  const manifestPath = resolve(root, manifestArg);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as ReviewManifest;
  if (manifest.schema !== "independent-ai-review-manifest-v1") throw new Error("독립 검수 manifest 형식이 아닙니다.");
  const addressedSha = basename(manifestPath).replace(/\.manifest\.json$/, "");
  if (sha256(manifestBytes) !== addressedSha) throw new Error("manifest content address가 일치하지 않습니다.");

  const authStatus = await runCommand("codex", ["login", "status"], root);
  if (authStatus.code !== 0 || !`${authStatus.stdout}\n${authStatus.stderr}`.includes("Logged in using ChatGPT")) {
    throw new Error("Codex가 ChatGPT 구독 인증 상태가 아닙니다.");
  }
  const version = await runCommand("codex", ["--version"], root);
  if (version.code !== 0) throw new Error("Codex 버전을 확인하지 못했습니다.");
  const reviewerModel = "gpt-5.6-sol";
  const outputDir = dirname(manifestPath);
  const rawDir = join(outputDir, "codex", "raw");
  const resultDir = join(outputDir, "codex", "results");
  const schemaDir = join(outputDir, "codex", "schemas");
  const logDir = join(outputDir, "codex", "logs");
  await Promise.all([rawDir, resultDir, schemaDir, logDir].map((path) => mkdir(path, { recursive: true })));

  const concurrency = parsePositiveInteger(option("concurrency")) ?? 2;
  const timeoutMs = parsePositiveInteger(option("timeout-ms")) ?? 1_200_000;
  const requestedSequences = parseSequenceSet(option("sequences"));
  const pending = [...manifest.packets]
    .filter((packet) => requestedSequences === null || requestedSequences.has(packet.sequence))
    .sort((a, b) => a.sequence - b.sequence);
  if (pending.length === 0) throw new Error("실행할 packet이 없습니다.");
  const outcomes: Array<{ sequence: number; status: "completed" | "existing" | "failed"; error?: string }> = [];
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const packet = pending[cursor++]!;
      try {
        outcomes.push(await runPacket({ root, packet, rawDir, resultDir, schemaDir, logDir, reviewerModel, timeoutMs }));
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
    completed: outcomes.filter((item) => item.status === "completed").length,
    existing: outcomes.filter((item) => item.status === "existing").length,
    failed: outcomes.filter((item) => item.status === "failed"),
  }, null, 2));
  if (outcomes.some((item) => item.status === "failed")) process.exitCode = 1;
}

async function runPacket(options: {
  root: string;
  packet: ManifestPacket;
  rawDir: string;
  resultDir: string;
  schemaDir: string;
  logDir: string;
  reviewerModel: string;
  timeoutMs: number;
}): Promise<{ sequence: number; status: "completed" | "existing" }> {
  const label = `sequence-${String(options.packet.sequence).padStart(2, "0")}`;
  const packetPath = resolve(options.root, options.packet.path);
  const packetBytes = await readFile(packetPath);
  if (sha256(packetBytes) !== options.packet.sha256) throw new Error(`${label} packet SHA 불일치`);
  const packet = JSON.parse(packetBytes.toString("utf8")) as { outputSchema: Record<string, unknown> };
  const rawPath = join(options.rawDir, `${label}.json`);
  const resultPath = join(options.resultDir, `${label}.json`);
  const schemaPath = join(options.schemaDir, `${label}.codex.schema.json`);
  const logPath = join(options.logDir, `${label}-${Date.now()}.jsonl`);
  if (existsSync(resultPath)) return { sequence: options.packet.sequence, status: "existing" };
  const codexOutputSchema = requireEveryObjectProperty(packet.outputSchema);
  await writeFile(schemaPath, `${JSON.stringify(codexOutputSchema)}\n`, { flag: "wx" }).catch(async (error: unknown) => {
    const current = await readFile(schemaPath).catch(() => null);
    const expected = Buffer.from(`${JSON.stringify(codexOutputSchema)}\n`, "utf8");
    if (!current || !current.equals(expected)) throw error;
  });

  const prompt = [
    "이 작업은 코드 리뷰가 아니라 정부지원사업 분석 결과의 블라인드 데이터 품질 검수다.",
    `오직 ${packetPath} 파일을 읽고 packet.systemPrompt를 최상위 검수 규칙으로, packet.userMessage를 검수 입력으로 사용하라.`,
    "다른 리뷰 결과, Codex/Grok 산출물, 사람 판정 파일은 읽지 마라.",
    "packet.outputSchema를 만족하는 JSON 객체 하나만 최종 응답으로 반환하라.",
    "note가 필요 없는 correct 또는 confirmed_absent 항목도 JSON schema 충족을 위해 note를 빈 문자열로 넣어라.",
    "파일을 수정하거나 DB·배포·네트워크 작업을 하지 마라.",
  ].join("\n");
  const childEnv = { ...process.env };
  for (const key of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]) {
    delete childEnv[key];
  }
  const command = await runCommand("codex", [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--sandbox", "read-only",
    "--model", options.reviewerModel,
    "--output-schema", schemaPath,
    "--output-last-message", rawPath,
    "--json",
    "--cd", options.root,
    prompt,
  ], options.root, childEnv, options.timeoutMs);
  await writeFile(logPath, `${command.stdout}${command.stderr ? `\n${command.stderr}` : ""}`, { flag: "wx" });
  if (command.code !== 0) throw new Error(`${label} Codex 종료 코드 ${command.code}: ${command.stderr.slice(-600)}`);

  const result = await validateAndWrapIndependentReviewResult({
    packetPath,
    rawResultPath: rawPath,
    reviewer: "codex",
    reviewerModel: options.reviewerModel,
    reviewerTransport: "codex-cli",
  });
  await writeIndependentReviewResult(resultPath, result);
  console.log(`[codex-review] ${label} 완료`);
  return { sequence: options.packet.sequence, status: "completed" };
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} 타임아웃(${timeoutMs}ms)`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
