import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import postgresClient from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { GrantPromotionPlan } from "./promote";
import {
  applyApplicationFieldRepairRelease,
  assertNoAppliedApplicationFieldRepairForParent,
  loadCurrentApplicationFieldRepairParent,
  prepareApplicationFieldRepairReleaseLedger,
  rollbackApplicationFieldRepairRelease,
  verifyApplicationFieldRepairRelease,
} from "./application-field-repair-release";
import {
  createPromotionReleaseManifest,
  planSha256,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleaseManifest,
  type PromotionReleasePlanItem,
} from "./promotion-release";
import {
  grantApplicationPrecomputePlanSha256,
  type GrantApplicationPrecomputePlan,
  type StagedGrantApplicationPrecompute,
} from "./application-precompute-prepare";
import {
  createApplicationFieldRepairReleaseManifest,
  type ApplicationFieldRepairReleaseManifest,
} from "../analysis-serving/applicationFieldRepairContract";
import {
  applicationFieldRepairSnapshotSha256,
  loadApplicationFieldRepairSnapshot,
  type ApplicationFieldRepairSnapshot,
} from "../analysis-serving/applicationFieldRepairSnapshot";
import {
  ANALYSIS_LAUNCH_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA,
} from "../analysis-serving/applicationPrecomputeEvidence";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotHashes,
  promotionGrantSnapshotStateSha256,
} from "../analysis-serving/promotionSnapshot";
import {
  VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
  type PromotionSourceArtifact,
} from "../analysis-serving/promotionReleaseContract";
import { fieldCandidatesStorageKey } from "../documents/fieldCandidateStore";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "../application-analysis/contract";

const FIXED_APPLIED_AT = "2026-09-11T00:00:00.000Z";
const ACTOR = "isolated-application-field-repair-test";

interface ParentFixture {
  releaseDbId: string;
  releaseId: string;
  grantIds: string[];
  itemIds: Map<string, string>;
  sourceIds: Map<string, string>;
  surfaceIds: Map<string, string>;
  storageKeys: Map<string, string>;
  sourceSha256s: Map<string, string>;
  draftIds: Map<string, string>;
}

interface RepairFixture {
  before: ApplicationFieldRepairSnapshot;
  manifest: ApplicationFieldRepairReleaseManifest;
  staged: StagedGrantApplicationPrecompute;
}

/** test:product-postgres의 폐기용 Unix socket cluster에서만 실행한다. */
export async function verifyApplicationFieldRepairPostgres(input: {
  admin: postgres.Sql;
  client: postgres.Sql;
  socket: string;
  companyId: string;
  userId: string;
}): Promise<void> {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u);

  const db = drizzle(input.admin, { schema });
  const fixture = await createParentFixture(input, db);
  const targetGrantId = fixture.grantIds[0]!;
  const raceGrantId = fixture.grantIds[1]!;
  const referencedGrantId = fixture.grantIds[4]!;
  const rlsGrantId = fixture.grantIds[3]!;
  const surfaceRaceGrantId = fixture.grantIds[5]!;

  const parentRowsBefore = await parentLedgerRows(input.admin, fixture.releaseDbId);
  const matchingBefore = await matchingRows(input.admin, fixture.grantIds, input.companyId);
  const draftsBefore = await draftRows(input.admin, fixture.grantIds);

  const orphanGrantId = await insertOrphanGrant(input.admin);
  await assert.rejects(
    () => loadCurrentApplicationFieldRepairParent(db, orphanGrantId),
    /parent가 유일하지 않습니다/u,
  );

  await verifyConcurrentSuccessorPreparation({ input, fixture, db, grantId: raceGrantId });
  await verifyReviewWriterSurfaceLockSerializes({
    input,
    fixture,
    grantId: surfaceRaceGrantId,
  });

  const repair = await buildRepairFixture(db, fixture, targetGrantId, "main");
  const ledger = await prepareApplicationFieldRepairReleaseLedger({
    db,
    manifest: repair.manifest,
    createdBy: ACTOR,
    beforeSnapshot: repair.before,
  });
  await approveRelease(input.admin, ledger.releaseDbId);
  await verifyRepairLedgerRls({ input, fixture, ledger, rlsGrantId });

  await assertSourceDriftRejected({ input, db, fixture, repair });
  await assertParentDriftRejected({ input, db, repair });
  await assertFieldBaselineDriftRejected({ input, db, fixture, repair });
  await assertMultipleParentsRejected({ input, db, fixture, repair });

  const artifactsBeforeFault = await applicationArtifactRows(
    input.admin,
    fixture.surfaceIds.get(targetGrantId)!,
  );
  await installMaterializationFaultTrigger(input.admin, targetGrantId);
  try {
    await input.admin`select set_config('cunote.application_field_repair_fault','on',false)`;
    await assert.rejects(
      () => applyApplicationFieldRepairRelease({
        db,
        manifest: repair.manifest,
        staged: repair.staged,
        executedBy: ACTOR,
      }),
      (error) => errorChainContains(error, "isolated_application_field_repair_fault"),
    );
  } finally {
    await input.admin`select set_config('cunote.application_field_repair_fault','off',false)`;
    await removeMaterializationFaultTrigger(input.admin);
  }
  assert.deepEqual(
    await loadApplicationFieldRepairSnapshot(db, targetGrantId),
    repair.before,
    "field materialization fault도 surface/field/draft를 같은 transaction에서 원복한다",
  );
  assert.deepEqual(
    await applicationArtifactRows(input.admin, fixture.surfaceIds.get(targetGrantId)!),
    artifactsBeforeFault,
    "candidate artifact pointer도 field/ledger와 같은 transaction에서 원복한다",
  );
  const [afterFault] = await input.admin<{ status: string }[]>`
    select status from analysis_lab_application_field_repairs where id=${ledger.repairId}
  `;
  assert.equal(afterFault?.status, "prepared");

  const applied = await applyApplicationFieldRepairRelease({
    db,
    manifest: repair.manifest,
    staged: repair.staged,
    executedBy: ACTOR,
  });
  assert.equal(applied.releaseStatus, "canary_passed");
  assert.equal(applied.replayed, false);
  assert.equal(applied.receipt.fields, 16);
  const promoted = await applyApplicationFieldRepairRelease({
    db,
    manifest: repair.manifest,
    executedBy: ACTOR,
  });
  assert.equal(promoted.releaseStatus, "active");
  assert.equal(promoted.replayed, true);
  assert.equal(promoted.afterSha256, applied.afterSha256);
  assert.equal((await input.admin`
    select id from grant_document_fields where grant_id=${targetGrantId}
  `).length, 16);
  assert.equal((await verifyApplicationFieldRepairRelease({ db, manifest: repair.manifest })).ok, true);
  await assert.rejects(
    () => assertNoAppliedApplicationFieldRepairForParent(
      db,
      fixture.itemIds.get(targetGrantId)!,
    ),
    /application_field_repair_applied/u,
    "regular parent rollback guard는 적용된 field repair를 고아로 만들지 않는다",
  );

  assert.deepEqual(
    await parentLedgerRows(input.admin, fixture.releaseDbId),
    parentRowsBefore,
    "application-only repair는 기존 active 9건 release/item을 갱신하지 않는다",
  );
  assert.deepEqual(
    await matchingRows(input.admin, fixture.grantIds, input.companyId),
    matchingBefore,
    "application-only repair는 grants/criteria/questions/match_state를 갱신하지 않는다",
  );
  assert.deepEqual(
    await draftRows(input.admin, fixture.grantIds),
    draftsBefore,
    "application-only repair는 사용자 draft를 갱신하지 않는다",
  );

  await verifyDraftEvolutionAndRollbackUnsupported({
    input,
    db,
    fixture,
    repair,
    grantId: targetGrantId,
  });

  await verifyAppliedRepairRollbackUnsupported({
    input,
    db,
    fixture,
    grantId: referencedGrantId,
  });

  console.log(
    "PASS: application field repair preserves parent 9/drafts, is atomic/idempotent/race-safe, "
      + "allows draft evolution, rejects release rollback without writes, and enforces ledger RLS",
  );
}

