import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { runConversionPollSweep } from "@/lib/server/conversion/pollSweep";
import { runBizInfoAttachmentArchiveBatch } from "@/lib/server/ingestion/bizinfoAttachmentArchiveBatch";
import { runKStartupAttachmentArchiveBatch } from "@/lib/server/ingestion/kstartupAttachmentArchiveBatch";
import { activeDeepAnalysisGrantPredicate } from "./eligibility";
import { prepareDeepAnalysisInput } from "./prepareInput";

export const DEEP_ANALYSIS_INPUT_PREPARATION_SCHEMA =
  "deep-analysis-input-preparation-v1" as const;

export interface DeepAnalysisInputPreparationPolicy {
  modelPolicyVersion: string;
  maxGrantsPerSource: number;
  maxAttachmentsPerGrant: number;
  maxTotalAttachmentsPerSource: number;
  scanLimit: number;
  conversionLimit: number;
  deadlineSeconds: number;
}

export interface DeepAnalysisInputPreparationTarget {
  grantId: string;
  source: "kstartup" | "bizinfo";
  sourceId: string;
  title: string;
  applyEnd: Date | null;
  jobUpdatedAt: Date;
}

export interface DeepAnalysisInputPreparationResult {
  schema: typeof DEEP_ANALYSIS_INPUT_PREPARATION_SCHEMA;
  generatedAt: string;
  policy: DeepAnalysisInputPreparationPolicy;
  targetCount: number;
  targetsBySource: Record<"kstartup" | "bizinfo", number>;
  targets: Array<{
    grantId: string;
    source: "kstartup" | "bizinfo";
    sourceId: string;
  }>;
  archive: {
    kstartup: Awaited<ReturnType<typeof runKStartupAttachmentArchiveBatch>> | null;
    bizinfo: Awaited<ReturnType<typeof runBizInfoAttachmentArchiveBatch>> | null;
  };
  conversion: Awaited<ReturnType<typeof runConversionPollSweep>>;
  after: Array<{
    grantId: string;
    source: "kstartup" | "bizinfo";
    sourceId: string;
    sealed: boolean;
    blockerCodes: string[];
    blockerCount: number;
    sourceRevisionSha256: string | null;
    error: string | null;
  }>;
  sealedCount: number;
  unresolvedCount: number;
  elapsedMs: number;
}

/**
 * 현재 policy에서 input_not_sealed로 멈춘 활성 공고를 source별 bounded batch로 고른다.
 * 같은 공고의 과거 blocked revision은 최신 job 하나로 접고, 마감이 가까운 공고를 우선한다.
 */
export async function listDeepAnalysisInputPreparationTargets(input: {
  db: CunoteDb;
  policy: DeepAnalysisInputPreparationPolicy;
  now?: Date;
}): Promise<DeepAnalysisInputPreparationTarget[]> {
  const now = input.now ?? new Date();
  const rows = await input.db
    .select({
      grantId: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      applyEnd: schema.grants.applyEnd,
      jobUpdatedAt: schema.grantDeepAnalysisJobs.updatedAt,
    })
    .from(schema.grantDeepAnalysisJobs)
    .innerJoin(
      schema.grants,
      eq(schema.grants.id, schema.grantDeepAnalysisJobs.grantId),
    )
    .where(and(
      eq(
        schema.grantDeepAnalysisJobs.modelPolicyVersion,
        input.policy.modelPolicyVersion,
      ),
      eq(schema.grantDeepAnalysisJobs.status, "blocked"),
      eq(schema.grantDeepAnalysisJobs.lastErrorCode, "input_not_sealed"),
      activeDeepAnalysisGrantPredicate(now),
      sql`NOT EXISTS (
        SELECT 1
        FROM grant_deep_analysis_jobs AS newer_input_job
        WHERE newer_input_job.grant_id = ${schema.grantDeepAnalysisJobs.grantId}
          AND newer_input_job.model_policy_version =
              ${schema.grantDeepAnalysisJobs.modelPolicyVersion}
          AND (
            newer_input_job.created_at > ${schema.grantDeepAnalysisJobs.createdAt}
            OR (
              newer_input_job.created_at = ${schema.grantDeepAnalysisJobs.createdAt}
              AND newer_input_job.id > ${schema.grantDeepAnalysisJobs.id}
            )
          )
      )`,
    ))
    .orderBy(
      asc(schema.grants.applyEnd),
      asc(schema.grants.source),
      asc(schema.grants.sourceId),
      desc(schema.grantDeepAnalysisJobs.updatedAt),
    )
    .limit(500);

  const seen = new Set<string>();
  const candidatesBySource = new Map<
    "kstartup" | "bizinfo",
    DeepAnalysisInputPreparationTarget[]
  >([
    ["kstartup", []],
    ["bizinfo", []],
  ]);
  for (const row of rows) {
    if (row.source !== "kstartup" && row.source !== "bizinfo") continue;
    if (seen.has(row.grantId)) continue;
    seen.add(row.grantId);
    candidatesBySource.get(row.source)?.push({
      grantId: row.grantId,
      source: row.source,
      sourceId: row.sourceId,
      title: row.title,
      applyEnd: row.applyEnd,
      jobUpdatedAt: row.jobUpdatedAt,
    });
  }
  return (["kstartup", "bizinfo"] as const).flatMap((source) =>
    selectRotatingTargetWindow(
      candidatesBySource.get(source) ?? [],
      input.policy.maxGrantsPerSource,
      now,
    ));
}

