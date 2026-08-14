import { execFile } from "node:child_process";
import {
  DeepRepairLiveExecutionError,
  type DeepRepairOperationalEvidence,
} from "./deep-repair-live-experiment";

const CONFIGURATION = "cunote-codex-dev";
const IMPERSONATED_PRINCIPAL =
  "cunote-codex-dev@changupnote-com.iam.gserviceaccount.com";
const PROJECT = "changupnote-com";
const REGION = "asia-northeast3";
const JOB = "cunote-deep-analysis";
const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const JOB_V2_URL =
  `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/jobs/${JOB}`;
const MAX_BUFFER = 4 * 1024 * 1024;
const OPERATIONAL_EVIDENCE_TTL_MS = 15 * 60_000;

interface ExecFileOptions {
  readonly signal: AbortSignal;
  readonly encoding: "utf8";
  readonly maxBuffer: number;
  readonly input?: string;
}

export type DeepRepairOperationalGuardExecFile = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<{ readonly stdout: string }>;

export function createDeepRepairOperationalGuardUnsafeForTest(options: {
  readonly execFile?: DeepRepairOperationalGuardExecFile;
} = {}): (
  evidence: DeepRepairOperationalEvidence,
  signal: AbortSignal,
) => Promise<void> {
  return buildDeepRepairOperationalGuard(options.execFile ?? runExecFile);
}

export function createDeepRepairOperationalEvidenceCaptureUnsafeForTest(options: {
  readonly execFile?: DeepRepairOperationalGuardExecFile;
  readonly now?: () => Date;
} = {}): (signal: AbortSignal) => Promise<DeepRepairOperationalEvidence> {
  return buildDeepRepairOperationalEvidenceCapture(
    options.execFile ?? runExecFile,
    options.now ?? (() => new Date()),
  );
}

function buildDeepRepairOperationalGuard(run: DeepRepairOperationalGuardExecFile): (
  evidence: DeepRepairOperationalEvidence,
  signal: AbortSignal,
) => Promise<void> {
  return async (evidence, signal): Promise<void> => {
    assertEvidenceTarget(evidence);
    const current = await readCurrentCloudRunSnapshot(run, signal);
    assertSnapshot(evidence, current, "Cloud Run current snapshot");
    if (current.etag !== evidence.jobEtag) throw invalid("Cloud Run v2 job etag가 evidence와 다릅니다.");
    if (current.updateTime !== evidence.jobUpdateTime) {
      throw invalid("Cloud Run v2 job updateTime이 evidence와 다릅니다.");
    }
  };
}

export const verifyCurrentDeepRepairOperationalEvidence =
  buildDeepRepairOperationalGuard(runExecFile);

export const captureCurrentDeepRepairOperationalEvidence =
  buildDeepRepairOperationalEvidenceCapture(runExecFile, () => new Date());

function buildDeepRepairOperationalEvidenceCapture(
  run: DeepRepairOperationalGuardExecFile,
  now: () => Date,
): (signal: AbortSignal) => Promise<DeepRepairOperationalEvidence> {
  return async (signal) => {
    const current = await readCurrentCloudRunSnapshot(run, signal);
    const observedAt = now();
    if (!Number.isFinite(observedAt.getTime())) {
      throw invalid("operational evidence 관측 시각이 올바르지 않습니다.");
    }
    return {
      schema: "deep-repair-operational-evidence-v1",
      project: PROJECT,
      region: REGION,
      job: JOB,
      workerMode: "observe_only",
      claimScope: "unconfigured",
      jobUid: current.uid,
      jobGeneration: current.generation,
      jobEtag: current.etag,
      jobUpdateTime: current.updateTime,
      imageDigest: current.imageDigest,
      gitCommitSha: current.gitCommitSha,
      observedAt: observedAt.toISOString(),
      validUntil: new Date(observedAt.getTime() + OPERATIONAL_EVIDENCE_TTL_MS).toISOString(),
    };
  };
}

