import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  DEEP_ANALYSIS_MODEL_POLICY_VERSION,
  DEEP_ANALYSIS_PROMPT_VERSION,
} from "@cunote/contracts";
import postgres from "postgres";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { findMonorepoRoot } from "../analysis-lab/run-store";
import {
  assertDeepAnalysisLayerRebuildConfirmation,
  assertDeepAnalysisLayerRebuildPreconditions,
  createDeepAnalysisLayerRebuildPlan,
  DEEP_ANALYSIS_LAYER_REBUILD_LOCK,
  type DeepAnalysisLayerCounts,
  type DeepAnalysisLayerKeepRun,
  type DeepAnalysisLayerRebuildMode,
  type DeepAnalysisLayerRebuildPlan,
  type DeepAnalysisLayerRebuildState,
} from "./analysisLayerRebuild";

loadMonorepoEnv();

type QueryClient = postgres.Sql | postgres.TransactionSql;

interface KeepRunRow {
  id: string;
  job_id: string;
  run_id: string;
  grant_id: string;
  title: string;
  completed_at: Date;
  cost_usd: string | null;
  latest_audit_verdict: string;
  automation_route: string | null;
}

interface CountRow {
  grants: number;
  attachment_archives: number;
  application_surfaces: number;
  document_artifacts: number;
  non_field_document_artifacts: number;
  page_image_artifacts: number;
  jobs: number;
  worker_heartbeats: number;
  runs: number;
  stage_receipts: number;
  axis_results: number;
  audits: number;
  exception_events: number;
  promotion_releases: number;
  promotion_items: number;
  criteria: number;
  confirmation_questions: number;
  company_confirmations: number;
  match_state: number;
  landing_observations: number;
  application_precompute_jobs: number;
  application_precompute_attempts: number;
  application_precompute_worker_heartbeats: number;
  field_candidate_artifacts: number;
  document_fields: number;
  fields_ready_surfaces: number;
  leased_jobs: number;
  leased_application_precompute_jobs: number;
  leased_application_precompute_attempts: number;
}

interface ResetResult {
  deleted: DeepAnalysisLayerRebuildState["delete"];
  reset: DeepAnalysisLayerRebuildState["reset"];
  detachedAdminActions: number;
  detachedAggregateChildren: number;
}

interface RebuildBuildSource {
  gitCommit: string;
  gitTree: string;
  gitDirty: boolean;
  implementationSha256: string;
}

const REBUILD_IMPLEMENTATION_PATHS = [
  "apps/web/src/lib/server/deep-analysis/analysisLayerRebuild.ts",
  "apps/web/src/lib/server/deep-analysis/rebuild-analysis-layer-cli.ts",
] as const;

const RESET_APPEND_ONLY_TRIGGERS = [
  {
    table: "admin_deep_analysis_actions",
    trigger: "admin_deep_analysis_actions_append_only",
  },
  {
    table: "grant_deep_analysis_audits",
    trigger: "grant_deep_analysis_audits_append_only",
  },
  {
    table: "grant_deep_analysis_axis_results",
    trigger: "grant_deep_analysis_axis_results_append_only",
  },
  {
    table: "grant_deep_analysis_exception_events",
    trigger: "grant_deep_analysis_exception_events_append_only",
  },
  {
    table: "grant_deep_analysis_stage_receipts",
    trigger: "grant_deep_analysis_stage_receipts_append_only",
  },
] as const;

const RESET_MUTATION_TABLES = [
  "admin_deep_analysis_actions",
  "analysis_lab_promotion_items",
  "analysis_lab_promotion_releases",
  "company_grant_confirmations",
  "document_artifacts",
  "grant_aggregate_split_children",
  "grant_application_precompute_attempts",
  "grant_application_precompute_jobs",
  "grant_application_precompute_worker_heartbeats",
  "grant_application_surfaces",
  "grant_confirmation_questions",
  "grant_criteria",
  "grant_deep_analysis_audits",
  "grant_deep_analysis_axis_results",
  "grant_deep_analysis_exception_events",
  "grant_deep_analysis_jobs",
  "grant_deep_analysis_runs",
  "grant_deep_analysis_stage_receipts",
  "grant_deep_analysis_worker_heartbeats",
  "grant_document_fields",
  "match_state",
  "usage_events",
] as const;

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: findMonorepoRoot(),
    encoding: "utf8",
  }).trim();
}