async function createParentFixture(
  input: {
    admin: postgres.Sql;
    companyId: string;
    userId: string;
  },
  db: CunoteDb,
): Promise<ParentFixture> {
  const grantIds = Array.from({ length: 9 }, () => crypto.randomUUID());
  const itemIds = new Map<string, string>();
  const sourceIds = new Map<string, string>();
  const surfaceIds = new Map<string, string>();
  const storageKeys = new Map<string, string>();
  const sourceSha256s = new Map<string, string>();
  const draftIds = new Map<string, string>();

  for (const [index, grantId] of grantIds.entries()) {
    const sourceId = `application-repair-${grantId}`;
    const surfaceId = crypto.randomUUID();
    const storageKey = `grant-archive/bizinfo/${sourceId}/attachments/form-${index}.hwp`;
    const sourceSha256 = hash(`source-${grantId}`);
    sourceIds.set(grantId, sourceId);
    surfaceIds.set(grantId, surfaceId);
    storageKeys.set(grantId, storageKey);
    sourceSha256s.set(grantId, sourceSha256);
    await input.admin`
      insert into grants(id,source,source_id,title,status,serving_state,overall_confidence,f_authoring_mode)
      values (${grantId},'bizinfo',${sourceId},${`field repair fixture ${index}`},'open','visible',1,'file_form')
    `;
    await input.admin`
      insert into grant_attachment_archives
        (source,source_id,filename,source_uri,storage_key,sha256,conversion_status)
      values ('bizinfo',${sourceId},${`form-${index}.hwp`},${`https://example.invalid/${index}`},
        ${storageKey},${sourceSha256},'archived')
    `;
    await input.admin`
      insert into grant_application_surfaces
        (id,grant_id,source,source_id,type,title,format,source_attachment,extraction_status)
      values (${surfaceId},${grantId},'bizinfo',${sourceId},'file_template',${`form-${index}.hwp`},
        'hwp',${storageKey},'preview_ready')
    `;
    await input.admin.begin(async (tx) => {
      await tx`select set_config('app.match_state_writer_contract','match-state-input-v1',true)`;
      await tx`
        insert into match_state
          (company_id,grant_id,eligibility,match_score,fit_score,rule_trace,match_confidence,
           ruleset_ver,scoring_ver,calculation_as_of,input_binding)
        values (${input.companyId},${grantId},'conditional',50,50,'[]',.8,
          'fixture-rules','fixture-scoring',${FIXED_APPLIED_AT},${JSON.stringify({
            version: "match-state-input-v1",
            companyId: input.companyId,
            companyRevision: "1",
            grantId,
            grantComponentRevisions: [{ grantId, revision: "1" }],
          })}::jsonb)
      `;
    });
    if (index <= 2) {
      const draftId = crypto.randomUUID();
      draftIds.set(grantId, draftId);
      await input.admin`
        insert into grant_document_drafts
          (id,grant_id,company_id,user_id,document_key,document_category,document_name,
           source_attachment,draft_markdown,filled_fields,field_answers,missing_fields,
           used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version,surface_id)
        values (${draftId},${grantId},${input.companyId},${input.userId},${`draft-${index}`},
          'application_form',${`form-${index}.hwp`},${`form-${index}.hwp`},'# preserved draft',
          ${JSON.stringify({ "기존 수기": `값-${index}` })}::jsonb,
          ${JSON.stringify({ "기존 수기": { value: `값-${index}`, status: "edited", source: "manual" } })}::jsonb,
          '[]','[]','[]','[]','draft','fixture-model','fixture-prompt','fixture-parser',${surfaceId})
      `;
    }
  }

  const releaseDbId = crypto.randomUUID();
  const releaseId = `parent-application-repair-${releaseDbId}`;
  const manifest = await buildParentManifest(db, grantIds, releaseId);
  await input.admin`
    insert into analysis_lab_promotion_releases
      (id,release_id,revision,manifest_sha256,release_plan_sha256,manifest,git_commit,
       build_digest,status,created_by,approved_by,approved_at,executed_by,started_at,completed_at)
    values (${releaseDbId},${releaseId},1,${manifest.manifestSha256},${manifest.releasePlanSha256},
      ${JSON.stringify(manifest)}::jsonb,${manifest.gitCommit},${manifest.buildDigest},'active',${ACTOR},
      ${ACTOR},${FIXED_APPLIED_AT},${ACTOR},${FIXED_APPLIED_AT},${FIXED_APPLIED_AT})
  `;
  for (const plan of manifest.plans) {
    const snapshot = await loadPromotionGrantSnapshot(db, plan.grantId, []);
    const stateSha256 = promotionGrantSnapshotStateSha256(snapshot);
    const itemId = crypto.randomUUID();
    itemIds.set(plan.grantId, itemId);
    await input.admin`
      insert into analysis_lab_promotion_items
        (id,release_db_id,grant_id,run_id,plan_sha256,before_snapshot,before_sha256,
         after_snapshot,after_sha256,status,applied_at,updated_at)
      values (${itemId},${releaseDbId},${plan.grantId},${plan.promotionPlan.runId},${plan.planSha256},
        ${JSON.stringify(snapshot)}::jsonb,${stateSha256},${JSON.stringify(snapshot)}::jsonb,
        ${stateSha256},'applied',${FIXED_APPLIED_AT},${FIXED_APPLIED_AT})
    `;
  }
  return {
    releaseDbId,
    releaseId,
    grantIds,
    itemIds,
    sourceIds,
    surfaceIds,
    storageKeys,
    sourceSha256s,
    draftIds,
  };
}

async function buildParentManifest(
  db: CunoteDb,
  grantIds: string[],
  releaseId: string,
): Promise<PromotionReleaseManifest> {
  const plans: PromotionReleasePlanItem[] = [];
  for (const [index, grantId] of grantIds.entries()) {
    const snapshot = await loadPromotionGrantSnapshot(db, grantId, []);
    const hashes = promotionGrantSnapshotHashes(snapshot);
    const runId = `parent-run-${index}-${grantId}`;
    const promotionPlan = emptyPromotionPlan(grantId, runId);
    plans.push({
      grantId,
      planSha256: planSha256(promotionPlan),
      promotionPlan,
      beforeCriteriaSha256: hashes.criteriaSha256,
      beforeQuestionsSha256: hashes.questionsSha256,
      dedupComponentSha256: hashes.dedupComponentSha256,
      criteriaCountBefore: 0,
      criteriaCountAfter: 0,
      questionCountAfter: 0,
      pendingCount: 0,
      downgradedCount: 0,
      transport: "claude-cli",
      costUsd: 0,
    });
  }
  return createPromotionReleaseManifest({
    releaseId,
    revision: 1,
    createdAt: FIXED_APPLIED_AT,
    gitCommit: "a".repeat(40),
    buildDigest: "b".repeat(40),
    cohortLabel: `isolated-parent-${releaseId}`,
    canaryGrantIds: [grantIds[0]!],
    sourceArtifacts: plans.map((plan, index) => ({
      grantId: plan.grantId,
      runId: plan.promotionPlan.runId,
      runSha256: hash(`parent-run-artifact-${index}`),
      reviewSha256: hash(`parent-review-${index}`),
      overlaySha256: null,
      confirmationsSha256: null,
      localLabEvidence: {
        schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
        transport: "claude-cli",
        model: "claude-opus-5",
        promptVersion: "isolated-parent-v1",
        inputSha256: hash(`parent-input-${index}`),
        reviewMethod: "human",
      },
    })),
    plans,
  });
}

async function buildRepairFixture(
  db: CunoteDb,
  fixture: ParentFixture,
  grantId: string,
  suffix: string,
): Promise<RepairFixture> {
  const before = await loadApplicationFieldRepairSnapshot(db, grantId);
  assert.equal(before.fields.length, 0);
  const parent = await loadCurrentApplicationFieldRepairParent(db, grantId);
  const releaseId = `field-repair-${suffix}-${crypto.randomUUID()}`;
  const newRunId = `field-repair-run-${suffix}-${crypto.randomUUID()}`;
  const roundtripRunId = `roundtrip-${suffix}-${crypto.randomUUID()}`;
  const launchReceiptSha256 = hash(`${suffix}-launch-receipt`);
  const launchManifestSha256 = hash(`${suffix}-launch-manifest`);
  const launchGrantSha256 = hash(`${suffix}-launch-grant`);
  const independentReviewManifestSha256 = hash(`${suffix}-review-manifest`);
  const independentReviewAggregateSha256 = hash(`${suffix}-review-aggregate`);
  const attachmentManifestSha256 = hash(`${suffix}-attachment-manifest`);
  const sourceRevisionSha256 = hash(`${suffix}-source-revision`);
  const inputSha256 = hash(`${suffix}-input`);
  const runArtifactSha256 = hash(`${suffix}-run-artifact`);
  const analysisManifestSha256 = hash(`${suffix}-roundtrip-manifest`);
  const surfaceId = fixture.surfaceIds.get(grantId)!;
  const sourceSha256 = fixture.sourceSha256s.get(grantId)!;
  const analysisVersion = `application-precompute:${APPLICATION_ROUNDTRIP_VERSION}`;
  const candidateSet = {
    engine: "kordoc-roundtrip",
    engineVersion: APPLICATION_ROUNDTRIP_VERSION,
    layer: "text_parser" as const,
    extractedAt: FIXED_APPLIED_AT,
    candidates: [],
  };
  const metadata = {
    engine: "kordoc-roundtrip" as const,
    engineVersion: APPLICATION_ROUNDTRIP_VERSION,
    layer: "text_parser" as const,
    candidateCount: 0,
    extractedAt: FIXED_APPLIED_AT,
    analysisVersion,
    contractVersion: APPLICATION_ROUNDTRIP_VERSION as "kordoc-application-roundtrip-v11",
    sourceSha256,
    resultStatus: "complete" as const,
    roundtripRunId,
    parentLabRunId: newRunId,
    parentDeepAnalysisRunId: newRunId,
    transport: "claude-cli" as const,
    requestedModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    fieldCount: 16,
    coverageStatus: "complete" as const,
    errorCode: null,
    requestCount: 1,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
  };
  const surfacePlan = {
    surfaceId,
    sourceSha256,
    analysisVersion,
    status: "complete" as const,
    errorCode: null,
    fields: buildFields(),
    candidateSet,
    metadata,
  };
  const materializationPlan: GrantApplicationPrecomputePlan = {
    grantId,
    parentLabRunId: newRunId,
    roundtripRunId,
    surfaces: [surfacePlan],
  };
  const staged: StagedGrantApplicationPrecompute = {
    ...materializationPlan,
    surfaces: [{
      ...surfacePlan,
      stagedArtifact: {
        surfaceId,
        storageKey: fieldCandidatesStorageKey({
          source: "bizinfo",
          sourceId: fixture.sourceIds.get(grantId)!,
          set: candidateSet,
        }),
        url: null,
        engine: candidateSet.engine,
        candidateCount: candidateSet.candidates.length,
        sha256: hash(JSON.stringify(candidateSet)),
        metadata,
      },
    }],
  };
  const sourceArtifact = {
    grantId,
    runId: newRunId,
    runSha256: runArtifactSha256,
    overlaySha256: null,
    confirmationsSha256: null,
    sourceRevisionSha256,
    localLabEvidence: {
      schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
      transport: "claude-cli" as const,
      model: "claude-opus-5",
      promptVersion: "lab-deep-v11",
      inputSha256,
      reviewMethod: "analysis_launch_independent_review" as const,
      analysisLaunch: {
        schema: VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
        launchReceiptSha256,
        launchManifestSha256,
        launchGrantSha256,
        launchSequence: 0,
        independentReviewManifestSha256,
        independentReviewAggregateSha256,
        attachmentManifestSha256,
        sourceRevisionSha256,
        executionGitSha: "c".repeat(40),
        packageRuntimeSha256: hash(`${suffix}-package-runtime`),
        validatorVersion: "isolated-validator-v1",
        applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
      },
    },
    applicationPrecompute: {
      schema: ANALYSIS_LAUNCH_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA,
      releaseId,
      grantId,
      parentLabRunId: newRunId,
      roundtripRunId,
      status: "ready" as const,
      transport: "claude-cli" as const,
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL as "claude-opus-5",
      analysisSha256: runArtifactSha256,
      manifestSha256: analysisManifestSha256,
      sourceCount: 1,
      documentCount: 1,
      materializableDocumentCount: 1,
      reviewRequiredDocumentCount: 0,
      launchAdmission: {
        launchReceiptSha256,
        launchManifestSha256,
        launchGrantSha256,
        launchSequence: 0,
        independentReviewManifestSha256,
        independentReviewAggregateSha256,
        runArtifactSha256,
        applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
      },
    },
  } satisfies PromotionSourceArtifact;
  const manifest = createApplicationFieldRepairReleaseManifest({
    releaseId,
    revision: 1,
    createdAt: new Date().toISOString(),
    gitCommit: "d".repeat(40),
    buildDigest: "e".repeat(40),
    cohortLabel: `isolated-field-repair-${suffix}`,
    repair: {
      grantId,
      parent,
      inventory: {
        policy: "open-visible-current-period-missing-fields-v1",
        seriesId: `current-field-repair-${suffix}`,
        inventorySha256: hash(`${suffix}-inventory`),
        launchManifestSha256,
        launchReceiptSha256,
      },
      sourceArtifact,
      readiness: {
        schema: "analysis-launch-promotion-readiness-v1",
        disposition: "conditional",
        reasons: [],
        unresolvedAxes: [],
        sourceRevisionSha256,
        inputSha256,
        attachmentManifestSha256,
        launchReceiptSha256,
        independentReviewAggregateSha256,
        applicationRoundtripStatus: "complete",
        applicationRoundtripRunId: roundtripRunId,
        applicationDocumentCount: 1,
        fieldReadyDocumentCount: 1,
        recognizedFieldCount: 16,
        runFeatureReadiness: {
          schema: "analysis-feature-readiness-v1",
          matching: { status: "ready", sourceDisposition: "conditional", reasons: [] },
          authoring: { status: "ready", sourceDisposition: "ready", reasons: [] },
        },
        runFeatureReadinessVerification: "verified",
        authoringEvidenceStatus: "verified",
        authoringEvidenceReasons: [],
      },
      beforeApplicationSnapshotSha256: applicationFieldRepairSnapshotSha256(before),
      fieldCountBefore: 0,
      expectedFieldCount: 16,
      expectedMaterializableSurfaceCount: 1,
      materializationPlanSha256: grantApplicationPrecomputePlanSha256(materializationPlan),
    },
  });
  return { before, manifest, staged };
}

async function verifyConcurrentSuccessorPreparation(input: {
  input: { admin: postgres.Sql; socket: string };
  fixture: ParentFixture;
  db: CunoteDb;
  grantId: string;
}): Promise<void> {
  const left = await buildRepairFixture(input.db, input.fixture, input.grantId, "race-left");
  const right = await buildRepairFixture(input.db, input.fixture, input.grantId, "race-right");
  const leftSql = postgresClient({
    host: input.input.socket,
    database: "postgres",
    username: "postgres",
    prepare: false,
    max: 1,
    onnotice: () => {},
  });
  const rightSql = postgresClient({
    host: input.input.socket,
    database: "postgres",
    username: "postgres",
    prepare: false,
    max: 1,
    onnotice: () => {},
  });
  try {
    const writes = await Promise.allSettled([
      prepareApplicationFieldRepairReleaseLedger({
        db: drizzle(leftSql, { schema }),
        manifest: left.manifest,
        createdBy: ACTOR,
        beforeSnapshot: left.before,
      }),
      prepareApplicationFieldRepairReleaseLedger({
        db: drizzle(rightSql, { schema }),
        manifest: right.manifest,
        createdBy: ACTOR,
        beforeSnapshot: right.before,
      }),
    ]);
    const outcomes = writes.map((result) => result.status === "fulfilled"
      ? "fulfilled"
      : result.reason instanceof Error ? result.reason.message : String(result.reason));
    assert.equal(
      writes.filter((result) => result.status === "fulfilled").length,
      1,
      `동시 successor 준비 결과: ${JSON.stringify(outcomes)}`,
    );
    assert.equal(writes.filter((result) => result.status === "rejected").length, 1);
    const rows = await input.input.admin<{ id: string; release_db_id: string }[]>`
      select id,release_db_id from analysis_lab_application_field_repairs where grant_id=${input.grantId}
    `;
    assert.equal(rows.length, 1, "동시 successor prepare는 한 parent에 한 repair만 남긴다");
    await input.input.admin`delete from analysis_lab_application_field_repairs where id=${rows[0]!.id}`;
    await input.input.admin`delete from analysis_lab_promotion_releases where id=${rows[0]!.release_db_id}`;
  } finally {
    await Promise.all([leftSql.end({ timeout: 5 }), rightSql.end({ timeout: 5 })]);
  }
}

async function verifyReviewWriterSurfaceLockSerializes(input: {
  input: { admin: postgres.Sql; socket: string };
  fixture: ParentFixture;
  grantId: string;
}): Promise<void> {
  const repair = await buildRepairFixture(
    drizzle(input.input.admin, { schema }),
    input.fixture,
    input.grantId,
    "review-surface-race",
  );
  const ledger = await prepareApplicationFieldRepairReleaseLedger({
    db: drizzle(input.input.admin, { schema }),
    manifest: repair.manifest,
    createdBy: ACTOR,
    beforeSnapshot: repair.before,
  });
  await approveRelease(input.input.admin, ledger.releaseDbId);

  const reviewSql = postgresClient({
    host: input.input.socket,
    database: "postgres",
    username: "postgres",
    prepare: false,
    max: 1,
    onnotice: () => {},
  });
  const repairSql = postgresClient({
    host: input.input.socket,
    database: "postgres",
    username: "postgres",
    prepare: false,
    max: 1,
    onnotice: () => {},
  });
  const surfaceId = input.fixture.surfaceIds.get(input.grantId)!;
  const reviewLockHeld = deferred<void>();
  const allowReviewCommit = deferred<void>();
  let reviewWrite: Promise<unknown> | undefined;
  try {
    // approveReviewDoc이 사용하는 exact surface advisory lock을 먼저 잡는다.
    reviewWrite = reviewSql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${surfaceId}))`;
      reviewLockHeld.resolve();
      await allowReviewCommit.promise;
      await insertMinimalField(tx, input.fixture, input.grantId, crypto.randomUUID(), "review-wins-race");
    });
    await reviewLockHeld.promise;
    const [backend] = await repairSql<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
    assert.ok(backend);
    const repairOutcome = applyApplicationFieldRepairRelease({
      db: drizzle(repairSql, { schema }),
      manifest: repair.manifest,
      staged: repair.staged,
      executedBy: ACTOR,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitForAdvisoryLockWait(input.input.admin, backend.pid);
    allowReviewCommit.resolve();
    await reviewWrite;
    const outcome = await repairOutcome;
    assert.equal(outcome.ok, false, "review writer가 먼저 field를 확정하면 repair는 거부돼야 한다");
    if (outcome.ok) assert.fail("surface lock 뒤 baseline 재검증이 누락됐습니다.");
    assert.equal(errorChainContains(outcome.error, "baseline이 변경"), true);
    const [repairRow] = await input.input.admin<{ status: string }[]>`
      select status from analysis_lab_application_field_repairs where id=${ledger.repairId}
    `;
    assert.equal(repairRow?.status, "prepared");
  } finally {
    allowReviewCommit.resolve();
    if (reviewWrite) await reviewWrite.catch(() => undefined);
    await Promise.all([reviewSql.end({ timeout: 5 }), repairSql.end({ timeout: 5 })]);
    await input.input.admin`delete from grant_document_fields where grant_id=${input.grantId}`;
    await input.input.admin`delete from analysis_lab_application_field_repairs where id=${ledger.repairId}`;
    await input.input.admin`delete from analysis_lab_promotion_releases where id=${ledger.releaseDbId}`;
  }
}