async function readCurrentCloudRunSnapshot(
  run: DeepRepairOperationalGuardExecFile,
  signal: AbortSignal,
): Promise<CloudRunV2Snapshot> {
  const accessToken = (await run("gcloud", [
    "auth",
    "print-access-token",
    `--configuration=${CONFIGURATION}`,
    `--impersonate-service-account=${IMPERSONATED_PRINCIPAL}`,
  ], commandOptions(signal))).stdout.trim();
  if (!accessToken || /\s/u.test(accessToken)) {
    throw invalid("impersonated access token을 안전하게 확인하지 못했습니다.");
  }

  const tokenInfoRaw = await runSensitive(
    run,
    "curl",
    [
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--get",
      "--data-urlencode",
      "access_token@-",
      TOKENINFO_URL,
    ],
    signal,
    "tokeninfo",
    accessToken,
  );
  const tokenInfo = parseObject(tokenInfoRaw, "tokeninfo");
  if (requiredString(tokenInfo.email, "tokeninfo email") !== IMPERSONATED_PRINCIPAL) {
    throw invalid("tokeninfo의 impersonated principal이 전용 서비스 계정과 다릅니다.");
  }

  const v1Raw = (await run("gcloud", [
    "run",
    "jobs",
    "describe",
    JOB,
    `--configuration=${CONFIGURATION}`,
    `--impersonate-service-account=${IMPERSONATED_PRINCIPAL}`,
    `--project=${PROJECT}`,
    `--region=${REGION}`,
    "--format=json",
  ], commandOptions(signal))).stdout;
  const v1 = parseCloudRunV1(v1Raw);

  // gcloud run jobs describe는 v1 resource를 반환해 etag/updateTime이 없다.
  // 같은 impersonated token으로 v2 GET을 읽고 두 parser의 공통 snapshot을 exact 비교한다.
  const v2Raw = await runSensitive(
    run,
    "curl",
    [
      "--fail-with-body",
      "--silent",
      "--show-error",
      "--header",
      "@-",
      JOB_V2_URL,
    ],
    signal,
    "Cloud Run v2 job",
    `Authorization: Bearer ${accessToken}\nX-Goog-User-Project: ${PROJECT}\n`,
  );
  const v2 = parseCloudRunV2(v2Raw);
  assertSameSnapshot(v1, v2);
  if (v2.observedGeneration !== v2.generation) {
    throw invalid("Cloud Run v2 observedGeneration이 현재 generation과 다릅니다.");
  }
  if (v2.reconciling) throw invalid("Cloud Run v2 job이 아직 reconciling 중입니다.");
  if (v2.workerMode !== "observe_only" || v2.claimScope !== "unconfigured") {
    throw invalid("Cloud Run current snapshot이 observe_only + unconfigured가 아닙니다.");
  }
  return v2;
}

interface CloudRunSnapshot {
  readonly uid: string;
  readonly generation: string;
  readonly imageDigest: string;
  readonly gitCommitSha: string;
  readonly workerMode: string;
  readonly claimScope: string;
}

interface CloudRunV2Snapshot extends CloudRunSnapshot {
  readonly etag: string;
  readonly updateTime: string;
  readonly observedGeneration: string;
  readonly reconciling: boolean;
}