function readBuildSource(requireClean: boolean): RebuildBuildSource {
  const gitDirty = Boolean(git(["status", "--porcelain"]));
  if (requireClean && gitDirty) {
    throw new Error("분석계층 재구축 write는 clean git tree에서만 가능합니다.");
  }
  const implementationSha256 = createHash("sha256");
  for (const path of REBUILD_IMPLEMENTATION_PATHS) {
    implementationSha256.update(`${path}\0${git(["hash-object", "--", path])}\n`);
  }
  return {
    gitCommit: git(["rev-parse", "HEAD"]),
    gitTree: git(["rev-parse", "HEAD^{tree}"]),
    gitDirty,
    implementationSha256: implementationSha256.digest("hex"),
  };
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL
    ?? process.env.SUPABASE_DB_URL
    ?? process.env.DIRECT_URL;
  if (!value) {
    throw new Error(
      "DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.",
    );
  }
  return value;
}

async function loadKeepRuns(
  client: QueryClient,
): Promise<DeepAnalysisLayerKeepRun[]> {
  const rows = await client.unsafe<KeepRunRow[]>(`
    with latest_job as (
      select distinct on (job.grant_id)
        job.id,
        job.grant_id,
        job.status,
        job.created_at
      from grant_deep_analysis_jobs job
      where job.model_policy_version = $1
      order by job.grant_id, job.created_at desc, job.id desc
    ),
    latest_run as (
      select distinct on (run.job_id)
        run.*
      from grant_deep_analysis_runs run
      join latest_job job on job.id = run.job_id
      order by run.job_id, run.started_at desc, run.id desc
    )
    select
      run.id,
      run.job_id,
      run.run_id,
      run.grant_id,
      notice.title,
      run.completed_at,
      run.cost_usd,
      latest_audit.verdict as latest_audit_verdict,
      analysis_receipt.evidence->>'automationRoute' as automation_route
    from latest_run run
    join latest_job job on job.id = run.job_id
    join grants notice on notice.id = run.grant_id
    join lateral (
      select audit.verdict
      from grant_deep_analysis_audits audit
      where audit.run_id = run.id
      order by audit.attempt desc, audit.id desc
      limit 1
    ) latest_audit on true
    join lateral (
      select receipt.status, receipt.evidence
      from grant_deep_analysis_stage_receipts receipt
      where receipt.run_id = run.id
        and receipt.stage = 'analysis_complete'
      order by receipt.attempt desc, receipt.id desc
      limit 1
    ) analysis_receipt on true
    where job.status = 'succeeded'
      and run.status = 'passed'
      and run.model_policy_version = $1
      and run.prompt_version = $2
      and run.completed_at is not null
      and analysis_receipt.status = 'passed'
      and latest_audit.verdict in ('concur', 'unsure')
      and (
        select count(*)
        from grant_deep_analysis_axis_results axis
        where axis.run_id = run.id
      ) = 22
    order by run.grant_id
  `, [
    DEEP_ANALYSIS_MODEL_POLICY_VERSION,
    DEEP_ANALYSIS_PROMPT_VERSION,
  ]);
  return rows.map((row) => ({
    id: row.id,
    jobId: row.job_id,
    runId: row.run_id,
    grantId: row.grant_id,
    title: row.title,
    completedAt: row.completed_at.toISOString(),
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    latestAuditVerdict: row.latest_audit_verdict,
    automationRoute: row.automation_route,
  }));
}