async function waitForAdvisoryLockWait(admin: postgres.Sql, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await admin<{ wait_event_type: string | null; wait_event: string | null }[]>`
      select wait_event_type,wait_event from pg_stat_activity where pid=${pid}
    `;
    if (row?.wait_event_type === "Lock" && row.wait_event === "advisory") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`repair backend ${pid}가 shared surface advisory lock에서 대기하지 않았습니다.`);
}

async function verifyRepairLedgerRls(input: {
  input: { admin: postgres.Sql; client: postgres.Sql; userId: string };
  fixture: ParentFixture;
  ledger: { releaseDbId: string; repairId: string };
  rlsGrantId: string;
}): Promise<void> {
  await input.input.client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${input.input.userId},true)`;
    assert.equal((await tx`select id from analysis_lab_application_field_repairs`).length, 0);
    assert.equal((await tx`
      update analysis_lab_application_field_repairs set status='rolled_back'
      where id=${input.ledger.repairId} returning id
    `).length, 0);
    assert.equal((await tx`
      delete from analysis_lab_application_field_repairs where id=${input.ledger.repairId} returning id
    `).length, 0);
  });

  const rlsReleaseDbId = crypto.randomUUID();
  await input.input.admin`
    insert into analysis_lab_promotion_releases
      (id,release_id,manifest_sha256,release_plan_sha256,manifest,git_commit,build_digest,status,created_by)
    values (${rlsReleaseDbId},${`rls-field-repair-${rlsReleaseDbId}`},${hash("rls-manifest")},
      ${hash("rls-plan")},'{}','fixture','fixture','prepared',${ACTOR})
  `;
  await assert.rejects(
    () => input.input.client.begin(async (tx) => {
      await tx`select set_config('app.current_user_id',${input.input.userId},true)`;
      await tx`
        insert into analysis_lab_application_field_repairs
          (release_db_id,grant_id,parent_promotion_item_id,roundtrip_run_id,
           application_field_analysis_version,plan_sha256,before_snapshot,before_sha256,status)
        values (${rlsReleaseDbId},${input.rlsGrantId},${input.fixture.itemIds.get(input.rlsGrantId)!},
          'rls-roundtrip',${APPLICATION_ROUNDTRIP_VERSION},${hash("rls-repair-plan")},'{}',
          ${hash("rls-before")},'prepared')
      `;
    }),
    /row-level security/u,
  );
  await input.input.admin`delete from analysis_lab_promotion_releases where id=${rlsReleaseDbId}`;
}

async function assertSourceDriftRejected(input: {
  input: { admin: postgres.Sql };
  db: CunoteDb;
  fixture: ParentFixture;
  repair: RepairFixture;
}): Promise<void> {
  const grantId = input.repair.manifest.repair.grantId;
  const sourceId = input.fixture.sourceIds.get(grantId)!;
  const originalSha = input.fixture.sourceSha256s.get(grantId)!;
  await input.input.admin`
    update grant_attachment_archives set sha256=${hash("drifted-source")}
    where source='bizinfo' and source_id=${sourceId}
  `;
  await assert.rejects(
    () => applyApplicationFieldRepairRelease({
      db: input.db,
      manifest: input.repair.manifest,
      staged: input.repair.staged,
      executedBy: ACTOR,
    }),
    /baseline이 변경|원본 SHA/u,
  );
  await input.input.admin`
    update grant_attachment_archives set sha256=${originalSha}
    where source='bizinfo' and source_id=${sourceId}
  `;
}

async function assertParentDriftRejected(input: {
  input: { admin: postgres.Sql };
  db: CunoteDb;
  repair: RepairFixture;
}): Promise<void> {
  const grantId = input.repair.manifest.repair.grantId;
  await input.input.admin`update grants set authoring_guide='{"fixture":true}' where id=${grantId}`;
  await assert.rejects(
    () => applyApplicationFieldRepairRelease({
      db: input.db,
      manifest: input.repair.manifest,
      staged: input.repair.staged,
      executedBy: ACTOR,
    }),
    /parent matching state|parent가 변경/u,
  );
  await input.input.admin`update grants set authoring_guide=null where id=${grantId}`;
}

async function assertFieldBaselineDriftRejected(input: {
  input: { admin: postgres.Sql };
  db: CunoteDb;
  fixture: ParentFixture;
  repair: RepairFixture;
}): Promise<void> {
  const grantId = input.repair.manifest.repair.grantId;
  const fieldId = crypto.randomUUID();
  await insertMinimalField(input.input.admin, input.fixture, grantId, fieldId, "drift-field");
  await assert.rejects(
    () => applyApplicationFieldRepairRelease({
      db: input.db,
      manifest: input.repair.manifest,
      staged: input.repair.staged,
      executedBy: ACTOR,
    }),
    /field\/surface baseline이 변경/u,
  );
  await input.input.admin`delete from grant_document_fields where id=${fieldId}`;
}

async function assertMultipleParentsRejected(input: {
  input: { admin: postgres.Sql };
  db: CunoteDb;
  fixture: ParentFixture;
  repair: RepairFixture;
}): Promise<void> {
  const grantId = input.repair.manifest.repair.grantId;
  const releaseDbId = crypto.randomUUID();
  const releaseId = `second-parent-${releaseDbId}`;
  const manifest = await buildParentManifest(input.db, [grantId], releaseId);
  const snapshot = await loadPromotionGrantSnapshot(input.db, grantId, []);
  const snapshotSha256 = promotionGrantSnapshotStateSha256(snapshot);
  const itemId = crypto.randomUUID();
  await input.input.admin`
    insert into analysis_lab_promotion_releases
      (id,release_id,manifest_sha256,release_plan_sha256,manifest,git_commit,build_digest,status,created_by)
    values (${releaseDbId},${releaseId},${manifest.manifestSha256},${manifest.releasePlanSha256},
      ${JSON.stringify(manifest)}::jsonb,${manifest.gitCommit},${manifest.buildDigest},'active',${ACTOR})
  `;
  await input.input.admin`
    insert into analysis_lab_promotion_items
      (id,release_db_id,grant_id,run_id,plan_sha256,before_snapshot,before_sha256,
       after_snapshot,after_sha256,status,applied_at)
    values (${itemId},${releaseDbId},${grantId},${manifest.plans[0]!.promotionPlan.runId},
      ${manifest.plans[0]!.planSha256},${JSON.stringify(snapshot)}::jsonb,${snapshotSha256},
      ${JSON.stringify(snapshot)}::jsonb,${snapshotSha256},'applied',${FIXED_APPLIED_AT})
  `;
  await assert.rejects(
    () => applyApplicationFieldRepairRelease({
      db: input.db,
      manifest: input.repair.manifest,
      staged: input.repair.staged,
      executedBy: ACTOR,
    }),
    /parent가 유일하지 않습니다/u,
  );
  await input.input.admin`delete from analysis_lab_promotion_items where id=${itemId}`;
  await input.input.admin`delete from analysis_lab_promotion_releases where id=${releaseDbId}`;
}

async function verifyDraftEvolutionAndRollbackUnsupported(input: {
  input: { admin: postgres.Sql; companyId: string; userId: string };
  db: CunoteDb;
  fixture: ParentFixture;
  repair: RepairFixture;
  grantId: string;
}): Promise<void> {
  const draftId = input.fixture.draftIds.get(input.grantId)!;
  await input.input.admin`
    update grant_document_drafts
    set draft_markdown='# 사용자가 계속 편집한 초안',updated_at=now()
    where id=${draftId}
  `;
  assert.equal(
    (await verifyApplicationFieldRepairRelease({ db: input.db, manifest: input.repair.manifest })).ok,
    true,
    "정상 draft 편집은 application serving projection을 drift로 만들지 않는다",
  );

  const newDraftId = crypto.randomUUID();
  await input.input.admin`
    insert into grant_document_drafts
      (id,grant_id,company_id,user_id,document_key,document_category,document_name,
       source_attachment,draft_markdown,filled_fields,field_answers,missing_fields,
       used_profile_fields,assumptions,warnings,status,model_ver,prompt_ver,parser_version,surface_id)
    values (${newDraftId},${input.grantId},${input.input.companyId},${input.input.userId},
      ${`draft-after-repair-${newDraftId}`},'application_form','신규 초안.hwp','신규 초안.hwp',
      '# 신규 초안','{}','{}','[]','[]','[]','[]','draft','fixture-model','fixture-prompt',
      'fixture-parser',${input.fixture.surfaceIds.get(input.grantId)!})
  `;
  assert.equal(
    (await verifyApplicationFieldRepairRelease({ db: input.db, manifest: input.repair.manifest })).ok,
    true,
    "신규 draft 생성도 application serving projection을 drift로 만들지 않는다",
  );

  const beforeRollbackAttempt = await repairMutationRows(
    input.input.admin,
    input.repair.manifest.releaseId,
    input.grantId,
  );
  await assert.rejects(
    () => rollbackApplicationFieldRepairRelease({
      db: input.db,
      manifest: input.repair.manifest,
      executedBy: ACTOR,
    }),
    /append-only|지원하지 않습니다|unsupported/u,
  );
  assert.deepEqual(
    await repairMutationRows(input.input.admin, input.repair.manifest.releaseId, input.grantId),
    beforeRollbackAttempt,
    "release rollback 거부는 ledger/surface/field/draft를 전혀 갱신하지 않는다",
  );
}

async function verifyAppliedRepairRollbackUnsupported(input: {
  input: { admin: postgres.Sql };
  db: CunoteDb;
  fixture: ParentFixture;
  grantId: string;
}): Promise<void> {
  const repair = await buildRepairFixture(input.db, input.fixture, input.grantId, "rollback-disabled");
  const ledger = await prepareApplicationFieldRepairReleaseLedger({
    db: input.db,
    manifest: repair.manifest,
    createdBy: ACTOR,
    beforeSnapshot: repair.before,
  });
  await approveRelease(input.input.admin, ledger.releaseDbId);
  await applyApplicationFieldRepairRelease({
    db: input.db,
    manifest: repair.manifest,
    staged: repair.staged,
    executedBy: ACTOR,
  });
  await applyApplicationFieldRepairRelease({
    db: input.db,
    manifest: repair.manifest,
    executedBy: ACTOR,
  });
  const beforeRollbackAttempt = await repairMutationRows(
    input.input.admin,
    repair.manifest.releaseId,
    input.grantId,
  );
  await assert.rejects(
    () => rollbackApplicationFieldRepairRelease({
      db: input.db,
      manifest: repair.manifest,
      executedBy: ACTOR,
    }),
    /append-only|지원하지 않습니다|unsupported/u,
  );
  assert.deepEqual(
    await repairMutationRows(input.input.admin, repair.manifest.releaseId, input.grantId),
    beforeRollbackAttempt,
    "draft가 없는 exact after 상태에서도 release rollback은 append-only로 거부한다",
  );
}

async function installMaterializationFaultTrigger(
  admin: postgres.Sql,
  _grantId: string,
): Promise<void> {
  await admin.unsafe(`
    create or replace function application_field_repair_test_fault()
    returns trigger language plpgsql as $$
    begin
      if current_setting('cunote.application_field_repair_fault', true) = 'on' then
        raise exception 'isolated_application_field_repair_fault';
      end if;
      return new;
    end
    $$
  `);
  await admin.unsafe(`
    create trigger application_field_repair_test_fault_trigger
    before insert on grant_document_fields
    for each row execute function application_field_repair_test_fault()
  `);
}

async function removeMaterializationFaultTrigger(admin: postgres.Sql): Promise<void> {
  await admin.unsafe(`
    drop trigger if exists application_field_repair_test_fault_trigger on grant_document_fields
  `);
  await admin.unsafe(`drop function if exists application_field_repair_test_fault()`);
}

async function applicationArtifactRows(admin: postgres.Sql, surfaceId: string) {
  return (await admin<{ row: Record<string, unknown> }[]>`
    select to_jsonb(a) as row from document_artifacts a
    where surface_id=${surfaceId} and kind='field_candidates'
    order by id
  `).map((entry) => entry.row);
}

async function repairMutationRows(
  admin: postgres.Sql,
  releaseId: string,
  grantId: string,
) {
  const [release, repair, surfaces, fields, drafts, artifacts] = await Promise.all([
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(r) as row from analysis_lab_promotion_releases r
      where release_id=${releaseId}
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(f) as row from analysis_lab_application_field_repairs f
      where grant_id=${grantId}
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(s) as row from grant_application_surfaces s
      where grant_id=${grantId} order by id
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(f) as row from grant_document_fields f
      where grant_id=${grantId} order by id
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(d) as row from grant_document_drafts d
      where grant_id=${grantId} order by id
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(a) as row from document_artifacts a
      inner join grant_application_surfaces s on s.id=a.surface_id
      where s.grant_id=${grantId} order by a.id
    `,
  ]);
  return {
    release: release.map((entry) => entry.row),
    repair: repair.map((entry) => entry.row),
    surfaces: surfaces.map((entry) => entry.row),
    fields: fields.map((entry) => entry.row),
    drafts: drafts.map((entry) => entry.row),
    artifacts: artifacts.map((entry) => entry.row),
  };
}