/**
 * 문서 원본 보관·변환만 수행한다. LLM 호출·promotion·matcher write는 이 함수에 없다.
 * 실행 후 같은 target을 다시 seal해 준비 단계가 실제로 전진했는지 구조화 결과로 남긴다.
 */
export async function runDeepAnalysisInputPreparation(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  policy: DeepAnalysisInputPreparationPolicy;
  now?: Date;
  listTargets?: typeof listDeepAnalysisInputPreparationTargets;
  runKStartupArchive?: typeof runKStartupAttachmentArchiveBatch;
  runBizInfoArchive?: typeof runBizInfoAttachmentArchiveBatch;
  runConversionSweep?: typeof runConversionPollSweep;
  prepareInput?: typeof prepareDeepAnalysisInput;
}): Promise<DeepAnalysisInputPreparationResult> {
  const startedAt = Date.now();
  const now = input.now ?? new Date();
  const deadlineAtMs = startedAt + input.policy.deadlineSeconds * 1_000;
  const targets = await (
    input.listTargets ?? listDeepAnalysisInputPreparationTargets
  )({
    db: input.db,
    policy: input.policy,
    now,
  });
  const kstartupTargets = targets.filter((target) => target.source === "kstartup");
  const bizinfoTargets = targets.filter((target) => target.source === "bizinfo");

  const kstartup = kstartupTargets.length > 0
    ? await (input.runKStartupArchive ?? runKStartupAttachmentArchiveBatch)({
      db: input.db,
      storage: input.storage,
      scanLimit: input.policy.scanLimit,
      asOf: now,
      collectedAt: new Date(),
      write: true,
      convertHwp: true,
      allowFailures: true,
      maxGrants: input.policy.maxGrantsPerSource,
      maxTotalAttachments: input.policy.maxTotalAttachmentsPerSource,
      maxAttachmentsPerGrant: input.policy.maxAttachmentsPerGrant,
      sourceIds: kstartupTargets.map((target) => target.sourceId),
      deadlineAtMs,
    })
    : null;

  const bizinfo = bizinfoTargets.length > 0
    ? await (input.runBizInfoArchive ?? runBizInfoAttachmentArchiveBatch)({
      db: input.db,
      storage: input.storage,
      scanLimit: input.policy.scanLimit,
      asOf: now,
      collectedAt: new Date(),
      write: true,
      convertHwp: true,
      maxGrants: input.policy.maxGrantsPerSource,
      maxTotalAttachments: input.policy.maxTotalAttachmentsPerSource,
      maxAttachmentsPerGrant: input.policy.maxAttachmentsPerGrant,
      sourceIds: bizinfoTargets.map((target) => target.sourceId),
      deadlineAtMs,
    })
    : null;

  const remainingBudgetMs = Math.max(1_000, deadlineAtMs - Date.now());
  const conversion = targets.length > 0
    ? await (input.runConversionSweep ?? runConversionPollSweep)(input.db, {
      limit: input.policy.conversionLimit,
      sourceIds: targets.map((target) => target.sourceId),
      budgetMs: remainingBudgetMs,
      maxAttempts: 60,
      intervalMs: 250,
    })
    : {
      ok: true,
      pendingCount: 0,
      previewReady: 0,
      failed: 0,
      stillPending: 0,
      skipped: 0,
      budgetExhausted: false,
      elapsedMs: 0,
      results: [],
    };

  const prepare = input.prepareInput ?? prepareDeepAnalysisInput;
  const after = [];
  for (const target of targets) {
    try {
      const seal = await prepare({
        db: input.db,
        storage: input.storage,
        grantId: target.grantId,
      });
      after.push({
        grantId: target.grantId,
        source: target.source,
        sourceId: target.sourceId,
        sealed: seal.sealed,
        blockerCodes: [...new Set(seal.blockers.map((blocker) => blocker.code))],
        blockerCount: seal.blockers.length,
        sourceRevisionSha256: seal.sourceRevisionSha256,
        error: null,
      });
    } catch (error) {
      after.push({
        grantId: target.grantId,
        source: target.source,
        sourceId: target.sourceId,
        sealed: false,
        blockerCodes: ["preparation_verification_failed"],
        blockerCount: 1,
        sourceRevisionSha256: null,
        error: error instanceof Error
          ? error.message.slice(0, 500)
          : String(error).slice(0, 500),
      });
    }
  }

  return {
    schema: DEEP_ANALYSIS_INPUT_PREPARATION_SCHEMA,
    generatedAt: new Date().toISOString(),
    policy: input.policy,
    targetCount: targets.length,
    targetsBySource: {
      kstartup: kstartupTargets.length,
      bizinfo: bizinfoTargets.length,
    },
    targets: targets.map(({ grantId, source, sourceId }) => ({
      grantId,
      source,
      sourceId,
    })),
    archive: { kstartup, bizinfo },
    conversion,
    after,
    sealedCount: after.filter((item) => item.sealed).length,
    unresolvedCount: after.filter((item) => !item.sealed).length,
    elapsedMs: Date.now() - startedAt,
  };
}

export function resolveDeepAnalysisInputPreparationPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeepAnalysisInputPreparationPolicy {
  return {
    modelPolicyVersion:
      env.DEEP_ANALYSIS_MODEL_POLICY_VERSION?.trim()
      || "deep-analysis-model-policy-v3",
    maxGrantsPerSource: boundedEnvInt(
      env.DEEP_ANALYSIS_PREPARE_MAX_GRANTS_PER_SOURCE,
      2,
      1,
      20,
      "DEEP_ANALYSIS_PREPARE_MAX_GRANTS_PER_SOURCE",
    ),
    maxAttachmentsPerGrant: boundedEnvInt(
      env.DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_GRANT,
      10,
      1,
      10,
      "DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_GRANT",
    ),
    maxTotalAttachmentsPerSource: boundedEnvInt(
      env.DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_SOURCE,
      20,
      1,
      200,
      "DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_SOURCE",
    ),
    scanLimit: boundedEnvInt(
      env.DEEP_ANALYSIS_PREPARE_SCAN_LIMIT,
      2_000,
      100,
      5_000,
      "DEEP_ANALYSIS_PREPARE_SCAN_LIMIT",
    ),
    conversionLimit: boundedEnvInt(
      env.DEEP_ANALYSIS_PREPARE_CONVERSION_LIMIT,
      10,
      1,
      100,
      "DEEP_ANALYSIS_PREPARE_CONVERSION_LIMIT",
    ),
    deadlineSeconds: boundedEnvInt(
      env.DEEP_ANALYSIS_PREPARE_DEADLINE_SECONDS,
      480,
      60,
      900,
      "DEEP_ANALYSIS_PREPARE_DEADLINE_SECONDS",
    ),
  };
}

function boundedEnvInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * 마감이 가장 가까운 1건은 항상 포함하고, 나머지는 10분 epoch마다 순환한다.
 * 영구 변환 blocker 한두 건이 source별 bounded worker 용량을 계속 독점하지 않으면서도
 * D-day 우선순위는 잃지 않는다.
 */
export function selectRotatingTargetWindow<T>(
  candidates: readonly T[],
  limit: number,
  now: Date,
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];
  if (candidates.length <= limit) return [...candidates];
  const selected = [candidates[0]!];
  if (limit === 1) return selected;
  const rest = candidates.slice(1);
  const offset = Math.floor(now.getTime() / 600_000) % rest.length;
  for (let index = 0; selected.length < limit; index += 1) {
    selected.push(rest[(offset + index) % rest.length]!);
  }
  return selected;
}