async function loadCounts(client: QueryClient): Promise<DeepAnalysisLayerCounts> {
  const [row] = await client.unsafe<CountRow[]>(`
    select
      (select count(*)::int from grants) as grants,
      (select count(*)::int from grant_attachment_archives) as attachment_archives,
      (select count(*)::int from grant_application_surfaces) as application_surfaces,
      (select count(*)::int from document_artifacts) as document_artifacts,
      (
        select count(*)::int
        from document_artifacts
        where kind <> 'field_candidates'
      ) as non_field_document_artifacts,
      (
        select count(*)::int
        from document_artifacts
        where kind = 'page_image'
      ) as page_image_artifacts,
      (select count(*)::int from grant_deep_analysis_jobs) as jobs,
      (select count(*)::int from grant_deep_analysis_worker_heartbeats) as worker_heartbeats,
      (select count(*)::int from grant_deep_analysis_runs) as runs,
      (select count(*)::int from grant_deep_analysis_stage_receipts) as stage_receipts,
      (select count(*)::int from grant_deep_analysis_axis_results) as axis_results,
      (select count(*)::int from grant_deep_analysis_audits) as audits,
      (select count(*)::int from grant_deep_analysis_exception_events) as exception_events,
      (select count(*)::int from analysis_lab_promotion_releases) as promotion_releases,
      (select count(*)::int from analysis_lab_promotion_items) as promotion_items,
      (select count(*)::int from grant_criteria) as criteria,
      (select count(*)::int from grant_confirmation_questions) as confirmation_questions,
      (select count(*)::int from company_grant_confirmations) as company_confirmations,
      (select count(*)::int from match_state) as match_state,
      (
        select count(*)::int
        from usage_events
        where feature_code = 'landing_match_observation'
      ) as landing_observations,
      (
        select count(*)::int
        from grant_application_precompute_jobs
      ) as application_precompute_jobs,
      (
        select count(*)::int
        from grant_application_precompute_attempts
      ) as application_precompute_attempts,
      (
        select count(*)::int
        from grant_application_precompute_worker_heartbeats
      ) as application_precompute_worker_heartbeats,
      (
        select count(*)::int
        from document_artifacts
        where kind = 'field_candidates'
      ) as field_candidate_artifacts,
      (select count(*)::int from grant_document_fields) as document_fields,
      (
        select count(*)::int
        from grant_application_surfaces
        where extraction_status = 'fields_ready'
      ) as fields_ready_surfaces,
      (
        select count(*)::int
        from grant_deep_analysis_jobs
        where status = 'leased'
      ) as leased_jobs,
      (
        select count(*)::int
        from grant_application_precompute_jobs
        where status = 'leased'
      ) as leased_application_precompute_jobs,
      (
        select count(*)::int
        from grant_application_precompute_attempts
        where status = 'leased'
      ) as leased_application_precompute_attempts
  `);
  if (!row) throw new Error("분석계층 count를 읽지 못했습니다.");
  return {
    grants: row.grants,
    attachmentArchives: row.attachment_archives,
    applicationSurfaces: row.application_surfaces,
    documentArtifacts: row.document_artifacts,
    nonFieldDocumentArtifacts: row.non_field_document_artifacts,
    pageImageArtifacts: row.page_image_artifacts,
    jobs: row.jobs,
    workerHeartbeats: row.worker_heartbeats,
    runs: row.runs,
    stageReceipts: row.stage_receipts,
    axisResults: row.axis_results,
    audits: row.audits,
    exceptionEvents: row.exception_events,
    promotionReleases: row.promotion_releases,
    promotionItems: row.promotion_items,
    criteria: row.criteria,
    confirmationQuestions: row.confirmation_questions,
    companyConfirmations: row.company_confirmations,
    matchState: row.match_state,
    landingObservations: row.landing_observations,
    applicationPrecomputeJobs: row.application_precompute_jobs,
    applicationPrecomputeAttempts: row.application_precompute_attempts,
    applicationPrecomputeWorkerHeartbeats:
      row.application_precompute_worker_heartbeats,
    fieldCandidateArtifacts: row.field_candidate_artifacts,
    documentFields: row.document_fields,
    fieldsReadySurfaces: row.fields_ready_surfaces,
    leasedJobs: row.leased_jobs,
    leasedApplicationPrecomputeJobs:
      row.leased_application_precompute_jobs,
    leasedApplicationPrecomputeAttempts:
      row.leased_application_precompute_attempts,
  };
}