function parseCloudRunV1(raw: string): CloudRunSnapshot {
  const job = parseObject(raw, "gcloud Cloud Run job");
  if (job.apiVersion !== "run.googleapis.com/v1" || job.kind !== "Job") {
    throw invalid("gcloud Cloud Run job schema가 run.googleapis.com/v1 Job이 아닙니다.");
  }
  const metadata = requiredRecord(job.metadata, "gcloud metadata");
  if (requiredString(metadata.name, "gcloud job name") !== JOB) {
    throw invalid("gcloud job name이 고정 대상과 다릅니다.");
  }
  const status = requiredRecord(job.status, "gcloud status");
  const generation = int64String(metadata.generation, "gcloud generation");
  if (int64String(status.observedGeneration, "gcloud observedGeneration") !== generation) {
    throw invalid("gcloud observedGeneration이 현재 generation과 다릅니다.");
  }
  const spec = requiredRecord(job.spec, "gcloud spec");
  const executionTemplate = requiredRecord(spec.template, "gcloud execution template");
  const executionSpec = requiredRecord(executionTemplate.spec, "gcloud execution spec");
  const taskTemplate = requiredRecord(executionSpec.template, "gcloud task template");
  const taskSpec = requiredRecord(taskTemplate.spec, "gcloud task spec");
  const container = onlyContainer(taskSpec.containers, "gcloud containers");
  return {
    uid: requiredString(metadata.uid, "gcloud job UID"),
    generation,
    ...containerSnapshot(container, "gcloud"),
  };
}

function parseCloudRunV2(raw: string): CloudRunV2Snapshot {
  const job = parseObject(raw, "Cloud Run v2 job");
  const expectedName = `projects/${PROJECT}/locations/${REGION}/jobs/${JOB}`;
  if (requiredString(job.name, "Cloud Run v2 job name") !== expectedName) {
    throw invalid("Cloud Run v2 job name이 고정 project/region/job과 다릅니다.");
  }
  const executionTemplate = requiredRecord(job.template, "Cloud Run v2 execution template");
  const taskTemplate = requiredRecord(executionTemplate.template, "Cloud Run v2 task template");
  const container = onlyContainer(taskTemplate.containers, "Cloud Run v2 containers");
  return {
    uid: requiredString(job.uid, "Cloud Run v2 job UID"),
    generation: int64String(job.generation, "Cloud Run v2 generation"),
    etag: requiredString(job.etag, "Cloud Run v2 etag"),
    updateTime: isoString(job.updateTime, "Cloud Run v2 updateTime"),
    observedGeneration: int64String(
      job.observedGeneration,
      "Cloud Run v2 observedGeneration",
    ),
    reconciling: job.reconciling === undefined
      ? false
      : requiredBoolean(job.reconciling, "Cloud Run v2 reconciling"),
    ...containerSnapshot(container, "Cloud Run v2"),
  };
}

function containerSnapshot(
  container: Record<string, unknown>,
  label: string,
): Omit<CloudRunSnapshot, "uid" | "generation"> {
  const image = requiredString(container.image, `${label} image`);
  const digest = image.match(/@(sha256:[a-f0-9]{64})$/u)?.[1];
  if (!digest) throw invalid(`${label} image digest가 immutable digest 형식이 아닙니다.`);
  const env = literalEnvironment(container.env, label);
  return {
    imageDigest: digest,
    gitCommitSha: requiredEnv(env, "GIT_COMMIT_SHA", label),
    workerMode: requiredEnv(env, "DEEP_ANALYSIS_WORKER_MODE", label),
    claimScope: requiredEnv(env, "DEEP_ANALYSIS_CLAIM_SCOPE", label),
  };
}

function assertSnapshot(
  evidence: DeepRepairOperationalEvidence,
  current: CloudRunSnapshot,
  label: string,
): void {
  if (current.uid !== evidence.jobUid) throw invalid(`${label} job UID가 evidence와 다릅니다.`);
  if (current.generation !== evidence.jobGeneration) {
    throw invalid(`${label} generation이 evidence와 다릅니다.`);
  }
  if (current.imageDigest !== evidence.imageDigest) {
    throw invalid(`${label} image digest가 evidence와 다릅니다.`);
  }
  if (current.gitCommitSha !== evidence.gitCommitSha) {
    throw invalid(`${label} GIT_COMMIT_SHA가 evidence와 다릅니다.`);
  }
  if (current.workerMode !== evidence.workerMode || current.workerMode !== "observe_only") {
    throw invalid(`${label} worker mode가 observe_only evidence와 다릅니다.`);
  }
  if (current.claimScope !== evidence.claimScope || current.claimScope !== "unconfigured") {
    throw invalid(`${label} claim scope가 unconfigured evidence와 다릅니다.`);
  }
}