async function approveRelease(admin: postgres.Sql, releaseDbId: string): Promise<void> {
  const rows = await admin`
    update analysis_lab_promotion_releases
    set status='approved',approved_by=${ACTOR},approved_at=now(),
        approval_artifact_sha256=${hash(`approval-${releaseDbId}`)}
    where id=${releaseDbId} and status='prepared'
    returning id
  `;
  assert.equal(rows.length, 1);
}

async function insertOrphanGrant(admin: postgres.Sql): Promise<string> {
  const grantId = crypto.randomUUID();
  await admin`
    insert into grants(id,source,source_id,title,status,serving_state,overall_confidence)
    values (${grantId},'bizinfo',${`orphan-${grantId}`},'parent 없는 공고','open','visible',1)
  `;
  return grantId;
}

async function insertMinimalField(
  admin: postgres.Sql | postgres.TransactionSql,
  fixture: ParentFixture,
  grantId: string,
  fieldId: string,
  fieldKey: string,
): Promise<void> {
  await admin`
    insert into grant_document_fields
      (id,grant_id,source,source_id,document_category,document_name,source_attachment,
       field_key,label,field_type,required,fill_strategy,confidence,parser_version,surface_id)
    values (${fieldId},${grantId},'bizinfo',${fixture.sourceIds.get(grantId)!},'application_form',
      'fixture.hwp',${fixture.storageKeys.get(grantId)!},${fieldKey},${fieldKey},'text',false,
      'manual',1,'manual-fixture',${fixture.surfaceIds.get(grantId)!})
  `;
}