async function countPreserved(
  client: QueryClient,
  keepRunIds: string[],
  keepJobIds: string[],
  before: DeepAnalysisLayerCounts,
): Promise<DeepAnalysisLayerRebuildState["preserve"]> {
  const [row] = await client.unsafe<Array<{
    stage_receipts: number;
    axis_results: number;
    audits: number;
    exception_events: number;
  }>>(`
    select
      (
        select count(*)::int
        from grant_deep_analysis_stage_receipts
        where run_id = any($1::uuid[])
      ) as stage_receipts,
      (
        select count(*)::int
        from grant_deep_analysis_axis_results
        where run_id = any($1::uuid[])
      ) as axis_results,
      (
        select count(*)::int
        from grant_deep_analysis_audits
        where run_id = any($1::uuid[])
      ) as audits,
      (
        select count(*)::int
        from grant_deep_analysis_exception_events
        where run_id = any($1::uuid[])
      ) as exception_events
  `, [keepRunIds]);
  if (!row) throw new Error("보존 대상 count를 읽지 못했습니다.");
  return {
    grants: before.grants,
    attachmentArchives: before.attachmentArchives,
    applicationSurfaces: before.applicationSurfaces,
    nonFieldDocumentArtifacts: before.nonFieldDocumentArtifacts,
    pageImageArtifacts: before.pageImageArtifacts,
    jobs: keepJobIds.length,
    runs: keepRunIds.length,
    stageReceipts: row.stage_receipts,
    axisResults: row.axis_results,
    audits: row.audits,
    exceptionEvents: row.exception_events,
  };
}

async function buildPlan(
  client: QueryClient,
  build: RebuildBuildSource,
  mode: DeepAnalysisLayerRebuildMode,
): Promise<DeepAnalysisLayerRebuildPlan> {
  const keepRuns = mode === "fresh_start" ? [] : await loadKeepRuns(client);
  const before = await loadCounts(client);
  const keepRunIds = keepRuns.map((run) => run.id);
  const keepJobIds = [...new Set(keepRuns.map((run) => run.jobId))];
  const preserve = await countPreserved(
    client,
    keepRunIds,
    keepJobIds,
    before,
  );
  return createDeepAnalysisLayerRebuildPlan({
    generatedAt: new Date().toISOString(),
    gitCommit: build.gitCommit,
    gitTree: build.gitTree,
    gitDirty: build.gitDirty,
    implementationSha256: build.implementationSha256,
    mode,
    keepRuns,
    before,
    deleteCounts: {
      jobs: before.jobs - preserve.jobs,
      workerHeartbeats: before.workerHeartbeats,
      runs: before.runs - preserve.runs,
      stageReceipts: before.stageReceipts - preserve.stageReceipts,
      axisResults: before.axisResults - preserve.axisResults,
      audits: before.audits - preserve.audits,
      exceptionEvents: before.exceptionEvents - preserve.exceptionEvents,
      promotionReleases: before.promotionReleases,
      promotionItems: before.promotionItems,
      criteria: before.criteria,
      confirmationQuestions: before.confirmationQuestions,
      companyConfirmations: before.companyConfirmations,
      matchState: before.matchState,
      landingObservations: before.landingObservations,
      applicationPrecomputeJobs: before.applicationPrecomputeJobs,
      applicationPrecomputeAttempts: before.applicationPrecomputeAttempts,
      applicationPrecomputeWorkerHeartbeats:
        before.applicationPrecomputeWorkerHeartbeats,
      fieldCandidateArtifacts: before.fieldCandidateArtifacts,
      documentFields: before.documentFields,
    },
    resetCounts: {
      fieldsReadySurfaces: before.fieldsReadySurfaces,
    },
    preserve,
  });
}

