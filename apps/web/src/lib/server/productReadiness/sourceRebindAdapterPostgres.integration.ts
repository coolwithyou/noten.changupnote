import assert from "node:assert/strict";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotHashes,
} from "../analysis-serving/promotionSnapshot";
import { createGrantNextWorkSnapshot } from "./grantNextWorkExecution";
import { loadCurrentGrantReadiness } from "./grantReadinessLoader";
import {
  assessPublishedGrantSupply,
  executeApprovedGrantSupply,
  loadCurrentGrantSupplySnapshot,
} from "./grantSupply";
import {
  applySourceRebindRelease,
  approveSourceRebindRelease,
  assertNoAppliedSourceRebindForParent,
  buildCurrentSourceRebindReleaseManifest,
  prepareSourceRebindReleaseLedger,
} from "./sourceRebindRelease";
import {
  buildQuestionPreparationFixtureManifest,
  buildQuestionPreparationFixturePlan,
  seedQuestionPreparationFixtureAppliedRelease,
} from "./questionPreparationAdapterPostgres.integration";
import { loadPromotionServingRequestSnapshot } from "../repositories/drizzle";
import { loadVerifiedDeepSources } from "../analysis-serving/verifiedDeepSources";
import type { GrantSourceChangeImpact } from "../ingestion/grantSourceChangeImpact";