async function parentLedgerRows(admin: postgres.Sql, releaseDbId: string) {
  const [release, items] = await Promise.all([
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(r) as row from analysis_lab_promotion_releases r where id=${releaseDbId}
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(i) as row from analysis_lab_promotion_items i
      where release_db_id=${releaseDbId} order by id
    `,
  ]);
  return { release: release.map((entry) => entry.row), items: items.map((entry) => entry.row) };
}

async function matchingRows(admin: postgres.Sql, grantIds: string[], companyId: string) {
  const [grants, criteria, questions, matches] = await Promise.all([
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(g) as row from grants g where id in ${admin(grantIds)} order by id
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(c) as row from grant_criteria c where grant_id in ${admin(grantIds)} order by id
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(q) as row from grant_confirmation_questions q
      where grant_id in ${admin(grantIds)} order by id
    `,
    admin<{ row: Record<string, unknown> }[]>`
      select to_jsonb(m) as row from match_state m
      where company_id=${companyId} and grant_id in ${admin(grantIds)} order by grant_id
    `,
  ]);
  return {
    grants: grants.map((entry) => entry.row),
    criteria: criteria.map((entry) => entry.row),
    questions: questions.map((entry) => entry.row),
    matches: matches.map((entry) => entry.row),
  };
}

async function draftRows(admin: postgres.Sql, grantIds: string[]) {
  return (await admin<{ row: Record<string, unknown> }[]>`
    select to_jsonb(d) as row from grant_document_drafts d
    where grant_id in ${admin(grantIds)} order by id
  `).map((entry) => entry.row);
}