async function writeArtifact(
  kind: "plan" | "receipt",
  payload: object,
  stateSha256: string,
): Promise<string> {
  const directory = join(
    findMonorepoRoot(),
    "spike-out",
    "deep-analysis",
    "layer-rebuild",
  );
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const path = join(
    directory,
    `${stamp}-${stateSha256.slice(0, 12)}.${kind}.json`,
  );
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return path;
}

async function verifyBackup(pathArg: string | undefined): Promise<{
  path: string;
  bytes: number;
  sha256: string;
}> {
  if (!pathArg?.trim()) {
    throw new Error("--backup=<pg_dump 경로>가 필요합니다.");
  }
  const path = resolve(pathArg);
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) {
    throw new Error("backup이 비어 있거나 파일이 아닙니다.");
  }
  const body = await readFile(path);
  return {
    path,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function affectedCount(result: postgres.RowList<readonly postgres.Row[]>): number {
  return Number(result.count ?? 0);
}

async function executeReset(
  client: postgres.Sql,
  expectedPlan: DeepAnalysisLayerRebuildPlan,
  actor: string,
  backup: { path: string; bytes: number; sha256: string },
): Promise<{
  result: ResetResult;
  after: DeepAnalysisLayerCounts;
}> {
  return client.begin(async (transaction) => {
    await transaction.unsafe("set local lock_timeout = '5s'");
    await transaction.unsafe("set local statement_timeout = '120s'");
    const [lock] = await transaction.unsafe<Array<{ acquired: boolean }>>(
      "select pg_try_advisory_xact_lock(hashtext($1::text)) as acquired",
      [DEEP_ANALYSIS_LAYER_REBUILD_LOCK],
    );
    if (!lock?.acquired) {
      throw new Error("다른 분석계층 재구축 작업이 실행 중입니다.");
    }
    const [deepClaimLock] = await transaction.unsafe<Array<{
      acquired: boolean;
    }>>(
      "select pg_try_advisory_xact_lock(hashtext($1::text)) as acquired",
      [`cunote:deep-analysis-claim:${DEEP_ANALYSIS_MODEL_POLICY_VERSION}`],
    );
    if (!deepClaimLock?.acquired) {
      throw new Error("딥분석 claim이 진행 중이어서 재구축할 수 없습니다.");
    }
    const [applicationClaimLock] = await transaction.unsafe<Array<{
      acquired: boolean;
    }>>(
      "select pg_try_advisory_xact_lock(hashtext('cunote:application-precompute:claim')) as acquired",
    );
    if (!applicationClaimLock?.acquired) {
      throw new Error("Kordoc claim이 진행 중이어서 재구축할 수 없습니다.");
    }
    await transaction.unsafe(
      `lock table ${RESET_MUTATION_TABLES.join(", ")}
       in share row exclusive mode`,
    );

    const currentPlan = await buildPlan(
      transaction,
      {
        gitCommit: expectedPlan.gitCommit,
        gitTree: expectedPlan.gitTree,
        gitDirty: expectedPlan.source.gitDirty,
        implementationSha256: expectedPlan.source.implementationSha256,
      },
      expectedPlan.mode,
    );
    if (currentPlan.stateSha256 !== expectedPlan.stateSha256) {
      throw new Error(
        `dry-run 이후 DB 상태가 변했습니다: expected=${expectedPlan.stateSha256}, current=${currentPlan.stateSha256}`,
      );
    }
    assertDeepAnalysisLayerRebuildPreconditions(currentPlan);

    await assertResetTriggersEnabled(transaction);
    await setResetTriggersEnabled(transaction, false);

    const keepRunIds = currentPlan.keepRuns.map((run) => run.id);
    const keepJobIds = [...new Set(currentPlan.keepRuns.map((run) => run.jobId))];
    const deletedLanding = await transaction.unsafe(
      "delete from usage_events where feature_code = 'landing_match_observation'",
    );
    const deletedMatchState = await transaction.unsafe("delete from match_state");
    const deletedConfirmations = await transaction.unsafe(
      "delete from company_grant_confirmations",
    );
    const deletedQuestions = await transaction.unsafe(
      "delete from grant_confirmation_questions",
    );
    const deletedCriteria = await transaction.unsafe("delete from grant_criteria");
    const deletedPromotionItems = await transaction.unsafe(
      "delete from analysis_lab_promotion_items",
    );
    const deletedPromotionReleases = await transaction.unsafe(
      "delete from analysis_lab_promotion_releases",
    );
    const deletedApplicationPrecomputeHeartbeats = await transaction.unsafe(
      "delete from grant_application_precompute_worker_heartbeats",
    );
    const deletedApplicationPrecomputeAttempts = await transaction.unsafe(
      "delete from grant_application_precompute_attempts",
    );
    const deletedApplicationPrecomputeJobs = await transaction.unsafe(
      "delete from grant_application_precompute_jobs",
    );
    const deletedDocumentFields = await transaction.unsafe(
      "delete from grant_document_fields",
    );
    const deletedFieldCandidateArtifacts = await transaction.unsafe(
      "delete from document_artifacts where kind = 'field_candidates'",
    );
    const resetFieldsReadySurfaces = await transaction.unsafe(`
      update grant_application_surfaces surface
      set extraction_status = case
            when exists (
              select 1
              from document_artifacts artifact
              where artifact.surface_id = surface.id
                and artifact.kind = 'page_image'
            ) then 'preview_ready'
            else 'pending'
          end,
          extraction_version = null,
          confidence = null,
          updated_at = now()
      where surface.extraction_status = 'fields_ready'
    `);
    const detachedAdminActions = await transaction.unsafe(
      `update admin_deep_analysis_actions
       set run_id = null,
           job_id = null,
           detail = detail || jsonb_build_object(
             'analysisLayerResetStateSha256', $1::text,
             'analysisLayerResetActor', $2::text
           )
       where (run_id is not null and not (run_id = any($3::uuid[])))
          or (job_id is not null and not (job_id = any($4::uuid[])))`,
      [currentPlan.stateSha256, actor, keepRunIds, keepJobIds],
    );
    const detachedAggregateChildren = await transaction.unsafe(
      `update grant_aggregate_split_children
       set deep_analysis_job_id = null,
           deep_analysis_enqueued_at = null,
           active_feeder_bypass_reason = null
       where deep_analysis_job_id is not null
         and not (deep_analysis_job_id = any($1::uuid[]))`,
      [keepJobIds],
    );
    const deletedReceipts = await transaction.unsafe(
      "delete from grant_deep_analysis_stage_receipts where not (run_id = any($1::uuid[]))",
      [keepRunIds],
    );
    const deletedAxes = await transaction.unsafe(
      "delete from grant_deep_analysis_axis_results where not (run_id = any($1::uuid[]))",
      [keepRunIds],
    );
    const deletedAudits = await transaction.unsafe(
      "delete from grant_deep_analysis_audits where not (run_id = any($1::uuid[]))",
      [keepRunIds],
    );
    const deletedExceptions = await transaction.unsafe(
      "delete from grant_deep_analysis_exception_events where not (run_id = any($1::uuid[]))",
      [keepRunIds],
    );
    await transaction.unsafe(
      `update grant_deep_analysis_runs
       set supersedes_run_id = null
       where supersedes_run_id is not null
         and not (supersedes_run_id = any($1::uuid[]))`,
      [keepRunIds],
    );
    const deletedRuns = await transaction.unsafe(
      "delete from grant_deep_analysis_runs where not (id = any($1::uuid[]))",
      [keepRunIds],
    );
    const deletedHeartbeats = await transaction.unsafe(
      "delete from grant_deep_analysis_worker_heartbeats",
    );
    const deletedJobs = await transaction.unsafe(
      "delete from grant_deep_analysis_jobs where not (id = any($1::uuid[]))",
      [keepJobIds],
    );
    await setResetTriggersEnabled(transaction, true);
    await assertResetTriggersEnabled(transaction);

    const result: ResetResult = {
      deleted: {
        jobs: affectedCount(deletedJobs),
        workerHeartbeats: affectedCount(deletedHeartbeats),
        runs: affectedCount(deletedRuns),
        stageReceipts: affectedCount(deletedReceipts),
        axisResults: affectedCount(deletedAxes),
        audits: affectedCount(deletedAudits),
        exceptionEvents: affectedCount(deletedExceptions),
        promotionReleases: affectedCount(deletedPromotionReleases),
        promotionItems: affectedCount(deletedPromotionItems),
        criteria: affectedCount(deletedCriteria),
        confirmationQuestions: affectedCount(deletedQuestions),
        companyConfirmations: affectedCount(deletedConfirmations),
        matchState: affectedCount(deletedMatchState),
        landingObservations: affectedCount(deletedLanding),
        applicationPrecomputeJobs:
          affectedCount(deletedApplicationPrecomputeJobs),
        applicationPrecomputeAttempts:
          affectedCount(deletedApplicationPrecomputeAttempts),
        applicationPrecomputeWorkerHeartbeats:
          affectedCount(deletedApplicationPrecomputeHeartbeats),
        fieldCandidateArtifacts:
          affectedCount(deletedFieldCandidateArtifacts),
        documentFields: affectedCount(deletedDocumentFields),
      },
      reset: {
        fieldsReadySurfaces: affectedCount(resetFieldsReadySurfaces),
      },
      detachedAdminActions: affectedCount(detachedAdminActions),
      detachedAggregateChildren: affectedCount(detachedAggregateChildren),
    };
    if (
      JSON.stringify(result.deleted)
      !== JSON.stringify(currentPlan.delete)
    ) {
      throw new Error(
        `삭제 count 불일치: expected=${JSON.stringify(currentPlan.delete)}, actual=${JSON.stringify(result.deleted)}`,
      );
    }
    if (JSON.stringify(result.reset) !== JSON.stringify(currentPlan.reset)) {
      throw new Error(
        `reset count 불일치: expected=${JSON.stringify(currentPlan.reset)}, actual=${JSON.stringify(result.reset)}`,
      );
    }

    await transaction.unsafe(
      `insert into usage_events (
         feature_code, provider, model, status, request_id, context_ref
       ) values (
         'deep_analysis_layer_rebuild',
         'cunote_ops',
         null,
         'free',
         $1,
         $2::jsonb
       )`,
      [
        currentPlan.stateSha256,
        JSON.stringify({
          schema: "deep-analysis-layer-rebuild-receipt-v2",
          mode: currentPlan.mode,
          stateSha256: currentPlan.stateSha256,
          actor,
          gitCommit: currentPlan.gitCommit,
          backup,
          keepRunIds,
          deleted: result.deleted,
          reset: result.reset,
        }),
      ],
    );

    const after = await loadCounts(transaction);
    if (
      after.grants !== currentPlan.preserve.grants
      || after.attachmentArchives !== currentPlan.preserve.attachmentArchives
      || after.applicationSurfaces !== currentPlan.preserve.applicationSurfaces
      || after.documentArtifacts
        !== currentPlan.preserve.nonFieldDocumentArtifacts
      || after.nonFieldDocumentArtifacts
        !== currentPlan.preserve.nonFieldDocumentArtifacts
      || after.pageImageArtifacts !== currentPlan.preserve.pageImageArtifacts
      || after.jobs !== currentPlan.preserve.jobs
      || after.workerHeartbeats !== 0
      || after.runs !== currentPlan.preserve.runs
      || after.stageReceipts !== currentPlan.preserve.stageReceipts
      || after.axisResults !== currentPlan.preserve.axisResults
      || after.audits !== currentPlan.preserve.audits
      || after.exceptionEvents !== currentPlan.preserve.exceptionEvents
      || after.promotionReleases !== 0
      || after.promotionItems !== 0
      || after.criteria !== 0
      || after.confirmationQuestions !== 0
      || after.companyConfirmations !== 0
      || after.matchState !== 0
      || after.landingObservations !== 0
      || after.applicationPrecomputeJobs !== 0
      || after.applicationPrecomputeAttempts !== 0
      || after.applicationPrecomputeWorkerHeartbeats !== 0
      || after.fieldCandidateArtifacts !== 0
      || after.documentFields !== 0
      || after.fieldsReadySurfaces !== 0
      || after.leasedJobs !== 0
      || after.leasedApplicationPrecomputeJobs !== 0
      || after.leasedApplicationPrecomputeAttempts !== 0
    ) {
      throw new Error(`재구축 사후 count가 예상과 다릅니다: ${JSON.stringify(after)}`);
    }
    return { result, after };
  });
}

async function assertResetTriggersEnabled(
  client: QueryClient,
): Promise<void> {
  const rows = await client.unsafe<Array<{
    table_name: string;
    trigger_name: string;
    enabled: string;
  }>>(`
    select
      table_class.relname as table_name,
      trigger.tgname as trigger_name,
      trigger.tgenabled as enabled
    from pg_trigger trigger
    join pg_class table_class on table_class.oid = trigger.tgrelid
    where not trigger.tgisinternal
      and trigger.tgname = any($1::text[])
    order by table_class.relname, trigger.tgname
  `, [RESET_APPEND_ONLY_TRIGGERS.map((entry) => entry.trigger)]);
  const observed = new Map(
    rows.map((row) => [`${row.table_name}.${row.trigger_name}`, row.enabled]),
  );
  for (const entry of RESET_APPEND_ONLY_TRIGGERS) {
    const key = `${entry.table}.${entry.trigger}`;
    if (observed.get(key) !== "O") {
      throw new Error(`append-only trigger가 활성 상태가 아닙니다: ${key}`);
    }
  }
}

async function setResetTriggersEnabled(
  client: QueryClient,
  enabled: boolean,
): Promise<void> {
  const action = enabled ? "enable" : "disable";
  for (const entry of RESET_APPEND_ONLY_TRIGGERS) {
    await client.unsafe(
      `alter table ${entry.table} ${action} trigger ${entry.trigger}`,
    );
  }
}

async function main(): Promise<number> {
  const write = hasFlag("write");
  const mode: DeepAnalysisLayerRebuildMode = hasFlag("fresh-start")
    ? "fresh_start"
    : "preserve_current";
  const build = readBuildSource(write);
  const client = postgres(databaseUrl(), { max: 1, prepare: false });
  try {
    const plan = await buildPlan(client, build, mode);
    assertDeepAnalysisLayerRebuildPreconditions(plan);
    if (!write) {
      const path = await writeArtifact("plan", plan, plan.stateSha256);
      console.log(JSON.stringify({ ...plan, artifactPath: path }, null, 2));
      return 0;
    }

    assertDeepAnalysisLayerRebuildConfirmation(plan, readArg("confirm"));
    const actor = readArg("actor")?.trim();
    if (!actor) throw new Error("--actor가 필요합니다.");
    const backup = await verifyBackup(readArg("backup"));
    const executedAt = new Date().toISOString();
    const { result, after } = await executeReset(client, plan, actor, backup);
    const receipt = {
      schema: "deep-analysis-layer-rebuild-receipt-v2",
      verdict: "PASS",
      executedAt,
      actor,
      mode: plan.mode,
      stateSha256: plan.stateSha256,
      gitCommit: plan.gitCommit,
      backup,
      keepRuns: plan.keepRuns,
      result,
      after,
    };
    const path = await writeArtifact("receipt", receipt, plan.stateSha256);
    console.log(JSON.stringify({ ...receipt, artifactPath: path }, null, 2));
    return 0;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(
      "[deep-analysis-layer-rebuild] 실패:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  });