function assertSameSnapshot(v1: CloudRunSnapshot, v2: CloudRunSnapshot): void {
  for (const [label, left, right] of [
    ["job UID", v1.uid, v2.uid],
    ["generation", v1.generation, v2.generation],
    ["image digest", v1.imageDigest, v2.imageDigest],
    ["GIT_COMMIT_SHA", v1.gitCommitSha, v2.gitCommitSha],
    ["worker mode", v1.workerMode, v2.workerMode],
    ["claim scope", v1.claimScope, v2.claimScope],
  ] as const) {
    if (left !== right) throw invalid(`gcloud v1과 Cloud Run v2의 ${label} snapshot이 다릅니다.`);
  }
}

function assertEvidenceTarget(evidence: DeepRepairOperationalEvidence): void {
  if (
    evidence.project !== PROJECT
    || evidence.region !== REGION
    || evidence.job !== JOB
    || evidence.workerMode !== "observe_only"
    || evidence.claimScope !== "unconfigured"
  ) {
    throw invalid("operational evidence가 Gate R의 고정 운영 대상과 다릅니다.");
  }
}

function literalEnvironment(value: unknown, label: string): ReadonlyMap<string, string> {
  if (!Array.isArray(value)) throw invalid(`${label} env가 배열이 아닙니다.`);
  const result = new Map<string, string>();
  for (const item of value) {
    const entry = requiredRecord(item, `${label} env entry`);
    const name = requiredString(entry.name, `${label} env name`);
    if (result.has(name)) throw invalid(`${label} env에 ${name}가 중복됐습니다.`);
    if (typeof entry.value === "string") result.set(name, entry.value);
  }
  return result;
}

function requiredEnv(env: ReadonlyMap<string, string>, name: string, label: string): string {
  const value = env.get(name);
  if (value === undefined) throw invalid(`${label} ${name} literal env가 없습니다.`);
  return value;
}

function onlyContainer(value: unknown, label: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) {
    throw invalid(`${label}가 exact one-container 구성이 아닙니다.`);
  }
  return requiredRecord(value[0], `${label}[0]`);
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  try {
    return requiredRecord(JSON.parse(raw) as unknown, label);
  } catch (error) {
    if (error instanceof DeepRepairLiveExecutionError) throw error;
    throw invalid(`${label} JSON을 파싱할 수 없습니다.`);
  }
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${label}가 object가 아닙니다.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw invalid(`${label}가 없습니다.`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${label}가 boolean이 아닙니다.`);
  return value;
}

function int64String(value: unknown, label: string): string {
  if (typeof value === "string" && /^\d+$/u.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw invalid(`${label}이 non-negative int64가 아닙니다.`);
}

function isoString(value: unknown, label: string): string {
  const raw = requiredString(value, label);
  if (!Number.isFinite(new Date(raw).getTime())) throw invalid(`${label}이 ISO 시각이 아닙니다.`);
  return raw;
}

function commandOptions(signal: AbortSignal, input?: string): ExecFileOptions {
  return {
    signal,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    ...(input === undefined ? {} : { input }),
  };
}

async function runSensitive(
  run: DeepRepairOperationalGuardExecFile,
  file: string,
  args: readonly string[],
  signal: AbortSignal,
  label: string,
  input?: string,
): Promise<string> {
  try {
    return (await run(file, args, commandOptions(signal, input))).stdout;
  } catch {
    throw invalid(`${label} 조회에 실패했습니다.`);
  }
}

async function runExecFile(
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, [...args], {
      signal: options.signal,
      encoding: options.encoding,
      maxBuffer: options.maxBuffer,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout });
    });
    child.stdin?.end(options.input);
  });
}

function invalid(message: string): DeepRepairLiveExecutionError {
  return new DeepRepairLiveExecutionError("production_guard_invalid", message, true);
}