function emptyPromotionPlan(grantId: string, runId: string): GrantPromotionPlan {
  return {
    grantId,
    runId,
    title: "isolated parent",
    origin: "human",
    auditState: "human_reviewed",
    criteria: [],
    criterionIndexByPosition: [],
    criterionStableKeys: [],
    resolutions: [],
    conversion: {
      grantId,
      runId,
      verdicts: { correct: 0, needs_edit: 0, wrong: 0, unsure: 0 },
      missedConditions: 0,
      inputRows: 0,
      converted: 0,
      downgraded: 0,
      dropped: 0,
      error: null,
    },
    questions: [],
    droppedQuestionCandidates: 0,
  };
}

function buildFields() {
  return Array.from({ length: 16 }, (_, index) => ({
    fieldKey: `field-${String(index + 1).padStart(2, "0")}`,
    label: `작성 필드 ${index + 1}`,
    section: "신청서",
    fieldType: "text" as const,
    required: index < 5,
    fillStrategy: index < 5 ? "copy" as const : "manual" as const,
    confidence: 0.95,
    tier: "high" as const,
    position: {
      page: 1,
      bbox: null,
      blockIndex: index,
      row: index,
      col: 1,
      occurrence: 0,
      normalizedLabel: `작성필드${index + 1}`,
      anchorLabel: `작성 필드 ${index + 1}`,
      targetKind: "table_cell_region" as const,
      valueStart: 0,
      valueEnd: 0,
    },
    visualEvidence: { source: "isolated-postgres" },
    textEvidence: { helperText: `필드 ${index + 1} 작성` },
    reviewRequired: false,
    mappedCompanyField: index === 0 ? "name" : null,
    sourceSpan: `작성 필드 ${index + 1}`,
    documentName: "fixture.hwp",
    documentCategory: "application_form",
  }));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function errorChainContains(error: unknown, needle: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current.message.includes(needle)) return true;
    current = current.cause;
  }
  return false;
}
