import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  evaluateDeepAnalysisServingCloudObservation,
  type DeepAnalysisServingCloudEvaluation,
  type DeepAnalysisServingCloudRunExecution,
  type DeepAnalysisServingSchedulerConfig,
  type DeepAnalysisServingSchedulerLog,
} from "./servingObservationCloud";

const execFileAsync = promisify(execFile);
const PROJECT = "changupnote-com";
const REGION = "asia-northeast3";
const JOB = "cunote-deep-analysis-serving-monitor";
const SCHEDULER = "cunote-deep-analysis-serving-monitor-scheduler";
const SERVICE_ACCOUNT =
  "cunote-deep-analysis@changupnote-com.iam.gserviceaccount.com";
const TARGET_URI =
  "https://asia-northeast3-run.googleapis.com/apis/run.googleapis.com/v1/"
  + "namespaces/changupnote-com/jobs/cunote-deep-analysis-serving-monitor:run";

export async function readAndEvaluateDeepAnalysisServingCloudObservation(input: {
  start: Date;
  end: Date;
  now: Date;
  receiptExecutionIds: string[];
}): Promise<DeepAnalysisServingCloudEvaluation> {
  const schedulerLogFilter = [
    'resource.type="cloud_scheduler_job"',
    `resource.labels.job_id="${SCHEDULER}"`,
    `timestamp>="${input.start.toISOString()}"`,
    `timestamp<"${input.end.toISOString()}"`,
  ].join(" AND ");
  const [account, configuredProject, schedulerRaw, logsRaw, executionsRaw] =
    await Promise.all([
      runGcloud([
        "auth",
        "list",
        "--filter=status:ACTIVE",
        "--format=value(account)",
      ]),
      runGcloud(["config", "get-value", "project"]),
      runGcloud([
        "scheduler",
        "jobs",
        "describe",
        SCHEDULER,
        `--project=${PROJECT}`,
        `--location=${REGION}`,
        "--format=json",
      ]),
      runGcloud([
        "logging",
        "read",
        schedulerLogFilter,
        `--project=${PROJECT}`,
        "--order=asc",
        "--limit=1000",
        "--format=json",
      ]),
      runGcloud([
        "run",
        "jobs",
        "executions",
        "list",
        `--job=${JOB}`,
        `--project=${PROJECT}`,
        `--region=${REGION}`,
        "--limit=1000",
        "--format=json",
      ]),
    ]);

  return evaluateDeepAnalysisServingCloudObservation({
    start: input.start,
    end: input.end,
    now: input.now,
    account: account.trim(),
    expectedAccount: "sw@noten.im",
    project: configuredProject.trim(),
    expectedProject: PROJECT,
    scheduler: parseSchedulerConfig(parseJsonObject(schedulerRaw)),
    expectedScheduler: {
      state: "ENABLED",
      schedule: "5,35 * * * *",
      timeZone: "Asia/Seoul",
      retryCount: 0,
      maxRetryDuration: "0s",
      targetUri: TARGET_URI,
      oauthServiceAccount: SERVICE_ACCOUNT,
    },
    schedulerLogs: parseSchedulerLogs(parseJsonArray(logsRaw)),
    executions: parseExecutions(parseJsonArray(executionsRaw)),
    receiptExecutionIds: input.receiptExecutionIds,
  });
}

async function runGcloud(args: string[]): Promise<string> {
  const result = await execFileAsync("gcloud", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return result.stdout;
}

function parseSchedulerConfig(value: Record<string, unknown>): DeepAnalysisServingSchedulerConfig {
  const retryConfig = asRecord(value.retryConfig);
  const httpTarget = asRecord(value.httpTarget);
  const oauthToken = asRecord(httpTarget.oauthToken);
  return {
    state: asString(value.state),
    schedule: asString(value.schedule),
    timeZone: asString(value.timeZone),
    retryCount: asNumber(retryConfig.retryCount) ?? 0,
    maxRetryDuration: asString(retryConfig.maxRetryDuration),
    targetUri: asString(httpTarget.uri),
    oauthServiceAccount: asString(oauthToken.serviceAccountEmail),
  };
}

function parseSchedulerLogs(values: unknown[]): DeepAnalysisServingSchedulerLog[] {
  const entries: DeepAnalysisServingSchedulerLog[] = [];
  for (const value of values) {
    const entry = asRecord(value);
    const payload = asRecord(entry.jsonPayload);
    const payloadType = asString(payload["@type"]);
    const type = payloadType?.endsWith(".AttemptStarted")
      ? "started"
      : payloadType?.endsWith(".AttemptFinished")
        ? "finished"
        : null;
    if (!type) continue;
    const timestamp = parseDate(entry.timestamp, "scheduler log timestamp");
    const httpRequest = asRecord(entry.httpRequest);
    entries.push({
      type,
      timestamp,
      scheduledTime: payload.scheduledTime
        ? parseDate(payload.scheduledTime, "scheduler scheduledTime")
        : null,
      httpStatus: asNumber(httpRequest.status),
    });
  }
  return entries;
}

function parseExecutions(values: unknown[]): DeepAnalysisServingCloudRunExecution[] {
  return values.map((value) => {
    const execution = asRecord(value);
    const metadata = asRecord(execution.metadata);
    const status = asRecord(execution.status);
    const conditions = Array.isArray(status.conditions) ? status.conditions : [];
    const completed = conditions.some((condition) => {
      const record = asRecord(condition);
      return record.type === "Completed" && record.status === "True";
    });
    return {
      name: requiredString(metadata.name, "Cloud Run execution name"),
      startTime: parseDate(status.startTime, "Cloud Run startTime"),
      completionTime: status.completionTime
        ? parseDate(status.completionTime, "Cloud Run completionTime")
        : null,
      succeededCount: asNumber(status.succeededCount) ?? 0,
      failedCount: asNumber(status.failedCount) ?? 0,
      completed,
    };
  });
}

function parseJsonObject(value: string): Record<string, unknown> {
  return asRecord(JSON.parse(value));
}

function parseJsonArray(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("gcloud JSON output is not an array");
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requiredString(value: unknown, label: string): string {
  const parsed = asString(value);
  if (!parsed) throw new Error(`${label} is missing`);
  return parsed;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function parseDate(value: unknown, label: string): Date {
  const raw = requiredString(value, label);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed;
}