/** 폐기용 Unix socket DB에서 source_rebind → 답변 보존 → A 전환을 검증한다. */
export async function verifySourceRebindAdapterPostgres(input: {
  readonly admin: postgres.Sql;
  readonly socket: string;
  readonly companyId: string;
}): Promise<void> {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u);
  const db = drizzle(input.admin, { schema });
  const grantId = crypto.randomUUID();
  const criterionId = crypto.randomUUID();
  const sourceId = `source-rebind-${grantId}`;
  const previousRawSha256 = "1".repeat(64);
  const currentRawSha256 = "2".repeat(64);
  const stableKey = "criterion:location:source-rebind";
  const runId = `source-rebind-run-${grantId}`;
  const asOf = new Date("2026-09-22T03:00:00.000Z");

  await input.admin`insert into grants
    (id,source,source_id,title,apply_start,apply_end,status,serving_state,overall_confidence)
    values (${grantId},'bizinfo',${sourceId},'source rebind 격리 검증 공고',
      '2026-09-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','open','visible',1)`;
  await input.admin`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
    values ('bizinfo',${sourceId},'{"viewCount":1}'::jsonb,
      ${JSON.stringify([{ filename: "guide.pdf", url: "https://example.invalid/source-rebind.pdf" }])}::jsonb,
      ${previousRawSha256},'normalized')`;
  await input.admin`insert into grant_attachment_archives
    (source,source_id,filename,source_uri,sha256,conversion_status)
    values ('bizinfo',${sourceId},'guide.pdf','https://example.invalid/source-rebind.pdf',
      ${"a".repeat(64)},'archived')`;
  await input.admin`insert into grant_criteria
    (id,grant_id,dimension,operator,value,kind,confidence,source_span,raw_text,source_field,
     stable_key,needs_review,parser_version)
    values (${criterionId},${grantId},'other','text_only','{"note":"시흥시 관내 기업"}',
      'required',1,'시흥시 관내 기업','시흥시 관내 기업','지원대상',${stableKey},false,'fixture-v1')`;
  const previousSource = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(previousSource);
  const plan = buildQuestionPreparationFixturePlan({
    grantId,
    runId,
    stableKey,
    sourceRevisionSha256: previousSource.sourceRevisionSha256,
    sourceRawSha256: previousRawSha256,
    includeQuestion: true,
  });
  const plannedQuestion = plan.questions[0]!;
  const questionId = crypto.randomUUID();
  await input.admin`insert into grant_confirmation_questions
    (id,grant_id,evaluation_criterion_id,evaluation_contract_version,source_revision_sha256,
     source_raw_sha256,criterion_stable_key,definition_sha256,version,criterion_ref,prompt,
     options,answer_type,reusable,condition_key,prompt_ver,provenance)
    values (${questionId},${grantId},${criterionId},'confirmation-evaluation-v2',
      ${previousSource.sourceRevisionSha256},${previousRawSha256},${stableKey},
      ${plannedQuestion.definitionSha256},1,${JSON.stringify(plannedQuestion.criterionRef)}::jsonb,
      ${plannedQuestion.prompt},${JSON.stringify(plannedQuestion.options)}::jsonb,
      ${plannedQuestion.answerType},${plannedQuestion.reusable},${plannedQuestion.conditionKey},
      ${plannedQuestion.promptVer},${JSON.stringify(plannedQuestion.provenance)}::jsonb)`;
  await input.admin`insert into company_grant_confirmations
    (company_id,grant_id,question_id,answer,disqualified,evaluation,evaluation_criterion_id,
     source_revision_sha256,source_raw_sha256,question_definition_sha256,question_version,
     answer_revision)
    values (${input.companyId},${grantId},${questionId},'{"values":["yes"]}'::jsonb,false,
      'satisfied',${criterionId},${previousSource.sourceRevisionSha256},${previousRawSha256},
      ${plannedQuestion.definitionSha256},1,3)`;
  const parentSnapshot = await loadPromotionGrantSnapshot(db, grantId);
  const parentManifest = buildQuestionPreparationFixtureManifest({
    grantId,
    plan,
    sourceRevisionSha256: previousSource.sourceRevisionSha256,
    before: promotionGrantSnapshotHashes(parentSnapshot),
    releaseId: `source-rebind-parent-${grantId}`,
    includeQuestion: true,
  });
  await seedQuestionPreparationFixtureAppliedRelease({
    admin: input.admin,
    manifest: parentManifest,
    snapshot: parentSnapshot,
    appliedAt: new Date("2026-09-22T00:00:00.000Z"),
  });

  const sourceChangeImpact: GrantSourceChangeImpact = {
    schema: "grant-source-change-impact-v2" as const,
    classification: "evidence_refresh" as const,
    changedDomains: ["raw"] as const,
    previousRawSha256,
    currentRawSha256,
    requiresModelRun: false as const,
  };
  await input.admin`update grant_raw set payload='{"viewCount":2}'::jsonb,
    raw_hash=${currentRawSha256},collected_at=now()
    where source='bizinfo' and source_id=${sourceId}`;
  await input.admin`insert into grant_collection_events
    (source,source_id,raw_hash,revision_kind,change_impact)
    values ('bizinfo',${sourceId},${currentRawSha256},'changed',
      ${JSON.stringify(sourceChangeImpact)}::jsonb)`;
  const currentSource = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(currentSource);
  assert.notEqual(currentSource.sourceRevisionSha256, previousSource.sourceRevisionSha256);
  assert.equal(currentSource.materialSourceRevisionSha256, previousSource.materialSourceRevisionSha256);

  let activeImpact: GrantSourceChangeImpact = sourceChangeImpact;
  const loadSnapshot = async () => {
    const rows = await loadCurrentGrantReadiness({ db, asOf, limit: 1000 });
    const row = rows.find((candidate) => candidate.grantId === grantId);
    assert.ok(row);
    return createGrantNextWorkSnapshot({
      grantId,
      readinessInput: row.input,
      sourceChangeImpact: row.input.source.rawSha256 === activeImpact.currentRawSha256
        ? activeImpact
        : null,
    });
  };
  const before = await loadSnapshot();
  assert.equal(before.nextWork.action, "source_rebind");
  assert.equal(before.readiness.category, "D");
  assert.equal(before.readinessInput.source.materialRevisionSha256,
    currentSource.materialSourceRevisionSha256);
  const staleDeep = await loadVerifiedDeepSources(grantId, db);
  assert.deepEqual(staleDeep.sources, [], "source drift 중에는 이전 딥분석 근거를 제공하지 않는다");
  assert.equal(staleDeep.provenance.status, "current_state_drift");

  const releaseManifest = await buildCurrentSourceRebindReleaseManifest({
    db,
    grantId,
    releaseId: `source-rebind-release-${grantId}`,
    gitCommit: "source-rebind-fixture-commit",
    buildDigest: "source-rebind-fixture-build",
  });
  await prepareSourceRebindReleaseLedger({
    db: db as CunoteDb,
    manifest: releaseManifest,
    createdBy: "source-rebind-preparer",
  });
  await approveSourceRebindRelease({
    db: db as CunoteDb,
    manifest: releaseManifest,
    approvedBy: "source-rebind-approver",
    approvalArtifactSha256: "3".repeat(64),
  });
  const publishedSnapshot = await loadCurrentGrantSupplySnapshot({ db, grantId, asOf });
  assert.equal(publishedSnapshot?.evidenceSha256, before.evidenceSha256);
  const result = await executeApprovedGrantSupply({
    db: db as CunoteDb,
    grantId,
    expectedEvidenceSha256: before.evidenceSha256,
    approvedRelease: {
      releaseId: releaseManifest.releaseId,
      manifestSha256: releaseManifest.manifestSha256,
      executedBy: "source-rebind-executor",
    },
    asOf,
  });
  const after = await loadSnapshot();
  assert.equal(result.status, "completed", JSON.stringify({ result, after }));
  assert.equal(result.nextAction, "reuse_ready");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.externalWrites, 1);
  assert.equal(after.readiness.category, "A");
  const reboundDeep = await loadVerifiedDeepSources(grantId, db);
  assert.equal(reboundDeep.provenance.status, "verified");
  const serving = await loadPromotionServingRequestSnapshot(db, [grantId]);
  const servingItem = serving.items.find((candidate) => candidate.item.grantId === grantId);
  assert.equal(servingItem?.evidence.sourceRevisionSha256, currentSource.sourceRevisionSha256);
  const [answer] = await input.admin<{
    answer: { values: string[] };
    evaluation: string;
    source_revision_sha256: string;
    source_raw_sha256: string;
    question_definition_sha256: string;
    answer_revision: number;
  }[]>`select answer,evaluation,source_revision_sha256,source_raw_sha256,
             question_definition_sha256,answer_revision
      from company_grant_confirmations
      where company_id=${input.companyId} and question_id=${questionId}`;
  assert.deepEqual(answer?.answer, { values: ["yes"] });
  assert.equal(answer?.evaluation, "satisfied");
  assert.equal(answer?.source_revision_sha256, currentSource.sourceRevisionSha256);
  assert.equal(answer?.source_raw_sha256, currentRawSha256);
  assert.equal(answer?.answer_revision, 3);
  assert.equal(answer?.question_definition_sha256, releaseManifest.questions[0]?.afterDefinitionSha256);
  const recovered = await executeApprovedGrantSupply({
    db: db as CunoteDb,
    grantId,
    expectedEvidenceSha256: before.evidenceSha256,
    approvedRelease: {
      releaseId: releaseManifest.releaseId,
      manifestSha256: releaseManifest.manifestSha256,
      executedBy: "source-rebind-executor",
    },
    asOf,
  });
  assert.equal(recovered.status, "already_complete");
  assert.equal(recovered.externalWrites, 0);
  await assert.rejects(executeApprovedGrantSupply({
    db: db as CunoteDb,
    grantId,
    expectedEvidenceSha256: "8".repeat(64),
    approvedRelease: {
      releaseId: parentManifest.releaseId,
      manifestSha256: parentManifest.manifestSha256,
      executedBy: "source-rebind-executor",
    },
    asOf,
  }), /grant_supply_promotion_recovery_before_evidence_mismatch/);
  await assert.rejects(executeApprovedGrantSupply({
    db: db as CunoteDb,
    grantId,
    expectedEvidenceSha256: "9".repeat(64),
    approvedRelease: {
      releaseId: releaseManifest.releaseId,
      manifestSha256: releaseManifest.manifestSha256,
      executedBy: "source-rebind-executor",
    },
    asOf,
  }), /grant_supply_rebind_recovery_before_evidence_mismatch/);
  const replay = await applySourceRebindRelease({
    db: db as CunoteDb,
    manifest: releaseManifest,
    executedBy: "source-rebind-executor",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.reboundQuestionCount, 1);
  assert.equal(replay.reboundAnswerCount, 1);
  const preparedReplay = await prepareSourceRebindReleaseLedger({
    db: db as CunoteDb,
    manifest: releaseManifest,
    createdBy: "source-rebind-preparer",
  });
  assert.equal(preparedReplay.replayed, true);

  const secondRawSha256 = "4".repeat(64);
  activeImpact = {
    schema: "grant-source-change-impact-v2",
    classification: "evidence_refresh",
    changedDomains: ["raw"],
    previousRawSha256: currentRawSha256,
    currentRawSha256: secondRawSha256,
    requiresModelRun: false,
  };
  await input.admin`update grant_raw set payload='{"viewCount":3}'::jsonb,
    raw_hash=${secondRawSha256},collected_at=now()
    where source='bizinfo' and source_id=${sourceId}`;
  await input.admin`insert into grant_collection_events
    (source,source_id,raw_hash,revision_kind,change_impact)
    values ('bizinfo',${sourceId},${secondRawSha256},'changed',
      ${JSON.stringify(activeImpact)}::jsonb)`;
  const secondSource = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(secondSource);
  const secondBefore = await loadSnapshot();
  assert.equal(secondBefore.nextWork.action, "source_rebind", JSON.stringify(secondBefore));
  assert.equal(secondBefore.readinessInput.analysis.sourceRevisionSha256,
    currentSource.sourceRevisionSha256);
  const secondManifest = await buildCurrentSourceRebindReleaseManifest({
    db,
    grantId,
    releaseId: `source-rebind-release-2-${grantId}`,
    gitCommit: "source-rebind-fixture-commit-2",
    buildDigest: "source-rebind-fixture-build-2",
  });
  assert.equal(secondManifest.parent.rootSourceRevisionSha256,
    previousSource.sourceRevisionSha256);
  assert.equal(secondManifest.parent.sourceRevisionSha256,
    currentSource.sourceRevisionSha256);
  await prepareSourceRebindReleaseLedger({
    db: db as CunoteDb,
    manifest: secondManifest,
    createdBy: "source-rebind-preparer-2",
  });
  await approveSourceRebindRelease({
    db: db as CunoteDb,
    manifest: secondManifest,
    approvedBy: "source-rebind-approver-2",
    approvalArtifactSha256: "5".repeat(64),
  });
  const secondResult = await executeApprovedGrantSupply({
    db: db as CunoteDb,
    grantId,
    expectedEvidenceSha256: secondBefore.evidenceSha256,
    approvedRelease: {
      releaseId: secondManifest.releaseId,
      manifestSha256: secondManifest.manifestSha256,
      executedBy: "source-rebind-executor-2",
    },
    asOf,
  });
  assert.equal(secondResult.status, "completed");
  assert.equal((await loadSnapshot()).readiness.category, "A");
  const [secondAnswer] = await input.admin<{
    answer: { values: string[] };
    evaluation: string;
    source_revision_sha256: string;
    source_raw_sha256: string;
    answer_revision: number;
  }[]>`select answer,evaluation,source_revision_sha256,source_raw_sha256,answer_revision
      from company_grant_confirmations
      where company_id=${input.companyId} and question_id=${questionId}`;
  assert.deepEqual(secondAnswer?.answer, { values: ["yes"] });
  assert.equal(secondAnswer?.evaluation, "satisfied");
  assert.equal(secondAnswer?.source_revision_sha256, secondSource.sourceRevisionSha256);
  assert.equal(secondAnswer?.source_raw_sha256, secondRawSha256);
  assert.equal(secondAnswer?.answer_revision, 3);
  const preservedFirstReplay = await applySourceRebindRelease({
    db: db as CunoteDb,
    manifest: releaseManifest,
    executedBy: "source-rebind-executor",
  });
  assert.equal(preservedFirstReplay.replayed, true);
  await assert.rejects(
    assertNoAppliedSourceRebindForParent(db, releaseManifest.parent.promotionItemId),
    /source_rebind_applied/,
    "승인된 successor가 있으면 원 promotion rollback을 막는다",
  );
  const coverageRawSha256 = "6".repeat(64);
  const coverageImpact: GrantSourceChangeImpact = {
    schema: "grant-source-change-impact-v2",
    classification: "coverage_review_required",
    changedDomains: ["raw", "coverage"],
    previousRawSha256: secondRawSha256,
    currentRawSha256: coverageRawSha256,
    requiresModelRun: false,
  };
  await input.admin`update grant_raw set payload='{"viewCount":3,"exclusion":"new"}'::jsonb,
    raw_hash=${coverageRawSha256},collected_at=now()
    where source='bizinfo' and source_id=${sourceId}`;
  await input.admin`insert into grant_collection_events
    (source,source_id,raw_hash,revision_kind,change_impact)
    values ('bizinfo',${sourceId},${coverageRawSha256},'changed',
      ${JSON.stringify(coverageImpact)}::jsonb)`;
  const coverageSnapshot = await loadCurrentGrantSupplySnapshot({ db, grantId, asOf });
  assert.equal(coverageSnapshot?.nextWork.action, "coverage_review");
  const coverageDeep = await loadVerifiedDeepSources(grantId, db);
  assert.deepEqual(coverageDeep.sources, []);
  assert.equal(coverageDeep.provenance.status, "current_state_drift");
  await input.admin`update grants set status='closed' where id=${grantId}`;
  assert.equal(await loadCurrentGrantSupplySnapshot({ db, grantId, asOf }), null,
    "모집 종료 뒤에는 기존 A 준비도를 현행 지원 가능으로 제공하지 않는다");
  const [inactive] = await assessPublishedGrantSupply({ db, grantIds: [grantId], asOf });
  assert.equal(inactive?.schema, "grant-supply-inactive-v1");
  const [closedAnswer] = await input.admin<{
    answer: { values: string[] };
    answer_revision: number;
  }[]>`select answer,answer_revision from company_grant_confirmations
    where company_id=${input.companyId} and question_id=${questionId}`;
  assert.deepEqual(closedAnswer?.answer, { values: ["yes"] });
  assert.equal(closedAnswer?.answer_revision, 3);
  console.log("PASS: repeated evidence-only source rebind preserves the answer and advances isolated readiness D to A");
}
